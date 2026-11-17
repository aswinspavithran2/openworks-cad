// 2D sketch geometry: sampling, profile/loop detection, intersections, trim/extend/offset
import type { Sketch, SkEntity, Vec2, Constraint } from "../types";
import { uid } from "../math";

export type Seg =
  | { t: "line"; a: Vec2; b: Vec2 }
  | { t: "arc"; c: Vec2; r: number; a: Vec2; b: Vec2; m: Vec2 }
  | { t: "circle"; c: Vec2; r: number }
  | { t: "ellipse"; c: Vec2; a: number; b: number; rot: number }
  | { t: "spline"; pts: Vec2[] };
export interface Loop { segs: Seg[]; poly: Vec2[]; area: number; entityIds: string[] }
export interface Profile { outer: Loop; holes: Loop[] }

const P = (sk: Sketch, id: string): Vec2 => { const p = sk.points[id]; return p ? [p.x, p.y] : [0, 0]; };
const TAU = Math.PI * 2;
export const arcAngles = (sk: Sketch, e: { c: string; p1: string; p2: string }) => {
  const c = P(sk, e.c), a = P(sk, e.p1), b = P(sk, e.p2);
  const a1 = Math.atan2(a[1] - c[1], a[0] - c[0]); let a2 = Math.atan2(b[1] - c[1], b[0] - c[0]);
  let sw = a2 - a1; while (sw <= 1e-9) sw += TAU; while (sw > TAU + 1e-9) sw -= TAU;
  return { c, r: Math.hypot(a[0] - c[0], a[1] - c[1]), a1, sw };
};

export function catmull(pts: Vec2[], per = 12): Vec2[] {
  if (pts.length < 3) return pts.slice();
  const out: Vec2[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)];
    for (let k = 0; k < per; k++) {
      const t = k / per, t2 = t * t, t3 = t2 * t;
      out.push([0.5 * ((2 * p1[0]) + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
        0.5 * ((2 * p1[1]) + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3)]);
    }
  }
  out.push(pts[pts.length - 1]);
  return out;
}

export function sampleEntity(sk: Sketch, e: SkEntity, n = 64): Vec2[] {
  switch (e.type) {
    case "line": return [P(sk, e.p1), P(sk, e.p2)];
    case "circle": { const c = P(sk, e.c); return Array.from({ length: n + 1 }, (_, i) => [c[0] + e.r * Math.cos(i / n * TAU), c[1] + e.r * Math.sin(i / n * TAU)] as Vec2); }
    case "arc": { const { c, r, a1, sw } = arcAngles(sk, e); const k = Math.max(4, Math.ceil(n * sw / TAU)); return Array.from({ length: k + 1 }, (_, i) => [c[0] + r * Math.cos(a1 + sw * i / k), c[1] + r * Math.sin(a1 + sw * i / k)] as Vec2); }
    case "ellipse": { const c = P(sk, e.c), cr = Math.cos(e.rot), sr = Math.sin(e.rot); return Array.from({ length: n + 1 }, (_, i) => { const t = i / n * TAU, x = e.a * Math.cos(t), y = e.b * Math.sin(t); return [c[0] + x * cr - y * sr, c[1] + x * sr + y * cr] as Vec2; }); }
    case "spline": return catmull(e.pts.map(p => P(sk, p)));
    case "point": return [P(sk, e.p)];
  }
}

