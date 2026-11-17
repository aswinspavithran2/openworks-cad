// Assembly mate solver (iterative, geometric) + helpers
import type { AssemblyDoc, Mate, MateRef, Transform, Vec3, BuildResult, MateType } from "../types";
import { add, sub, mul, dot, cross, norm, len, qMul, qFromTo, qRotate, qFromAxisAngle, type Quat } from "../math";

export function explodeOffset(asm: AssemblyDoc, compId: string): Vec3 {
  if (!asm.exploded) return [0, 0, 0];
  let o: Vec3 = [0, 0, 0];
  for (const st of asm.explode) if (st.comps.includes(compId)) o = add(o, mul(norm(st.dir), st.dist));
  return o;
}
export function compWorld(asm: AssemblyDoc, compId: string): Transform {
  const c = asm.components.find(x => x.id === compId)!; const off = explodeOffset(asm, compId);
  return { p: add(c.t.p, off), q: c.t.q };
}

type Geo = { kind: "plane"; p: Vec3; n: Vec3 } | { kind: "axis"; p: Vec3; d: Vec3; r: number } | { kind: "point"; p: Vec3 } | { kind: "line"; p: Vec3; d: Vec3 };

export function localGeo(b: BuildResult | undefined, ref: MateRef): Geo | null {
  const m = b?.main; if (!m) return null;
  if (ref.kind === "face") {
    const f = m.faces[ref.face]; if (!f) return null;
    if (f.type === "PLANE" && f.normal) return { kind: "plane", p: f.center, n: norm(f.normal) };
    if (f.axis) return { kind: "axis", p: f.axis.o, d: norm(f.axis.d), r: f.axis.r };
    if (f.normal) return { kind: "plane", p: f.center, n: norm(f.normal) };
    return { kind: "point", p: f.center };
  }
  if (ref.kind === "edge") {
    const e = m.edges[ref.face]; if (!e) return null;
    if (e.circle) return { kind: "axis", p: e.circle.c, d: norm(e.circle.n), r: e.circle.r };
    if (e.a && e.b && e.type === "LINE") return { kind: "line", p: e.a, d: norm(sub(e.b, e.a)) };
    return { kind: "point", p: e.mid };
  }
  return null;
}
const toWorldGeo = (g: Geo, t: Transform): Geo => {
  const P = (v: Vec3) => add(qRotate(t.q as Quat, v), t.p), D = (v: Vec3) => qRotate(t.q as Quat, v);
  switch (g.kind) { case "plane": return { kind: "plane", p: P(g.p), n: D(g.n) }; case "axis": return { kind: "axis", p: P(g.p), d: D(g.d), r: g.r }; case "line": return { kind: "line", p: P(g.p), d: D(g.d) }; default: return { kind: "point", p: P(g.p) }; }
};

export function allowedMates(a: Geo | null, b: Geo | null): MateType[] {
  if (!a || !b) return ["coincident", "parallel", "perpendicular", "distance", "angle", "concentric", "tangent", "lock"];
  const k = [a.kind, b.kind].sort().join("-");
  switch (k) {
    case "plane-plane": return ["coincident", "parallel", "perpendicular", "distance", "angle", "lock"];
    case "axis-axis": return ["concentric", "coincident", "parallel", "perpendicular", "distance", "lock"];
    case "axis-plane": return ["tangent", "coincident", "parallel", "perpendicular", "distance", "lock"];
    case "line-line": case "axis-line": return ["coincident", "parallel", "perpendicular", "concentric", "distance", "angle", "lock"];
    case "line-plane": return ["coincident", "parallel", "perpendicular", "distance", "lock"];
    default: return ["coincident", "distance", "lock"];
  }
}

/** rotate component (t) by quaternion r about world pivot */
function rotateAbout(t: Transform, r: Quat, pivot: Vec3): Transform { return { q: norm4(qMul(r, t.q as Quat)), p: add(qRotate(r, sub(t.p, pivot)), pivot) }; }
const norm4 = (q: Quat): Quat => { const l = Math.hypot(...q) || 1; return [q[0] / l, q[1] / l, q[2] / l, q[3] / l]; };
const dirOf = (g: Geo): Vec3 | null => g.kind === "plane" ? g.n : g.kind === "axis" || g.kind === "line" ? g.d : null;

