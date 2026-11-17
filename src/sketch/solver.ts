// Numeric geometric constraint solver (minimum-norm Gauss–Newton / Levenberg–Marquardt)
import type { Sketch, SkEntity, Constraint } from "../types";

export interface SolveResult {
  ok: boolean;
  sketch: Sketch;
  dof: number;
  status: "under" | "full" | "over";
  determined: Set<string>;   // point ids / entity ids fully defined
  bad: Set<string>;          // conflicting / redundant constraint ids
}

const wrapPi = (a: number) => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };

export function solveSketch(input: Sketch, opts: { drag?: Record<string, [number, number]>; analyze?: boolean } = {}): SolveResult {
  const sk: Sketch = { ...input, points: {}, entities: input.entities.map(e => ({ ...e })) as SkEntity[] };
  for (const k in input.points) sk.points[k] = { ...input.points[k] };
  const drag = opts.drag || {};
  for (const k in drag) if (sk.points[k]) { sk.points[k].x = drag[k][0]; sk.points[k].y = drag[k][1]; }

  // ── variable indexing
  const used = new Set<string>();
  const ents: Record<string, SkEntity> = {};
  for (const e of sk.entities) {
    ents[e.id] = e;
    if (e.type === "line" || e.type === "arc") { used.add(e.p1); used.add(e.p2); }
    if (e.type === "arc" || e.type === "circle" || e.type === "ellipse") used.add(e.c);
    if (e.type === "spline") e.pts.forEach(p => used.add(p));
    if (e.type === "point") used.add(e.p);
  }
  for (const c of sk.constraints) for (const r of c.refs) if (sk.points[r]) used.add(r);
  const vi: Record<string, number> = {};
  const vars: number[] = [];
  const varOwner: string[] = [];
  for (const id of used) {
    const p = sk.points[id]; if (!p) continue;
    if (p.fixed || id === "O" || drag[id]) continue;
    vi[id] = vars.length; vars.push(p.x, p.y); varOwner.push(id, id);
  }
  const ri: Record<string, number> = {};
  for (const e of sk.entities) if (e.type === "circle") { ri[e.id] = vars.length; vars.push(e.r); varOwner.push(e.id); }

  const P = (x: number[], id: string): [number, number] => {
    const i = vi[id]; if (i !== undefined) return [x[i], x[i + 1]];
    const p = sk.points[id]; return p ? [p.x, p.y] : [0, 0];
  };
  const center = (x: number[], e: SkEntity) => P(x, (e as any).c);
  const radius = (x: number[], e: SkEntity): number => {
    if (e.type === "circle") return ri[e.id] !== undefined ? x[ri[e.id]] : e.r;
    if (e.type === "arc") { const c = P(x, e.c), a = P(x, e.p1); return Math.hypot(a[0] - c[0], a[1] - c[1]); }
    return 0;
  };
  const lineOf = (x: number[], id: string) => { const e = ents[id] as any; return [P(x, e.p1), P(x, e.p2)] as [[number, number], [number, number]]; };
  const isLine = (id: string) => ents[id]?.type === "line";
  const isCirc = (id: string) => ents[id]?.type === "circle" || ents[id]?.type === "arc";

  // ── residual builders: each returns list of fns
  type RF = (x: number[]) => number;
  const rows: { f: RF; cid: string }[] = [];
  const add = (cid: string, f: RF) => rows.push({ f, cid });
  for (const e of sk.entities) if (e.type === "arc") add("__arc" + e.id, x => { const c = P(x, e.c), a = P(x, e.p1), b = P(x, e.p2); return Math.hypot(a[0] - c[0], a[1] - c[1]) - Math.hypot(b[0] - c[0], b[1] - c[1]); });

  const pointOnLine = (cid: string, p: string, l: string) => add(cid, x => { const [a, b] = lineOf(x, l), q = P(x, p); const dx = b[0] - a[0], dy = b[1] - a[1]; const L = Math.hypot(dx, dy) || 1; return (dx * (q[1] - a[1]) - dy * (q[0] - a[0])) / L; });
  const pointOnCirc = (cid: string, p: string, c: string) => add(cid, x => { const e = ents[c]; const cc = center(x, e), q = P(x, p); return Math.hypot(q[0] - cc[0], q[1] - cc[1]) - radius(x, e); });
  const lenOf = (x: number[], id: string) => { const [a, b] = lineOf(x, id); return Math.hypot(b[0] - a[0], b[1] - a[1]); };

  for (const c of sk.constraints) {
    const [r0, r1, r2] = c.refs; const id = c.id;
    switch (c.type) {
      case "horizontal": if (isLine(r0)) add(id, x => { const [a, b] = lineOf(x, r0); return a[1] - b[1]; }); else add(id, x => P(x, r0)[1] - P(x, r1)[1]); break;
      case "vertical": if (isLine(r0)) add(id, x => { const [a, b] = lineOf(x, r0); return a[0] - b[0]; }); else add(id, x => P(x, r0)[0] - P(x, r1)[0]); break;
      case "hpoints": add(id, x => P(x, r0)[1] - P(x, r1)[1]); break;
      case "vpoints": add(id, x => P(x, r0)[0] - P(x, r1)[0]); break;
      case "coincident":
        if (sk.points[r0] && sk.points[r1]) { add(id, x => P(x, r0)[0] - P(x, r1)[0]); add(id, x => P(x, r0)[1] - P(x, r1)[1]); }
        else { const p = sk.points[r0] ? r0 : r1, e = sk.points[r0] ? r1 : r0; if (isLine(e)) pointOnLine(id, p, e); else if (isCirc(e)) pointOnCirc(id, p, e); }
        break;
      case "pointOnLine": pointOnLine(id, r0, r1); break;
      case "pointOnCircle": pointOnCirc(id, r0, r1); break;
      case "parallel": add(id, x => { const [a, b] = lineOf(x, r0), [p, q] = lineOf(x, r1); const u = [b[0] - a[0], b[1] - a[1]], v = [q[0] - p[0], q[1] - p[1]]; return (u[0] * v[1] - u[1] * v[0]) / ((Math.hypot(u[0], u[1]) * Math.hypot(v[0], v[1])) || 1); }); break;
      case "perpendicular": add(id, x => { const [a, b] = lineOf(x, r0), [p, q] = lineOf(x, r1); const u = [b[0] - a[0], b[1] - a[1]], v = [q[0] - p[0], q[1] - p[1]]; return (u[0] * v[0] + u[1] * v[1]) / ((Math.hypot(u[0], u[1]) * Math.hypot(v[0], v[1])) || 1); }); break;
      case "collinear": pointOnLine(id, (ents[r1] as any).p1, r0); pointOnLine(id, (ents[r1] as any).p2, r0); break;
      case "equal":
        if (isLine(r0) && isLine(r1)) add(id, x => lenOf(x, r0) - lenOf(x, r1));
        else if (isCirc(r0) && isCirc(r1)) add(id, x => radius(x, ents[r0]) - radius(x, ents[r1]));
        break;
      case "concentric": add(id, x => center(x, ents[r0])[0] - center(x, ents[r1])[0]); add(id, x => center(x, ents[r0])[1] - center(x, ents[r1])[1]); break;
      case "coradial": add(id, x => center(x, ents[r0])[0] - center(x, ents[r1])[0]); add(id, x => center(x, ents[r0])[1] - center(x, ents[r1])[1]); add(id, x => radius(x, ents[r0]) - radius(x, ents[r1])); break;
      case "tangent": {
        if (isLine(r0) || isLine(r1)) {
          const l = isLine(r0) ? r0 : r1, ci = isLine(r0) ? r1 : r0;
          add(id, x => { const [a, b] = lineOf(x, l); const cc = center(x, ents[ci]); const dx = b[0] - a[0], dy = b[1] - a[1]; const L = Math.hypot(dx, dy) || 1; return Math.abs((dx * (cc[1] - a[1]) - dy * (cc[0] - a[0])) / L) - radius(x, ents[ci]); });
        } else {
          const s = c.sign ?? 1;
          add(id, x => { const a = center(x, ents[r0]), b = center(x, ents[r1]); const d = Math.hypot(a[0] - b[0], a[1] - b[1]); const ra = radius(x, ents[r0]), rb = radius(x, ents[r1]); return s > 0 ? d - (ra + rb) : d - Math.abs(ra - rb); });
        }
        break;
      }
      case "midpoint": add(id, x => { const [a, b] = lineOf(x, r1), p = P(x, r0); return p[0] - (a[0] + b[0]) / 2; }); add(id, x => { const [a, b] = lineOf(x, r1), p = P(x, r0); return p[1] - (a[1] + b[1]) / 2; }); break;
      case "symmetric": {
        // r0, r1 points (or lines → their endpoints), r2 centerline
        const pairs: [string, string][] = [];
        if (sk.points[r0]) pairs.push([r0, r1]);
        else { const A = ents[r0] as any, B = ents[r1] as any; if (A?.p1 && B?.p1) { pairs.push([A.p1, B.p1], [A.p2, B.p2]); } else if (A?.c && B?.c) pairs.push([A.c, B.c]); }
        for (const [p, q] of pairs) {
          add(id, x => { const [a, b] = lineOf(x, r2), u = P(x, p), v = P(x, q); const m = [(u[0] + v[0]) / 2, (u[1] + v[1]) / 2]; const dx = b[0] - a[0], dy = b[1] - a[1]; const L = Math.hypot(dx, dy) || 1; return (dx * (m[1] - a[1]) - dy * (m[0] - a[0])) / L; });
          add(id, x => { const [a, b] = lineOf(x, r2), u = P(x, p), v = P(x, q); const dx = b[0] - a[0], dy = b[1] - a[1]; const L = Math.hypot(dx, dy) || 1; return ((v[0] - u[0]) * dx + (v[1] - u[1]) * dy) / L; });
        }
        break;
      }
      case "fix": {
        const e = ents[r0];
        const pts = sk.points[r0] ? [r0] : e?.type === "line" || e?.type === "arc" ? [(e as any).p1, (e as any).p2, ...(e.type === "arc" ? [e.c] : [])] : e && (e as any).c ? [(e as any).c] : [];
        const anchor = (c as any).anchor as Record<string, [number, number]> | undefined;
        for (const p of pts) { const a = anchor?.[p] ?? [sk.points[p].x, sk.points[p].y]; add(id, x => P(x, p)[0] - a[0]); add(id, x => P(x, p)[1] - a[1]); }
        if (e?.type === "circle") { const rv = (c as any).r ?? e.r; add(id, x => radius(x, e) - rv); }
        break;
      }
      // ── dimensions
      case "distance":
        if (r1 === undefined && isLine(r0)) add(id, x => lenOf(x, r0) - (c.value ?? 0));
        else add(id, x => { const a = P(x, r0), b = P(x, r1); return Math.hypot(a[0] - b[0], a[1] - b[1]) - (c.value ?? 0); });
        break;
      case "hdistance": { const s = c.sign ?? 1; if (r1 === undefined) add(id, x => { const [a, b] = lineOf(x, r0); return (b[0] - a[0]) * s - (c.value ?? 0); }); else add(id, x => (P(x, r1)[0] - P(x, r0)[0]) * s - (c.value ?? 0)); break; }
      case "vdistance": { const s = c.sign ?? 1; if (r1 === undefined) add(id, x => { const [a, b] = lineOf(x, r0); return (b[1] - a[1]) * s - (c.value ?? 0); }); else add(id, x => (P(x, r1)[1] - P(x, r0)[1]) * s - (c.value ?? 0)); break; }
      case "pointLineDistance": add(id, x => { const [a, b] = lineOf(x, r1), q = P(x, r0); const dx = b[0] - a[0], dy = b[1] - a[1]; const L = Math.hypot(dx, dy) || 1; return Math.abs((dx * (q[1] - a[1]) - dy * (q[0] - a[0])) / L) - (c.value ?? 0); }); break;
      case "lineLineDistance": add(id, x => { const [a, b] = lineOf(x, r0), q = lineOf(x, r1)[0]; const dx = b[0] - a[0], dy = b[1] - a[1]; const L = Math.hypot(dx, dy) || 1; return Math.abs((dx * (q[1] - a[1]) - dy * (q[0] - a[0])) / L) - (c.value ?? 0); }); break;
      case "radius": add(id, x => radius(x, ents[r0]) - (c.value ?? 0)); break;
      case "diameter": add(id, x => 2 * radius(x, ents[r0]) - (c.value ?? 0)); break;
      case "angle": {
        const s = c.sign ?? 1;
        add(id, x => { const [a, b] = lineOf(x, r0), [p, q] = lineOf(x, r1); const u = [b[0] - a[0], b[1] - a[1]], v = [q[0] - p[0], q[1] - p[1]]; const ang = Math.atan2(u[0] * v[1] - u[1] * v[0], u[0] * v[0] + u[1] * v[1]); return wrapPi(ang - s * (c.value ?? 0) * Math.PI / 180); });
        break;
      }
    }
  }

  const n = vars.length, m = rows.length;
  const evalR = (x: number[]) => rows.map(r => r.f(x));
  const jac = (x: number[], r: number[]) => {
    const J: number[][] = Array.from({ length: m }, () => new Array(n).fill(0));
    for (let j = 0; j < n; j++) {
      const h = 1e-7 * Math.max(1, Math.abs(x[j])); const old = x[j]; x[j] = old + h;
      for (let i = 0; i < m; i++) { const v = rows[i].f(x); J[i][j] = (v - r[i]) / h; }
      x[j] = old;
    }
    return J;
  };
  const maxAbs = (r: number[]) => r.reduce((a, b) => Math.max(a, Math.abs(b)), 0);

  let x = vars.slice();
  let r = evalR(x);
  let ok = maxAbs(r) < 1e-7;
  if (!ok && n > 0) {
    let lambda = 1e-6;
    for (let it = 0; it < 120; it++) {
      const J = jac(x, r);
      // min-norm step: dx = -Jᵀ (J Jᵀ + λI)⁻¹ r
      const A: number[][] = Array.from({ length: m }, () => new Array(m).fill(0));
      for (let i = 0; i < m; i++) for (let k = i; k < m; k++) { let s = 0; const Ji = J[i], Jk = J[k]; for (let j = 0; j < n; j++) s += Ji[j] * Jk[j]; A[i][k] = s; A[k][i] = s; }
      for (let i = 0; i < m; i++) A[i][i] += lambda * (1 + A[i][i]);
      const y = gaussSolve(A, r.slice());
      if (!y) { lambda *= 10; continue; }
      const dx = new Array(n).fill(0);
      for (let j = 0; j < n; j++) { let s = 0; for (let i = 0; i < m; i++) s += J[i][j] * y[i]; dx[j] = -s; }
      // step limiting
      let step = 1; const cur = norm2(r);
      let accepted = false;
      for (let ls = 0; ls < 8; ls++) {
        const xn = x.map((v, j) => v + dx[j] * step); const rn = evalR(xn);
        if (norm2(rn) < cur || ls === 7) { x = xn; r = rn; accepted = norm2(rn) < cur; break; }
        step *= 0.5;
      }
      lambda = accepted ? Math.max(1e-12, lambda / 10) : Math.min(1e3, lambda * 10);
      if (maxAbs(r) < 1e-9) { ok = true; break; }
    }
    ok = ok || maxAbs(r) < 1e-6;
  }
  if (n === 0) ok = maxAbs(r) < 1e-6;

  // write back
  for (const id in vi) { const i = vi[id]; sk.points[id].x = x[i]; sk.points[id].y = x[i + 1]; }
  for (const e of sk.entities) if (e.type === "circle" && ri[e.id] !== undefined) (e as any).r = Math.abs(x[ri[e.id]]);

  // ── DOF analysis
  const determined = new Set<string>();
  const bad = new Set<string>();
  let rank = 0; let dof = n;
  if (opts.analyze !== false) {
    const J = m > 0 && n > 0 ? jac(x, r) : [];
    // Ordered row reduction (RREF built row by row): internal rows, then relations, then dimensions.
    // A row that reduces to zero is linearly dependent on earlier ones. Dependent *relations* are merely
    // redundant (tools such as slots/parallelograms emit consistent extras) and are not conflicts;
    // a dependent *dimension* over-defines the sketch and is flagged. Unsatisfied rows are caught below.
    const cons = new Map(sk.constraints.map(c => [c.id, c] as const));
    const isDim = (cid: string) => { const c: any = cons.get(cid); return !!c && typeof c.value === "number"; };
    const prio = (i: number) => rows[i].cid.startsWith("__") ? 0 : isDim(rows[i].cid) ? 2 : 1;
    const order = Array.from({ length: m }, (_, i) => i).sort((a, b) => prio(a) - prio(b) || a - b);
    const basis: { row: number[]; piv: number }[] = [];
    const tolRow = 1e-7;
    for (const i of order) {
      const v = J[i].slice(); let scaleRow = 0; for (const q of v) scaleRow = Math.max(scaleRow, Math.abs(q));
      if (scaleRow === 0) { if (!rows[i].cid.startsWith("__") && isDim(rows[i].cid)) bad.add(rows[i].cid); continue; }
      for (const bsc of basis) { const f = v[bsc.piv]; if (f !== 0) for (let j = 0; j < n; j++) v[j] -= f * bsc.row[j]; }
      let piv = -1, pv = 0; for (let j = 0; j < n; j++) if (Math.abs(v[j]) > pv) { pv = Math.abs(v[j]); piv = j; }
      if (pv <= tolRow * Math.max(1, scaleRow)) { if (!rows[i].cid.startsWith("__") && isDim(rows[i].cid)) bad.add(rows[i].cid); continue; }
      const d = v[piv]; for (let j = 0; j < n; j++) v[j] /= d;
      for (const bsc of basis) { const f = bsc.row[piv]; if (f !== 0) for (let j = 0; j < n; j++) bsc.row[j] -= f * v[j]; }
      basis.push({ row: v, piv });
    }
    const pivCols = basis.map(b0 => b0.piv);
    rank = pivCols.length; dof = n - rank;
    if (!ok) r.forEach((v, i) => { if (Math.abs(v) > 1e-6) bad.add(rows[i].cid); });
    // null space → determined vars
    const isPiv = new Array(n).fill(-1); pivCols.forEach((c, k) => isPiv[c] = k);
    const free: number[] = []; for (let j = 0; j < n; j++) if (isPiv[j] < 0) free.push(j);
    const varFree = new Array(n).fill(false);
    for (const f of free) {
      varFree[f] = true;
      for (let k = 0; k < basis.length; k++) { if (Math.abs(basis[k].row[f]) > 1e-7) varFree[basis[k].piv] = true; }
    }
    const freeOwner = new Set<string>(); for (let j = 0; j < n; j++) if (varFree[j]) freeOwner.add(varOwner[j]);
    for (const id of Object.keys(sk.points)) if (!freeOwner.has(id)) determined.add(id);
    for (const e of sk.entities) {
      const pts = e.type === "line" ? [e.p1, e.p2] : e.type === "arc" ? [e.c, e.p1, e.p2] : e.type === "circle" ? [e.c] : e.type === "ellipse" ? [e.c] : e.type === "spline" ? e.pts : [e.p];
      if (pts.every(p => determined.has(p)) && !freeOwner.has(e.id) && e.type !== "ellipse" && e.type !== "spline") determined.add(e.id);
    }
  }
  const status = !ok || bad.size > 0 ? "over" : dof === 0 ? "full" : "under";
  return { ok, sketch: sk, dof, status, determined, bad };
}