export function segOf(sk: Sketch, e: SkEntity, forward = true): Seg {
  switch (e.type) {
    case "line": return forward ? { t: "line", a: P(sk, e.p1), b: P(sk, e.p2) } : { t: "line", a: P(sk, e.p2), b: P(sk, e.p1) };
    case "arc": { const { c, r, a1, sw } = arcAngles(sk, e); const m: Vec2 = [c[0] + r * Math.cos(a1 + sw / 2), c[1] + r * Math.sin(a1 + sw / 2)]; const a = P(sk, e.p1), b = P(sk, e.p2); return forward ? { t: "arc", c, r, a, b, m } : { t: "arc", c, r, a: b, b: a, m }; }
    case "circle": return { t: "circle", c: P(sk, e.c), r: e.r };
    case "ellipse": return { t: "ellipse", c: P(sk, e.c), a: e.a, b: e.b, rot: e.rot };
    case "spline": { const pts = e.pts.map(p => P(sk, p)); return { t: "spline", pts: forward ? pts : pts.reverse() }; }
    default: return { t: "line", a: [0, 0], b: [0, 0] };
  }
}
const segPoly = (s: Seg, n = 48): Vec2[] => {
  switch (s.t) {
    case "line": return [s.a, s.b];
    case "arc": { const a1 = Math.atan2(s.a[1] - s.c[1], s.a[0] - s.c[0]), a2 = Math.atan2(s.b[1] - s.c[1], s.b[0] - s.c[0]), am = Math.atan2(s.m[1] - s.c[1], s.m[0] - s.c[0]);
      let sw = a2 - a1; let mm = am - a1; const nrm = (v: number) => { while (v < 0) v += TAU; while (v >= TAU) v -= TAU; return v; }; sw = nrm(sw); mm = nrm(mm); if (sw < 1e-9) sw = TAU; if (mm > sw) sw = sw - TAU; // CW
      const k = Math.max(4, Math.ceil(n * Math.abs(sw) / TAU)); return Array.from({ length: k + 1 }, (_, i) => [s.c[0] + s.r * Math.cos(a1 + sw * i / k), s.c[1] + s.r * Math.sin(a1 + sw * i / k)] as Vec2); }
    case "circle": return Array.from({ length: n + 1 }, (_, i) => [s.c[0] + s.r * Math.cos(i / n * TAU), s.c[1] + s.r * Math.sin(i / n * TAU)] as Vec2);
    case "ellipse": { const cr = Math.cos(s.rot), sr = Math.sin(s.rot); return Array.from({ length: n + 1 }, (_, i) => { const t = i / n * TAU, x = s.a * Math.cos(t), y = s.b * Math.sin(t); return [s.c[0] + x * cr - y * sr, s.c[1] + x * sr + y * cr] as Vec2; }); }
    case "spline": return catmull(s.pts);
  }
};
export const polyArea = (p: Vec2[]) => { let a = 0; for (let i = 0; i < p.length; i++) { const q = p[i], r = p[(i + 1) % p.length]; a += q[0] * r[1] - r[0] * q[1]; } return a / 2; };
export function pointInPoly(pt: Vec2, poly: Vec2[]) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < (xj - xi) * (pt[1] - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Find all closed regions (minimal faces) + standalone closed curves */
export function findLoops(sk: Sketch): { loops: Loop[]; openEnds: Vec2[] } {
  const ents = sk.entities.filter(e => !e.construction && e.type !== "point");
  const loops: Loop[] = [];
  // node merging by location
  const nodeOf: Record<string, string> = {};
  const keys: { id: string; p: Vec2 }[] = [];
  const node = (pid: string) => {
    if (nodeOf[pid]) return nodeOf[pid];
    const p = P(sk, pid); const f = keys.find(k => Math.hypot(k.p[0] - p[0], k.p[1] - p[1]) < 1e-6);
    if (f) return (nodeOf[pid] = f.id);
    keys.push({ id: pid, p }); return (nodeOf[pid] = pid);
  };
  type E = { e: SkEntity; u: string; v: string };
  let edges: E[] = [];
  for (const e of ents) {
    if (e.type === "circle" || e.type === "ellipse") { const s = segOf(sk, e); const poly = segPoly(s); loops.push({ segs: [s], poly, area: Math.abs(polyArea(poly)), entityIds: [e.id] }); continue; }
    if (e.type === "line" || e.type === "arc") edges.push({ e, u: node(e.p1), v: node(e.p2) });
    if (e.type === "spline") { const u = node(e.pts[0]), v = node(e.pts[e.pts.length - 1]); if (u === v) { const s = segOf(sk, e); const poly = segPoly(s); loops.push({ segs: [s], poly, area: Math.abs(polyArea(poly)), entityIds: [e.id] }); } else edges.push({ e, u, v }); }
  }
  // prune degree-1 nodes
  const openEnds: Vec2[] = [];
  for (let changed = true; changed;) {
    changed = false; const deg: Record<string, number> = {};
    for (const ed of edges) { deg[ed.u] = (deg[ed.u] || 0) + 1; deg[ed.v] = (deg[ed.v] || 0) + 1; }
    const keep = edges.filter(ed => { const bad = deg[ed.u] === 1 || deg[ed.v] === 1; if (bad) { if (deg[ed.u] === 1) openEnds.push(P(sk, ed.u)); if (deg[ed.v] === 1) openEnds.push(P(sk, ed.v)); } return !bad; });
    if (keep.length !== edges.length) { edges = keep; changed = true; }
  }
  // half-edges
  type H = { ei: number; from: string; to: string; fwd: boolean; ang: number; used?: boolean };
  const hs: H[] = []; const out: Record<string, H[]> = {};
  edges.forEach((ed, ei) => {
    const s = segOf(sk, ed.e, true); const poly = segPoly(s, 64);
    const dirAng = (pts: Vec2[]) => { const a = pts[0]; const b = pts[Math.min(pts.length - 1, Math.max(1, Math.floor(pts.length / 16)))]; return Math.atan2(b[1] - a[1], b[0] - a[0]); };
    const h1: H = { ei, from: ed.u, to: ed.v, fwd: true, ang: dirAng(poly) };
    const h2: H = { ei, from: ed.v, to: ed.u, fwd: false, ang: dirAng(poly.slice().reverse()) };
    hs.push(h1, h2); (out[ed.u] ||= []).push(h1); (out[ed.v] ||= []).push(h2);
  });
  for (const k in out) out[k].sort((a, b) => a.ang - b.ang);
  const twin = (h: H) => out[h.to].find(x => x.ei === h.ei && x.fwd !== h.fwd && x.from === h.to)!;
  for (const h0 of hs) {
    if (h0.used) continue;
    const cyc: H[] = []; let h = h0; let guard = 0;
    while (!h.used && guard++ < 10000) {
      h.used = true; cyc.push(h);
      const t = twin(h); const list = out[h.to]; const i = list.indexOf(t);
      h = list[(i - 1 + list.length) % list.length]; // first clockwise from twin
    }
    if (h !== h0) continue;
    const segs = cyc.map(c => segOf(sk, edges[c.ei].e, c.fwd));
    const poly: Vec2[] = []; segs.forEach(s => { const pp = segPoly(s); poly.push(...pp.slice(0, -1)); });
    const area = polyArea(poly);
    if (area > 1e-9) loops.push({ segs, poly, area, entityIds: cyc.map(c => edges[c.ei].e.id) });
  }
  return { loops, openEnds };
}

function interiorPoint(l: Loop): Vec2 {
  const s = l.segs[0];
  if (l.segs.length === 1 && (s.t === "circle" || s.t === "ellipse")) return s.c;
  const poly = l.poly; let best = 0, bl = -1;
  for (let i = 0; i < poly.length; i++) { const a = poly[i], b = poly[(i + 1) % poly.length]; const L = Math.hypot(b[0] - a[0], b[1] - a[1]); if (L > bl) { bl = L; best = i; } }
  const a = poly[best], b = poly[(best + 1) % poly.length]; const sgn = polyArea(poly) > 0 ? 1 : -1;
  const eps = Math.max(1e-4, Math.sqrt(Math.abs(l.area)) * 1e-3);
  const nx = -(b[1] - a[1]) / bl * sgn, ny = (b[0] - a[0]) / bl * sgn;
  return [(a[0] + b[0]) / 2 + nx * eps, (a[1] + b[1]) / 2 + ny * eps];
}

export function findProfiles(sk: Sketch, selected?: number[]): { profiles: Profile[]; loops: Loop[]; openEnds: Vec2[] } {
  const { loops, openEnds } = findLoops(sk);
  const ip = loops.map(interiorPoint);
  const depth = loops.map((l, i) => loops.filter((o, j) => j !== i && Math.abs(o.area) > Math.abs(l.area) && pointInPoly(ip[i], o.poly)).length);
  const profiles: Profile[] = [];
  loops.forEach((l, i) => {
    if (selected && selected.length && !selected.includes(i)) return;
    if (!selected?.length && depth[i] % 2 === 1) return;
    const holes = loops.filter((o, j) => j !== i && depth[j] === depth[i] + 1 && pointInPoly(ip[j], l.poly) && Math.abs(o.area) < Math.abs(l.area));
    profiles.push({ outer: l, holes });
  });
  return { profiles, loops, openEnds };
}

/** ordered open chain (for sweep paths) */
export function findChain(sk: Sketch): Seg[] {
  const ents = sk.entities.filter(e => !e.construction && (e.type === "line" || e.type === "arc" || e.type === "spline"));
  if (!ents.length) { const c = sk.entities.find(e => !e.construction && (e.type === "circle" || e.type === "ellipse")); return c ? [segOf(sk, c)] : []; }
  const ends = (e: SkEntity): [string, string] => e.type === "spline" ? [e.pts[0], e.pts[e.pts.length - 1]] : [(e as any).p1, (e as any).p2];
  const deg: Record<string, number> = {}; ents.forEach(e => ends(e).forEach(p => deg[p] = (deg[p] || 0) + 1));
  let start = ends(ents[0])[0]; for (const k in deg) if (deg[k] === 1) { start = k; break; }
  const used = new Set<string>(); const segs: Seg[] = []; let cur = start;
  for (let i = 0; i < ents.length; i++) {
    const e = ents.find(x => !used.has(x.id) && ends(x).includes(cur)); if (!e) break;
    used.add(e.id); const [a, b] = ends(e); const fwd = a === cur; segs.push(segOf(sk, e, fwd)); cur = fwd ? b : a;
  }
  return segs;
}

// ───────── picking helpers
export function distToSeg(p: Vec2, a: Vec2, b: Vec2) {
  const dx = b[0] - a[0], dy = b[1] - a[1]; const L = dx * dx + dy * dy;
  const t = L ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}
export function distToEntity(sk: Sketch, e: SkEntity, p: Vec2): number {
  if (e.type === "circle") { const c = P(sk, e.c); return Math.abs(Math.hypot(p[0] - c[0], p[1] - c[1]) - e.r); }
  if (e.type === "point") return Math.hypot(p[0] - sk.points[e.p].x, p[1] - sk.points[e.p].y);
  const poly = sampleEntity(sk, e); let d = Infinity;
  for (let i = 0; i < poly.length - 1; i++) d = Math.min(d, distToSeg(p, poly[i], poly[i + 1]));
  return d;
}
export function closestOnEntity(sk: Sketch, e: SkEntity, p: Vec2): Vec2 {
  if (e.type === "line") { const a = P(sk, e.p1), b = P(sk, e.p2); const dx = b[0] - a[0], dy = b[1] - a[1]; const L = dx * dx + dy * dy || 1; const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L)); return [a[0] + t * dx, a[1] + t * dy]; }
  if (e.type === "circle" || e.type === "arc") { const c = P(sk, e.c); const r = e.type === "circle" ? e.r : arcAngles(sk, e).r; const a = Math.atan2(p[1] - c[1], p[0] - c[0]); return [c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)]; }
  const poly = sampleEntity(sk, e); let best = poly[0], bd = Infinity;
  for (const q of poly) { const d = Math.hypot(q[0] - p[0], q[1] - p[1]); if (d < bd) { bd = d; best = q; } }
  return best;
}