export function solveMates(asm: AssemblyDoc, builds: Record<string, BuildResult | undefined>, iterations = 60): { asm: AssemblyDoc; status: Record<string, "ok" | "warn" | "error">; dof: Record<string, number> } {
  const comps = asm.components.map(c => ({ ...c, t: { p: [...c.t.p] as Vec3, q: [...c.t.q] as Quat } }));
  const byId = Object.fromEntries(comps.map(c => [c.id, c]));
  const mates = asm.mates.filter(m => !m.suppressed && byId[m.a.comp] && byId[m.b.comp]);
  const geo = (ref: MateRef) => { const c = byId[ref.comp]; const g = localGeo(builds[c.partId], ref); return g ? toWorldGeo(g, c.t) : null; };
  const residual = (m: Mate): number => {
    const A = geo(m.a), B = geo(m.b); if (!A || !B) return 0;
    const da = dirOf(A), db = dirOf(B);
    switch (m.type) {
      case "coincident": case "distance": {
        const off = m.type === "distance" ? (m.value || 0) : 0;
        if (A.kind === "plane") { let r = da && db ? 1 - Math.abs(dot(da, db)) : 0; const pB = B.kind === "plane" || B.kind === "point" ? B.p : (B as any).p; r += Math.abs(Math.abs(dot(sub(pB, A.p), A.n)) - off); return r; }
        if (B.kind === "plane") return residual({ ...m, a: m.b, b: m.a });
        if ((A.kind === "axis" || A.kind === "line") && (B.kind === "axis" || B.kind === "line")) { const r = 1 - Math.abs(dot(da!, db!)); const w = sub(B.p, A.p); return r + Math.abs(len(sub(w, mul(da!, dot(w, da!)))) - off); }
        return Math.abs(len(sub(B.p, A.p)) - off);
      }
      case "parallel": return da && db ? 1 - Math.abs(dot(da, db)) : 0;
      case "perpendicular": return da && db ? Math.abs(dot(da, db)) : 0;
      case "angle": return da && db ? Math.abs(Math.acos(Math.max(-1, Math.min(1, Math.abs(dot(da, db))))) - (m.value || 0) * Math.PI / 180) : 0;
      case "concentric": { if (!da || !db) return 0; const w = sub(B.p, A.p); return 1 - Math.abs(dot(da, db)) + len(sub(w, mul(da, dot(w, da)))); }
      case "tangent": { const pl = A.kind === "plane" ? A : B.kind === "plane" ? B : null; const ax = A.kind === "axis" ? A : B.kind === "axis" ? B : null; if (!pl || !ax || pl.kind !== "plane" || ax.kind !== "axis") return 0; return Math.abs(dot(ax.d, pl.n)) + Math.abs(Math.abs(dot(sub(ax.p, pl.p), pl.n)) - ax.r); }
      case "lock": return 0;
    }
    return 0;
  };
  const step = (m: Mate) => {
    const ca = byId[m.a.comp], cb = byId[m.b.comp];
    let mover = cb, fixedRef = m.a, moveRef = m.b;
    if (cb.fixed && !ca.fixed) { mover = ca; fixedRef = m.b; moveRef = m.a; }
    if (mover.fixed) return;
    if (m.type === "lock") { const rel = (m as any).rel as Transform | undefined; if (!rel) return; const base = byId[fixedRef.comp]; const q = qMul(base.t.q as Quat, rel.q as Quat); const p = add(qRotate(base.t.q as Quat, rel.p), base.t.p); if (mover === cb) mover.t = { p, q }; return; }
    let A = geo(fixedRef)!, B = geo(moveRef)!; if (!A || !B) return;
    // allow plane on either side
    const da = dirOf(A), db = dirOf(B);
    const rot = (from: Vec3, to: Vec3, pivot: Vec3) => { const r = qFromTo(from, to); mover.t = rotateAbout(mover.t, r, pivot); };
    const flip = m.flip ? -1 : 1;
    switch (m.type) {
      case "coincident": case "distance": {
        const off = m.type === "distance" ? (m.value || 0) : 0;
        if (A.kind === "plane" && B.kind === "plane") {
          const target = mul(A.n, -flip); rot(B.n, target, B.p); B = geo(moveRef)!;
          const s = m.type === "distance" ? (dot(sub(B.p, A.p), A.n) >= 0 ? 1 : -1) : 0;
          const d = dot(sub((B as any).p, A.p), A.n) - s * off; mover.t.p = sub(mover.t.p, mul(A.n, d));
        } else if (A.kind === "plane") {
          if (B.kind === "axis" || B.kind === "line") { const pr = sub(B.d, mul(A.n, dot(B.d, A.n))); if (len(pr) > 1e-9) rot(B.d, norm(pr), B.p); }
          const g2 = geo(moveRef) as any; const dd = dot(sub(g2.p, A.p), A.n); const d = dd - Math.sign(dd || 1) * off; mover.t.p = sub(mover.t.p, mul(A.n, d));
        } else if (B.kind === "plane") {
          if (A.kind === "axis" || A.kind === "line") { const pr = sub(B.n, mul(A.d, dot(B.n, A.d))); if (len(pr) > 1e-9) rot(B.n, norm(pr), B.p); }
          const g2 = geo(moveRef) as any; const dd = dot(sub((A as any).p, g2.p), g2.n); const d = dd - Math.sign(dd || 1) * off; mover.t.p = add(mover.t.p, mul(g2.n, d));
        } else if ((A.kind === "axis" || A.kind === "line") && (B.kind === "axis" || B.kind === "line")) {
          const target = dot(da!, db!) * flip >= 0 ? da! : mul(da!, -1); rot(db!, target, B.p); B = geo(moveRef)!;
          const w = sub(B.p, A.p); const perp = sub(w, mul(da!, dot(w, da!))); const L = len(perp);
          const want = off; const corr = L > 1e-12 ? mul(perp, (L - want) / L) : [0, 0, 0] as Vec3; mover.t.p = sub(mover.t.p, corr);
        } else { const w = sub(B.p, A.p); const L = len(w); const corr = L > 1e-12 ? mul(w, (L - off) / L) : w; mover.t.p = sub(mover.t.p, corr); }
        break;
      }
      case "parallel": if (da && db) rot(db, dot(da, db) >= 0 ? da : mul(da, -1), (B as any).p); break;
      case "perpendicular": if (da && db) { let pr = sub(db, mul(da, dot(db, da))); if (len(pr) < 1e-6) pr = cross(da, Math.abs(da[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]); rot(db, norm(pr), (B as any).p); } break;
      case "angle": if (da && db) { let w = sub(db, mul(da, dot(db, da))); if (len(w) < 1e-6) w = cross(da, Math.abs(da[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]); w = norm(w); const th = (m.value || 0) * Math.PI / 180; const sgn = dot(db, da) >= 0 ? 1 : -1; const target = add(mul(da, Math.cos(th) * sgn), mul(w, Math.sin(th))); rot(db, norm(target), (B as any).p); } break;
      case "concentric": {
        if (!da || !db) break; const target = dot(da, db) * flip >= 0 ? da : mul(da, -1); rot(db, target, (B as any).p); B = geo(moveRef)!;
        const w = sub((B as any).p, (A as any).p); const perp = sub(w, mul(da, dot(w, da))); mover.t.p = sub(mover.t.p, perp); break;
      }
      case "tangent": {
        const pl = (A.kind === "plane" ? A : B) as any, ax = (A.kind === "axis" ? A : B) as any; if (pl.kind !== "plane" || ax.kind !== "axis") break;
        if (ax === B) { const proj = sub(ax.d, mul(pl.n, dot(ax.d, pl.n))); if (len(proj) > 1e-9) rot(ax.d, norm(proj), ax.p); }
        const g2 = geo(moveRef)! as any; const axN = (ax === B ? g2 : geo(fixedRef)) as any; const plN = (pl === A ? A : geo(moveRef)) as any;
        const d = dot(sub(axN.p, plN.p), plN.n); const s = Math.sign(d || 1); const corr = d - s * axN.r;
        mover.t.p = sub(mover.t.p, mul(plN.n, ax === B ? corr : -corr)); break;
      }
    }
  };
  for (let it = 0; it < iterations; it++) { let tot = 0; for (const m of mates) { step(m); } for (const m of mates) tot += residual(m); if (tot < 1e-7) break; }
  const status: Record<string, "ok" | "warn" | "error"> = {};
  for (const m of mates) status[m.id] = residual(m) < 1e-4 ? "ok" : "error";
  // DOF estimate
  const remove: Record<MateType, number> = { coincident: 3, distance: 3, concentric: 4, parallel: 2, perpendicular: 1, angle: 1, tangent: 1, lock: 6 };
  const dof: Record<string, number> = {};
  for (const c of comps) { if (c.fixed) { dof[c.id] = 0; continue; } let r = 0; for (const m of mates) if (m.a.comp === c.id || m.b.comp === c.id) r += remove[m.type]; dof[c.id] = Math.max(0, 6 - r); }
  return { asm: { ...asm, components: comps, mates: asm.mates.map(m => ({ ...m, status: status[m.id] ?? m.status })) }, status, dof };
}

export function relTransform(a: Transform, b: Transform): Transform {
  // rel such that b = a * rel
  const qa = a.q as Quat; const inv: Quat = [-qa[0], -qa[1], -qa[2], qa[3]];
  return { q: qMul(inv, b.q as Quat), p: qRotate(inv, sub(b.p, a.p)) };
}
export { qFromAxisAngle };