const norm2 = (r: number[]) => r.reduce((a, b) => a + b * b, 0);

function gaussSolve(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  for (let c = 0; c < n; c++) {
    let p = c; for (let i = c + 1; i < n; i++) if (Math.abs(A[i][c]) > Math.abs(A[p][c])) p = i;
    if (Math.abs(A[p][c]) < 1e-14) return null;
    [A[c], A[p]] = [A[p], A[c]]; [b[c], b[p]] = [b[p], b[c]];
    for (let i = c + 1; i < n; i++) { const f = A[i][c] / A[c][c]; if (f === 0) continue; for (let j = c; j < n; j++) A[i][j] -= f * A[c][j]; b[i] -= f * b[c]; }
  }
  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) { let s = b[i]; for (let j = i + 1; j < n; j++) s -= A[i][j] * x[j]; x[i] = s / A[i][i]; }
  return x;
}

/** measure the current value a dimension constraint would have */
export function measureDim(sk: Sketch, c: Constraint): number {
  const pt = (id: string) => sk.points[id];
  const ent = (id: string) => sk.entities.find(e => e.id === id) as any;
  const [r0, r1] = c.refs;
  const lineV = (id: string) => { const e = ent(id); const a = pt(e.p1), b = pt(e.p2); return [a, b]; };
  const rad = (e: any) => e.type === "circle" ? e.r : Math.hypot(pt(e.p1).x - pt(e.c).x, pt(e.p1).y - pt(e.c).y);
  switch (c.type) {
    case "distance": if (r1 === undefined) { const [a, b] = lineV(r0); return Math.hypot(b.x - a.x, b.y - a.y); } return Math.hypot(pt(r0).x - pt(r1).x, pt(r0).y - pt(r1).y);
    case "hdistance": if (r1 === undefined) { const [a, b] = lineV(r0); return Math.abs(b.x - a.x); } return Math.abs(pt(r1).x - pt(r0).x);
    case "vdistance": if (r1 === undefined) { const [a, b] = lineV(r0); return Math.abs(b.y - a.y); } return Math.abs(pt(r1).y - pt(r0).y);
    case "pointLineDistance": { const [a, b] = lineV(r1); const q = pt(r0); const dx = b.x - a.x, dy = b.y - a.y; return Math.abs((dx * (q.y - a.y) - dy * (q.x - a.x)) / (Math.hypot(dx, dy) || 1)); }
    case "lineLineDistance": { const [a, b] = lineV(r0); const q = lineV(r1)[0]; const dx = b.x - a.x, dy = b.y - a.y; return Math.abs((dx * (q.y - a.y) - dy * (q.x - a.x)) / (Math.hypot(dx, dy) || 1)); }
    case "radius": return rad(ent(r0));
    case "diameter": return 2 * rad(ent(r0));
    case "angle": { const [a, b] = lineV(r0), [p, q] = lineV(r1); const u = [b.x - a.x, b.y - a.y], v = [q.x - p.x, q.y - p.y]; return Math.abs(Math.atan2(u[0] * v[1] - u[1] * v[0], u[0] * v[0] + u[1] * v[1])) * 180 / Math.PI; }
  }
  return 0;
}
export const DIM_TYPES = new Set(["distance", "hdistance", "vdistance", "pointLineDistance", "lineLineDistance", "radius", "diameter", "angle"]);