// ───────── intersections (as world points)
type Prim = { k: "seg"; a: Vec2; b: Vec2 } | { k: "circ"; c: Vec2; r: number; a1?: number; sw?: number } | { k: "poly"; pts: Vec2[] };
function primOf(sk: Sketch, e: SkEntity): Prim | null {
  if (e.type === "line") return { k: "seg", a: P(sk, e.p1), b: P(sk, e.p2) };
  if (e.type === "circle") return { k: "circ", c: P(sk, e.c), r: e.r };
  if (e.type === "arc") { const { c, r, a1, sw } = arcAngles(sk, e); return { k: "circ", c, r, a1, sw }; }
  if (e.type === "point") return null;
  return { k: "poly", pts: sampleEntity(sk, e, 96) };
}
const onArc = (p: Prim & { k: "circ" }, pt: Vec2) => { if (p.a1 === undefined) return true; let a = Math.atan2(pt[1] - p.c[1], pt[0] - p.c[0]) - p.a1; while (a < -1e-9) a += TAU; while (a >= TAU) a -= TAU; return a <= p.sw! + 1e-9; };
function segSeg(a: Vec2, b: Vec2, c: Vec2, d: Vec2, infA = false): Vec2[] {
  const r = [b[0] - a[0], b[1] - a[1]], s = [d[0] - c[0], d[1] - c[1]]; const den = r[0] * s[1] - r[1] * s[0];
  if (Math.abs(den) < 1e-12) return [];
  const t = ((c[0] - a[0]) * s[1] - (c[1] - a[1]) * s[0]) / den, u = ((c[0] - a[0]) * r[1] - (c[1] - a[1]) * r[0]) / den;
  if ((infA || (t >= -1e-9 && t <= 1 + 1e-9)) && u >= -1e-9 && u <= 1 + 1e-9) return [[a[0] + t * r[0], a[1] + t * r[1]]];
  return [];
}
function segCirc(a: Vec2, b: Vec2, c: Vec2, r: number, infA = false): Vec2[] {
  const d = [b[0] - a[0], b[1] - a[1]], f = [a[0] - c[0], a[1] - c[1]];
  const A = d[0] * d[0] + d[1] * d[1], B = 2 * (f[0] * d[0] + f[1] * d[1]), C = f[0] * f[0] + f[1] * f[1] - r * r;
  let disc = B * B - 4 * A * C; if (disc < -1e-9 || A === 0) return []; disc = Math.sqrt(Math.max(0, disc));
  const out: Vec2[] = [];
  for (const t of [(-B - disc) / (2 * A), (-B + disc) / (2 * A)]) if (infA || (t >= -1e-9 && t <= 1 + 1e-9)) out.push([a[0] + t * d[0], a[1] + t * d[1]]);
  return out;
}
function circCirc(c1: Vec2, r1: number, c2: Vec2, r2: number): Vec2[] {
  const d = Math.hypot(c2[0] - c1[0], c2[1] - c1[1]); if (d < 1e-12 || d > r1 + r2 + 1e-9 || d < Math.abs(r1 - r2) - 1e-9) return [];
  const a = (r1 * r1 - r2 * r2 + d * d) / (2 * d); const h = Math.sqrt(Math.max(0, r1 * r1 - a * a));
  const mx = c1[0] + a * (c2[0] - c1[0]) / d, my = c1[1] + a * (c2[1] - c1[1]) / d;
  return [[mx + h * (c2[1] - c1[1]) / d, my - h * (c2[0] - c1[0]) / d], [mx - h * (c2[1] - c1[1]) / d, my + h * (c2[0] - c1[0]) / d]];
}
export function intersect(sk: Sketch, e1: SkEntity, e2: SkEntity, infFirst = false): Vec2[] {
  const p = primOf(sk, e1), q = primOf(sk, e2); if (!p || !q) return [];
  const segsOf = (x: Prim): [Vec2, Vec2][] => x.k === "seg" ? [[x.a, x.b]] : x.k === "poly" ? x.pts.slice(0, -1).map((v, i) => [v, x.pts[i + 1]] as [Vec2, Vec2]) : [];
  let res: Vec2[] = [];
  if (p.k === "circ" && q.k === "circ") res = circCirc(p.c, p.r, q.c, q.r).filter(v => onArc(p, v) && onArc(q, v));
  else if (p.k === "circ" || q.k === "circ") {
    const ci = (p.k === "circ" ? p : q) as Prim & { k: "circ" }; const o = p.k === "circ" ? q : p;
    for (const [a, b] of segsOf(o)) res.push(...segCirc(a, b, ci.c, ci.r, infFirst && o === p).filter(v => onArc(ci, v)));
  } else for (const [a, b] of segsOf(p)) for (const [c, d] of segsOf(q)) res.push(...segSeg(a, b, c, d, infFirst && p.k === "seg"));
  return res;
}

// ───────── Trim
function paramOn(sk: Sketch, e: SkEntity, pt: Vec2): number {
  if (e.type === "line") { const a = P(sk, e.p1), b = P(sk, e.p2); const dx = b[0] - a[0], dy = b[1] - a[1]; return ((pt[0] - a[0]) * dx + (pt[1] - a[1]) * dy) / (dx * dx + dy * dy || 1); }
  if (e.type === "circle") { const c = P(sk, e.c); let a = Math.atan2(pt[1] - c[1], pt[0] - c[0]); if (a < 0) a += TAU; return a; }
  if (e.type === "arc") { const { c, a1 } = arcAngles(sk, e); let a = Math.atan2(pt[1] - c[1], pt[0] - c[0]) - a1; while (a < 0) a += TAU; while (a >= TAU) a -= TAU; return a; }
  return 0;
}

const reassign = (cs: Constraint[], from: string, to: string) => cs.map(c => c.refs.includes(from) ? { ...c, refs: c.refs.map(r => r === from ? to : r) } : c);

export function trimEntity(sk0: Sketch, eid: string, click: Vec2): Sketch | null {
  const sk: Sketch = { ...sk0, points: { ...sk0.points }, entities: sk0.entities.slice(), constraints: sk0.constraints.slice() };
  const e = sk.entities.find(x => x.id === eid); if (!e) return null;
  const hits: { t: number; p: Vec2; by: string }[] = [];
  for (const o of sk.entities) { if (o.id === eid || o.type === "point") continue; for (const p of intersect(sk, e, o)) hits.push({ t: paramOn(sk, e, p), p, by: o.id }); }
  const removeEntity = () => { sk.entities = sk.entities.filter(x => x.id !== eid); sk.constraints = sk.constraints.filter(c => !c.refs.includes(eid)); return sk; };
  const newPt = (p: Vec2, by: string) => {
    const id = uid("p"); sk.points[id] = { id, x: p[0], y: p[1] };
    const o = sk.entities.find(x => x.id === by);
    if (o?.type === "line") sk.constraints.push({ id: uid("c"), type: "pointOnLine", refs: [id, by] });
    else if (o?.type === "circle" || o?.type === "arc") sk.constraints.push({ id: uid("c"), type: "pointOnCircle", refs: [id, by] });
    return id;
  };
  const ct = paramOn(sk, e, click);
  if (e.type === "line") {
    const ts = hits.filter(h => h.t > 1e-6 && h.t < 1 - 1e-6).sort((a, b) => a.t - b.t);
    if (!ts.length) return removeEntity();
    const before = ts.filter(h => h.t < ct).pop(), after = ts.find(h => h.t > ct);
    const idx = sk.entities.indexOf(e);
    // drop endpoint-specific constraints on trimmed side
    if (!before) { const np = newPt(after!.p, after!.by); sk.constraints = sk.constraints.filter(c => !(c.refs.includes(e.p1) && c.type !== "coincident" && c.refs.length <= 2 && c.refs.includes(eid))); sk.entities[idx] = { ...e, p1: np }; }
    else if (!after) { const np = newPt(before.p, before.by); sk.entities[idx] = { ...e, p2: np }; }
    else { const a = newPt(before.p, before.by), b = newPt(after.p, after.by); sk.entities[idx] = { ...e, p2: a }; sk.entities.push({ id: uid("e"), type: "line", p1: b, p2: e.p2, construction: e.construction }); sk.constraints = sk.constraints.filter(c => !(c.refs.includes(eid) && ["distance", "hdistance", "vdistance", "equal"].includes(c.type))); }
    return sk;
  }
  if (e.type === "circle") {
    const ts = hits.sort((a, b) => a.t - b.t);
    if (ts.length < 2) return removeEntity();
    let i = ts.findIndex(h => h.t > ct); if (i < 0) i = 0;
    const end = ts[i], start = ts[(i - 1 + ts.length) % ts.length]; // clicked portion: start→end CCW; keep end→start
    const p1 = newPt(end.p, end.by), p2 = newPt(start.p, start.by);
    const idx = sk.entities.indexOf(e);
    sk.entities[idx] = { id: e.id, type: "arc", c: e.c, p1, p2, construction: e.construction };
    return sk;
  }
  if (e.type === "arc") {
    const { sw } = arcAngles(sk, e);
    const ts = hits.filter(h => h.t > 1e-6 && h.t < sw - 1e-6).sort((a, b) => a.t - b.t);
    if (!ts.length) return removeEntity();
    const before = ts.filter(h => h.t < ct).pop(), after = ts.find(h => h.t > ct);
    const idx = sk.entities.indexOf(e);
    if (!before) sk.entities[idx] = { ...e, p1: newPt(after!.p, after!.by) };
    else if (!after) sk.entities[idx] = { ...e, p2: newPt(before.p, before.by) };
    else { const a = newPt(before.p, before.by), b = newPt(after.p, after.by); sk.entities[idx] = { ...e, p2: a }; sk.entities.push({ id: uid("e"), type: "arc", c: e.c, p1: b, p2: e.p2, construction: e.construction }); }
    return sk;
  }
  return removeEntity();
}

export function extendEntity(sk0: Sketch, eid: string, click: Vec2): Sketch | null {
  const e = sk0.entities.find(x => x.id === eid); if (!e || e.type !== "line") return null;
  const a = P(sk0, e.p1), b = P(sk0, e.p2);
  const nearP2 = Math.hypot(click[0] - b[0], click[1] - b[1]) < Math.hypot(click[0] - a[0], click[1] - a[1]);
  let best: Vec2 | null = null, bt = Infinity;
  for (const o of sk0.entities) {
    if (o.id === eid || o.type === "point") continue;
    for (const p of intersect(sk0, e, o, true)) {
      const t = paramOn(sk0, e, p);
      if (nearP2 && t > 1 + 1e-6 && t < bt) { bt = t; best = p; }
      if (!nearP2 && t < -1e-6 && -t < bt) { bt = -t; best = p; }
    }
  }
  if (!best) return null;
  const sk: Sketch = { ...sk0, points: { ...sk0.points }, entities: sk0.entities.slice() };
  const id = uid("p"); sk.points[id] = { id, x: best[0], y: best[1] };
  const idx = sk.entities.indexOf(e); sk.entities[idx] = nearP2 ? { ...e, p2: id } : { ...e, p1: id };
  return sk;
}

/** Offset a set of entities (connected chain or single). Returns new sketch. */
export function offsetEntities(sk0: Sketch, ids: string[], d: number, construction = false): Sketch {
  const sk: Sketch = { ...sk0, points: { ...sk0.points }, entities: sk0.entities.slice(), constraints: sk0.constraints.slice() };
  const sel = sk0.entities.filter(e => ids.includes(e.id));
  const np = (p: Vec2) => { const id = uid("p"); sk.points[id] = { id, x: p[0], y: p[1] }; return id; };
  // map: original point id -> list of new offset positions (to merge at joints)
  const joint: Record<string, Vec2[]> = {};
  type OL = { e: SkEntity; pa?: Vec2; pb?: Vec2; la?: [Vec2, Vec2] };
  const offs: OL[] = [];
  for (const e of sel) {
    if (e.type === "circle") { sk.entities.push({ id: uid("e"), type: "circle", c: e.c, r: Math.max(0.001, e.r + d), construction }); continue; }
    if (e.type === "line") {
      const a = P(sk, e.p1), b = P(sk, e.p2); const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1; const n: Vec2 = [-(b[1] - a[1]) / L * d, (b[0] - a[0]) / L * d];
      offs.push({ e, pa: [a[0] + n[0], a[1] + n[1]], pb: [b[0] + n[0], b[1] + n[1]] });
    }
    if (e.type === "arc") {
      const { c, r, a1, sw } = arcAngles(sk, e); const rr = Math.max(0.001, r - d); // left side of CCW arc is inward
      offs.push({ e, pa: [c[0] + rr * Math.cos(a1), c[1] + rr * Math.sin(a1)], pb: [c[0] + rr * Math.cos(a1 + sw), c[1] + rr * Math.sin(a1 + sw)] });
    }
  }
  // joints: for lines sharing points, intersect offset lines
  for (const o of offs) { const e = o.e as any; (joint[e.p1] ||= []).push(o.pa!); (joint[e.p2] ||= []).push(o.pb!); }
  const lineAt = (o: OL) => [o.pa!, o.pb!] as [Vec2, Vec2];
  const jointPos: Record<string, Vec2> = {};
  for (const pid in joint) {
    const users = offs.filter(o => (o.e as any).p1 === pid || (o.e as any).p2 === pid);
    if (users.length === 2 && users[0].e.type === "line" && users[1].e.type === "line") {
      const [a, b] = lineAt(users[0]), [c, dd] = lineAt(users[1]);
      const r = [b[0] - a[0], b[1] - a[1]], s = [dd[0] - c[0], dd[1] - c[1]]; const den = r[0] * s[1] - r[1] * s[0];
      if (Math.abs(den) > 1e-9) { const t = ((c[0] - a[0]) * s[1] - (c[1] - a[1]) * s[0]) / den; jointPos[pid] = [a[0] + t * r[0], a[1] + t * r[1]]; continue; }
    }
    const ps = joint[pid]; jointPos[pid] = [ps.reduce((s, p) => s + p[0], 0) / ps.length, ps.reduce((s, p) => s + p[1], 0) / ps.length];
  }
  const newIds: Record<string, string> = {};
  const pidFor = (pid: string, pos: Vec2) => { if (joint[pid].length > 1) return (newIds[pid] ||= np(jointPos[pid])); return np(pos); };
  for (const o of offs) {
    const e = o.e as any;
    if (e.type === "line") sk.entities.push({ id: uid("e"), type: "line", p1: pidFor(e.p1, o.pa!), p2: pidFor(e.p2, o.pb!), construction });
    else sk.entities.push({ id: uid("e"), type: "arc", c: e.c, p1: pidFor(e.p1, o.pa!), p2: pidFor(e.p2, o.pb!), construction });
  }
  return sk;
}

/** select connected chain from an entity */
export function chainFrom(sk: Sketch, eid: string): string[] {
  const ends = (e: SkEntity): string[] => e.type === "line" || e.type === "arc" ? [e.p1, e.p2] : e.type === "spline" ? [e.pts[0], e.pts[e.pts.length - 1]] : [];
  const res = new Set([eid]); let frontier = [eid];
  while (frontier.length) {
    const nf: string[] = [];
    for (const id of frontier) { const e = sk.entities.find(x => x.id === id)!; for (const p of ends(e)) for (const o of sk.entities) if (!res.has(o.id) && ends(o).includes(p)) { res.add(o.id); nf.push(o.id); } }
    frontier = nf;
  }
  return [...res];
}
