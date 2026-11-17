// Sketch tool state machine: drawing tools, inferencing, smart dimension, trim, drag
import type { Sketch, SkEntity, Vec2, Constraint, ConstraintType } from "../types";
import { useApp, selKey, type Sel } from "../store";
import { uid } from "../math";
import { distToEntity, closestOnEntity, trimEntity, extendEntity, sampleEntity, arcAngles, intersect } from "./geom";
import { measureDim, DIM_TYPES } from "./solver";

export interface SnapInfo { p: Vec2; ptId?: string; onEnt?: string; midOf?: string; kind?: string; h?: boolean; v?: boolean; infer: Vec2[][] }
export interface Overlay {
  lines: Vec2[][]; dashed: Vec2[][]; pts: Vec2[];
  snap?: SnapInfo | null;
  dimPreview?: Constraint | null;
  label?: { at: Vec2; text: string } | null;
  typed?: { fields: string[]; values: string[]; active: number; at: Vec2 } | null;
  box?: [number, number, number, number] | null; // screen box select
}

const st = () => useApp.getState();
const clone = (sk: Sketch): Sketch => ({ ...sk, points: { ...sk.points }, entities: sk.entities.slice(), constraints: sk.constraints.slice() });
const P = (sk: Sketch, id: string): Vec2 => [sk.points[id].x, sk.points[id].y];
const sub2 = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]];
const len2 = (a: Vec2) => Math.hypot(a[0], a[1]);

export function usedPoints(sk: Sketch) {
  const s = new Set<string>(["O"]);
  for (const e of sk.entities) { if (e.type === "line" || e.type === "arc") { s.add(e.p1); s.add(e.p2); } if (e.type === "arc" || e.type === "circle" || e.type === "ellipse") s.add(e.c); if (e.type === "spline") e.pts.forEach(p => s.add(p)); if (e.type === "point") s.add(e.p); }
  return s;
}
export function hitSketch(sk: Sketch, p: Vec2, tol: number): { kind: "pt" | "ent"; id: string } | null {
  let best: { kind: "pt" | "ent"; id: string } | null = null, bd = tol;
  for (const id of usedPoints(sk)) { const q = sk.points[id]; if (!q) continue; const d = Math.hypot(q.x - p[0], q.y - p[1]); if (d < bd) { bd = d; best = { kind: "pt", id }; } }
  if (best) return best;
  bd = tol;
  for (const e of sk.entities) { if (e.type === "point") continue; const d = distToEntity(sk, e, p); if (d < bd) { bd = d; best = { kind: "ent", id: e.id }; } }
  return best;
}

export class SketchTool {
  pts: SnapInfo[] = [];         // collected clicks
  cur: SnapInfo | null = null;  // current snapped cursor
  chainStart: string | null = null; // point id to continue line chains
  dimPicks: { kind: "pt" | "ent"; id: string }[] = [];
  drag: { ids: string[]; start: Vec2; orig: Record<string, Vec2>; circle?: string; moved: boolean } | null = null;
  boxStart: [number, number] | null = null; boxCur: [number, number] | null = null;
  trimming = false; lastTrim: Vec2 | null = null;
  typed: { fields: string[]; values: string[]; active: number } | null = null;
  tol = 1;
  version = 0;

  reset() { this.pts = []; this.chainStart = null; this.dimPicks = []; this.typed = null; this.drag = null; this.boxStart = null; this.trimming = false; this.version++; }
  get ss() { return st().sketch!; }
  get tool() { return this.ss.tool; }
  get mode() { return this.ss.mode; }

  snap(raw: Vec2, anchor?: Vec2 | null, exclude: string[] = []): SnapInfo {
    const sk = this.ss.sk; const tol = this.tol; const opts = st().options; const infer: Vec2[][] = [];
    // points
    if (opts.snapPoints) {
      let best: string | null = null, bd = tol;
      for (const id of usedPoints(sk)) { if (exclude.includes(id)) continue; const q = sk.points[id]; if (!q) continue; const d = Math.hypot(q.x - raw[0], q.y - raw[1]); if (d < bd) { bd = d; best = id; } }
      if (best) { const q = sk.points[best]; return { p: [q.x, q.y], ptId: best, kind: best === "O" ? "origin" : "point", infer }; }
      // midpoints
      for (const e of sk.entities) if (e.type === "line") { const a = P(sk, e.p1), b = P(sk, e.p2); const m: Vec2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]; if (Math.hypot(m[0] - raw[0], m[1] - raw[1]) < tol) return { p: m, midOf: e.id, kind: "mid", infer }; }
      // intersections of entities
      for (let i = 0; i < sk.entities.length; i++) for (let j = i + 1; j < sk.entities.length; j++) for (const x of intersect(sk, sk.entities[i], sk.entities[j])) if (Math.hypot(x[0] - raw[0], x[1] - raw[1]) < tol) return { p: x, kind: "intersection", infer };
    }
    let p: Vec2 = raw.slice() as Vec2; let h = false, v = false;
    if (anchor) {
      if (Math.abs(p[1] - anchor[1]) < tol * 0.8 && Math.abs(p[0] - anchor[0]) > tol) { p[1] = anchor[1]; h = true; infer.push([anchor, [p[0], p[1]]]); }
      else if (Math.abs(p[0] - anchor[0]) < tol * 0.8 && Math.abs(p[1] - anchor[1]) > tol) { p[0] = anchor[0]; v = true; infer.push([anchor, [p[0], p[1]]]); }
    }
    // alignment with other points (dashed inference lines)
    if (!h && !v && opts.snapPoints) for (const id of usedPoints(sk)) { const q = sk.points[id]; if (!q || exclude.includes(id)) continue; if (Math.abs(q.y - p[1]) < tol * 0.5 && Math.abs(q.x - p[0]) > tol) { p[1] = q.y; infer.push([[q.x, q.y], [p[0], p[1]]]); break; } if (Math.abs(q.x - p[0]) < tol * 0.5 && Math.abs(q.y - p[1]) > tol) { p[0] = q.x; infer.push([[q.x, q.y], [p[0], p[1]]]); break; } }
    // on entity
    if (!h && !v) for (const e of sk.entities) { if (e.type === "point") continue; if (distToEntity(sk, e, raw) < tol * 0.7) { return { p: closestOnEntity(sk, e, raw), onEnt: e.id, kind: "edge", infer }; } }
    if (opts.snapGrid && !h && !v) { const g = opts.gridSpacing; p = [Math.round(p[0] / g) * g, Math.round(p[1] / g) * g]; return { p, kind: "grid", infer }; }
    return { p, h, v, kind: h ? "horizontal" : v ? "vertical" : undefined, infer };
  }

  // ───── helpers to build geometry
  private ptFor(sk: Sketch, s: SnapInfo, cons: Constraint[]): string {
    if (s.ptId) return s.ptId;
    const id = uid("p"); sk.points[id] = { id, x: s.p[0], y: s.p[1] };
    const auto = st().options.autoRelations;
    if (auto && s.onEnt) { const e = sk.entities.find(x => x.id === s.onEnt); if (e?.type === "line") cons.push({ id: uid("c"), type: "pointOnLine", refs: [id, e.id] }); else if (e?.type === "circle" || e?.type === "arc") cons.push({ id: uid("c"), type: "pointOnCircle", refs: [id, e.id] }); }
    if (auto && s.midOf) cons.push({ id: uid("c"), type: "midpoint", refs: [id, s.midOf] });
    return id;
  }
  private commit(sk: Sketch, ents: SkEntity[], cons: Constraint[]) {
    sk.entities.push(...ents); sk.constraints.push(...cons);
    st().skSet(sk, { force: true });
    if (st().options.singleCommand) st().setTool("select");
  }
  private constr = () => st().sketch!.toolOpts.construction;

  // ───── main events (sketch coords)
  down(raw: Vec2, ev: { shift: boolean; ctrl: boolean; sx: number; sy: number; dbl?: boolean }) {
    const tool = this.tool; const anchor = this.pts.length ? this.pts[this.pts.length - 1].p : null;
    const s = this.snap(raw, tool === "line" || tool === "centerline" ? anchor : null);
    switch (tool) {
      case "select": return this.selectDown(raw, ev);
      case "dimension": return this.dimClick(raw);
      case "trim": { this.trimming = true; this.lastTrim = raw; this.trimAt(raw); return; }
      case "extend": { const h = hitSketch(this.ss.sk, raw, this.tol); if (h?.kind === "ent") { const r = extendEntity(this.ss.sk, h.id, raw); if (r) st().skSet(r, { force: true }); else st().setStatus("Nothing to extend to"); } return; }
      case "point": { const sk = clone(this.ss.sk); const cons: Constraint[] = []; const id = this.ptFor(sk, s, cons); this.commit(sk, [{ id: uid("e"), type: "point", p: id }], cons); return; }
      case "spline": { if (ev.dbl) return this.finishSpline(); this.pts.push(s); this.version++; return; }
    }
    this.pts.push(s); this.version++;
    this.tryComplete();
  }
  dblclick() { if (this.tool === "spline") this.finishSpline(); else if (this.tool === "line" || this.tool === "centerline") { this.pts = []; this.chainStart = null; this.version++; } }
  finishSpline() {
    if (this.pts.length >= 2) {
      const sk = clone(this.ss.sk); const cons: Constraint[] = [];
      const ids = this.pts.filter((p, i, a) => i === 0 || len2(sub2(p.p, a[i - 1].p)) > 1e-9).map(p => this.ptFor(sk, p, cons));
      this.commit(sk, [{ id: uid("e"), type: "spline", pts: ids, construction: this.constr() }], cons);
    }
    this.pts = []; this.version++;
  }

  tryComplete(typedVals?: number[]) {
    const tool = this.tool, mode = this.mode; const n = this.pts.length;
    const sk = clone(this.ss.sk); const cons: Constraint[] = []; const C = this.constr();
    const auto = st().options.autoRelations;
    const done = () => { this.pts = []; this.typed = null; this.version++; };
    if (tool === "line" || tool === "centerline") {
      if (n < 2) return;
      const a = this.pts[0], b = this.pts[1];
      if (len2(sub2(a.p, b.p)) < 1e-9) { this.pts = [a]; return; }
      const p1 = this.chainStart && !a.ptId ? this.chainStart : this.ptFor(sk, a, cons);
      const p2 = this.ptFor(sk, b, cons);
      const id = uid("e");
      if (auto && b.h) cons.push({ id: uid("c"), type: "horizontal", refs: [id] });
      if (auto && b.v) cons.push({ id: uid("c"), type: "vertical", refs: [id] });
      this.commit(sk, [{ id, type: "line", p1, p2, construction: tool === "centerline" || C }], cons);
      // chain
      const endSnap: SnapInfo = { p: b.p, ptId: p2, infer: [] };
      this.pts = st().options.singleCommand ? [] : [endSnap]; this.chainStart = p2; this.typed = null; this.version++;
      return;
    }
    if (tool === "circle") {
      if (mode === "perimeter") {
        if (n < 3) return; const c = circle3(this.pts[0].p, this.pts[1].p, this.pts[2].p); if (!c) return done();
        const cid = this.ptFor(sk, { p: c.c, infer: [] }, cons); this.commit(sk, [{ id: uid("e"), type: "circle", c: cid, r: c.r, construction: C }], cons); return done();
      }
      if (n < 2) return; const r = typedVals?.[0] ?? len2(sub2(this.pts[1].p, this.pts[0].p)); if (r < 1e-9) return done();
      const c = this.ptFor(sk, this.pts[0], cons); const eid = uid("e");
      if (auto && this.pts[1].ptId) cons.push({ id: uid("c"), type: "pointOnCircle", refs: [this.pts[1].ptId, eid] });
      this.commit(sk, [{ id: eid, type: "circle", c, r, construction: C }], cons); return done();
    }
    if (tool === "rect") {
      const need = mode === "3corner" || mode === "3center" || mode === "parallelogram" ? 3 : 2; if (n < need) return;
      let corners: Vec2[];
      const [a, b] = [this.pts[0].p, this.pts[1].p];
      if (mode === "center") { let dx = b[0] - a[0], dy = b[1] - a[1]; if (typedVals) { dx = typedVals[0] / 2; dy = typedVals[1] / 2; } corners = [[a[0] - dx, a[1] - dy], [a[0] + dx, a[1] - dy], [a[0] + dx, a[1] + dy], [a[0] - dx, a[1] + dy]]; }
      else if (mode === "3corner" || mode === "3center" || mode === "parallelogram") {
        const c = this.pts[2].p;
        if (mode === "parallelogram") corners = [a, b, c, [a[0] + c[0] - b[0], a[1] + c[1] - b[1]]];
        else { const u = sub2(b, a); const L = len2(u) || 1; const nrm: Vec2 = [-u[1] / L, u[0] / L]; const w = (c[0] - b[0]) * nrm[0] + (c[1] - b[1]) * nrm[1];
          if (mode === "3center") { const half: Vec2 = sub2(b, a); corners = [[a[0] - half[0] - nrm[0] * w, a[1] - half[1] - nrm[1] * w], [a[0] + half[0] - nrm[0] * w, a[1] + half[1] - nrm[1] * w], [a[0] + half[0] + nrm[0] * w, a[1] + half[1] + nrm[1] * w], [a[0] - half[0] + nrm[0] * w, a[1] - half[1] + nrm[1] * w]]; }
          else corners = [a, b, [b[0] + nrm[0] * w, b[1] + nrm[1] * w], [a[0] + nrm[0] * w, a[1] + nrm[1] * w]]; }
      } else { let c = b; if (typedVals) c = [a[0] + typedVals[0], a[1] + typedVals[1]]; corners = [a, [c[0], a[1]], c, [a[0], c[1]]]; }
      if (Math.abs(polyA(corners)) < 1e-9) return done();
      const ids = corners.map((p, i) => { if (mode === "corner" || mode === "") { if (i === 0) return this.ptFor(sk, this.pts[0], cons); if (i === 2 && !typedVals) return this.ptFor(sk, this.pts[1], cons); } return this.ptFor(sk, { p, infer: [] }, cons); });
      const ls = ids.map((p, i) => ({ id: uid("e"), type: "line" as const, p1: p, p2: ids[(i + 1) % 4], construction: C }));
      const axisAligned = mode === "corner" || mode === "center" || mode === "";
      if (axisAligned) cons.push({ id: uid("c"), type: "horizontal", refs: [ls[0].id] }, { id: uid("c"), type: "horizontal", refs: [ls[2].id] }, { id: uid("c"), type: "vertical", refs: [ls[1].id] }, { id: uid("c"), type: "vertical", refs: [ls[3].id] });
      else if (mode === "parallelogram") cons.push({ id: uid("c"), type: "parallel", refs: [ls[0].id, ls[2].id] }, { id: uid("c"), type: "parallel", refs: [ls[1].id, ls[3].id] });
      else cons.push({ id: uid("c"), type: "perpendicular", refs: [ls[0].id, ls[1].id] }, { id: uid("c"), type: "parallel", refs: [ls[0].id, ls[2].id] }, { id: uid("c"), type: "parallel", refs: [ls[1].id, ls[3].id] });
      const extra: SkEntity[] = [];
      if (mode === "center" || mode === "3center") {
        const d1 = { id: uid("e"), type: "line" as const, p1: ids[0], p2: ids[2], construction: true }, d2 = { id: uid("e"), type: "line" as const, p1: ids[1], p2: ids[3], construction: true };
        const cp = this.ptFor(sk, this.pts[0], cons);
        extra.push(d1, d2); cons.push({ id: uid("c"), type: "midpoint", refs: [cp, d1.id] }, { id: uid("c"), type: "midpoint", refs: [cp, d2.id] });
        if (!this.pts[0].ptId) extra.push({ id: uid("e"), type: "point", p: cp });
      }
      this.commit(sk, [...ls, ...extra], cons); return done();
    }
    if (tool === "arc") {
      if (mode === "tangent") {
        if (n < 2) return; const s0 = this.pts[0]; if (!s0.ptId) { st().setStatus("Tangent arc must start at an endpoint of a line or arc"); return done(); }
        const host = sk.entities.find(e => (e.type === "line" || e.type === "arc") && (e.p1 === s0.ptId || e.p2 === s0.ptId)) as any; if (!host) return done();
        const tdir = tangentAt(sk, host, s0.ptId!); const e = this.pts[1].p; const s = s0.p;
        const arc = tangentArc(s, tdir, e); if (!arc) return done();
        const c = this.ptFor(sk, { p: arc.c, infer: [] }, cons); const pe = this.ptFor(sk, this.pts[1], cons); const id = uid("e");
        const ent: SkEntity = arc.ccw ? { id, type: "arc", c, p1: s0.ptId!, p2: pe, construction: C } : { id, type: "arc", c, p1: pe, p2: s0.ptId!, construction: C };
        cons.push({ id: uid("c"), type: "tangent", refs: [host.id, id] });
        this.commit(sk, [ent], cons); this.pts = [{ p: e, ptId: pe, infer: [] }]; this.typed = null; this.version++; return;
      }
      if (n < 3) return;
      if (mode === "3point") {
        const [a, b, m] = this.pts.map(p => p.p); const c = circle3(a, m, b); if (!c) return done();
        const ccw = cross2(sub2(m, a), sub2(b, a)) < 0; // m on right side of a→b when CCW from a to b passes m? determine below
        const cid = this.ptFor(sk, { p: c.c, infer: [] }, cons); const pa = this.ptFor(sk, this.pts[0], cons), pb = this.ptFor(sk, this.pts[1], cons);
        // choose orientation such that arc passes through m
        const ent: SkEntity = arcThrough(c.c, a, b, m) ? { id: uid("e"), type: "arc", c: cid, p1: pa, p2: pb, construction: C } : { id: uid("e"), type: "arc", c: cid, p1: pb, p2: pa, construction: C };
        void ccw; this.commit(sk, [ent], cons); return done();
      }
      // center point arc
      const [c, a, e] = this.pts.map(p => p.p); const r = len2(sub2(a, c)); const ang = Math.atan2(e[1] - c[1], e[0] - c[0]); const pe: Vec2 = [c[0] + r * Math.cos(ang), c[1] + r * Math.sin(ang)];
      const cid = this.ptFor(sk, this.pts[0], cons), pa = this.ptFor(sk, this.pts[1], cons), pb = this.ptFor(sk, { p: pe, infer: [] }, cons);
      const ccw = cross2(sub2(a, c), sub2(e, c)) >= 0;
      this.commit(sk, [ccw ? { id: uid("e"), type: "arc", c: cid, p1: pa, p2: pb, construction: C } : { id: uid("e"), type: "arc", c: cid, p1: pb, p2: pa, construction: C }], cons); return done();
    }
    if (tool === "polygon") {
      if (n < 2) return; const o = st().sketch!.toolOpts; const N = Math.max(3, Math.min(40, o.sides | 0));
      const c = this.pts[0].p; let r = typedVals?.[0] ?? len2(sub2(this.pts[1].p, c)); const a0 = Math.atan2(this.pts[1].p[1] - c[1], this.pts[1].p[0] - c[0]);
      if (r < 1e-9) return done();
      const rv = o.inscribed ? r : r / Math.cos(Math.PI / N);
      const cid = this.ptFor(sk, this.pts[0], cons);
      const vs = Array.from({ length: N }, (_, i) => this.ptFor(sk, { p: [c[0] + rv * Math.cos(a0 + i * 2 * Math.PI / N), c[1] + rv * Math.sin(a0 + i * 2 * Math.PI / N)], infer: [] }, cons));
      const ls = vs.map((p, i) => ({ id: uid("e"), type: "line" as const, p1: p, p2: vs[(i + 1) % N], construction: C }));
      const circ = { id: uid("e"), type: "circle" as const, c: cid, r: rv, construction: true };
      for (const v of vs) cons.push({ id: uid("c"), type: "pointOnCircle", refs: [v, circ.id] });
      for (let i = 1; i < N; i++) cons.push({ id: uid("c"), type: "equal", refs: [ls[0].id, ls[i].id] });
      this.commit(sk, [...ls, circ], cons); return done();
    }
    if (tool === "slot") {
      if (n < 3) return;
      let [a, b] = [this.pts[0].p, this.pts[1].p]; const w = this.pts[2].p;
      if (mode === "center") { const d = sub2(b, a); a = [this.pts[0].p[0] - d[0], this.pts[0].p[1] - d[1]]; }
      const u = sub2(b, a); const L = len2(u); if (L < 1e-9) return done(); const nrm: Vec2 = [-u[1] / L, u[0] / L];
      const r = Math.abs((w[0] - b[0]) * nrm[0] + (w[1] - b[1]) * nrm[1]) || L * 0.25;
      const ca = this.ptFor(sk, { p: a, infer: [] }, cons), cb = this.ptFor(sk, { p: b, infer: [] }, cons);
      const P1 = this.ptFor(sk, { p: [a[0] - nrm[0] * r, a[1] - nrm[1] * r], infer: [] }, cons), P2 = this.ptFor(sk, { p: [b[0] - nrm[0] * r, b[1] - nrm[1] * r], infer: [] }, cons);
      const P3 = this.ptFor(sk, { p: [b[0] + nrm[0] * r, b[1] + nrm[1] * r], infer: [] }, cons), P4 = this.ptFor(sk, { p: [a[0] + nrm[0] * r, a[1] + nrm[1] * r], infer: [] }, cons);
      const l1 = { id: uid("e"), type: "line" as const, p1: P1, p2: P2, construction: C }, l2 = { id: uid("e"), type: "line" as const, p1: P3, p2: P4, construction: C };
      const a1 = { id: uid("e"), type: "arc" as const, c: cb, p1: P2, p2: P3, construction: C }, a2 = { id: uid("e"), type: "arc" as const, c: ca, p1: P4, p2: P1, construction: C };
      const cl = { id: uid("e"), type: "line" as const, p1: ca, p2: cb, construction: true };
      cons.push({ id: uid("c"), type: "tangent", refs: [l1.id, a1.id] }, { id: uid("c"), type: "tangent", refs: [l2.id, a1.id] }, { id: uid("c"), type: "tangent", refs: [l1.id, a2.id] }, { id: uid("c"), type: "tangent", refs: [l2.id, a2.id] }, { id: uid("c"), type: "equal", refs: [a1.id, a2.id] });
      this.commit(sk, [l1, a1, l2, a2, cl], cons); return done();
    }
    if (tool === "ellipse") {
      if (n < 3) return; const [c, m, q] = this.pts.map(p => p.p); const a = len2(sub2(m, c)); const rot = Math.atan2(m[1] - c[1], m[0] - c[0]);
      const ux = Math.cos(rot), uy = Math.sin(rot); const b = Math.abs(-(q[0] - c[0]) * uy + (q[1] - c[1]) * ux) || a / 2;
      const cid = this.ptFor(sk, this.pts[0], cons); this.commit(sk, [{ id: uid("e"), type: "ellipse", c: cid, a, b, rot, construction: C }], cons); return done();
    }
  }

  move(raw: Vec2, sx: number, sy: number) {
    const tool = this.tool; const anchor = this.pts.length ? this.pts[this.pts.length - 1].p : null;
    if (tool === "select") {
      if (this.drag) return this.dragMove(raw);
      if (this.boxStart) { this.boxCur = [sx, sy]; this.version++; return; }
    }
    if (tool === "trim" && this.trimming && this.lastTrim) { this.powerTrim(this.lastTrim, raw); this.lastTrim = raw; }
    this.cur = this.snap(raw, (tool === "line" || tool === "centerline") ? anchor : null);
    this.version++;
  }
  up(_raw: Vec2, sx: number, sy: number, ctrl: boolean) {
    if (this.tool === "trim") { this.trimming = false; this.lastTrim = null; }
    if (this.drag) { this.drag = null; this.version++; return; }
    if (this.boxStart) {
      const [x0, y0] = this.boxStart; this.boxStart = null; this.boxCur = null;
      if (Math.hypot(sx - x0, sy - y0) > 4) this.boxSelect?.(x0, y0, sx, sy, ctrl);
      else if (!ctrl) st().select(null);
      this.version++;
    }
  }
  boxSelect?: (x0: number, y0: number, x1: number, y1: number, additive: boolean) => void;
  dimHit?: (raw: Vec2) => string | null; // returns constraint id if click on dim/relation

  // ───── select & drag
  selectDown(raw: Vec2, ev: { ctrl: boolean; shift: boolean; sx: number; sy: number }) {
    const sk = this.ss.sk;
    const c = this.dimHit?.(raw); if (c) { st().select({ kind: "skc", id: c }, ev.ctrl || ev.shift); return; }
    const h = hitSketch(sk, raw, this.tol);
    if (!h) { this.boxStart = [ev.sx, ev.sy]; this.boxCur = [ev.sx, ev.sy]; return; }
    const sel: Sel = { kind: "sk", id: h.id };
    const already = st().selection.some(s => selKey(s) === selKey(sel));
    if (!already || ev.ctrl) st().select(sel, ev.ctrl || ev.shift);
    // start drag
    let ids: string[] = []; let circle: string | undefined;
    if (h.kind === "pt") ids = [h.id];
    else { const e = sk.entities.find(x => x.id === h.id)!; if (e.type === "line") ids = [e.p1, e.p2]; else if (e.type === "circle") { circle = e.id; } else if (e.type === "arc") ids = [e.c, e.p1, e.p2]; else if (e.type === "spline") ids = e.pts.slice(); else if (e.type === "ellipse") ids = [e.c]; }
    ids = ids.filter(id => id !== "O" && !sk.points[id]?.fixed);
    const orig: Record<string, Vec2> = {}; ids.forEach(id => orig[id] = P(sk, id));
    this.drag = { ids, start: raw, orig, circle, moved: false };
  }
  dragMove(raw: Vec2) {
    const d = this.drag!; const sk = this.ss.sk; const dx = raw[0] - d.start[0], dy = raw[1] - d.start[1];
    if (!d.moved && Math.hypot(dx, dy) < this.tol * 0.3) return;
    const first = !d.moved; d.moved = true;
    if (d.circle) {
      const e = sk.entities.find(x => x.id === d.circle) as any; const c = P(sk, e.c); const r = Math.hypot(raw[0] - c[0], raw[1] - c[1]);
      const n = clone(sk); n.entities = n.entities.map(x => x.id === e.id ? { ...x, r } as SkEntity : x);
      const hasR = sk.constraints.some(k => k.refs.includes(e.id) && (k.type === "radius" || k.type === "diameter"));
      if (!hasR) st().skSet(n, { record: first }); return;
    }
    const drag: Record<string, [number, number]> = {}; d.ids.forEach(id => drag[id] = [d.orig[id][0] + dx, d.orig[id][1] + dy]);
    if (!st().skSet(sk, { record: first, drag })) {
      // fully constrained → can't move; try dragging fewer points (single point)
      if (d.ids.length > 1) { /* rigid move blocked */ }
    }
    this.version++;
  }

  // ───── trim
  trimAt(raw: Vec2) {
    const h = hitSketch(this.ss.sk, raw, this.tol);
    if (h?.kind === "ent") { const r = trimEntity(this.ss.sk, h.id, closestOnEntity(this.ss.sk, this.ss.sk.entities.find(e => e.id === h.id)!, raw)); if (r) st().skSet(r, { force: true }); }
  }
  powerTrim(a: Vec2, b: Vec2) {
    const sk = this.ss.sk;
    const seg: SkEntity = { id: "__trimpath", type: "line", p1: "__a", p2: "__b" };
    const tmp: Sketch = { ...sk, points: { ...sk.points, __a: { id: "__a", x: a[0], y: a[1] }, __b: { id: "__b", x: b[0], y: b[1] } } };
    for (const e of sk.entities) { if (e.type === "point") continue; const xs = intersect(tmp, e, seg); if (xs.length) { const r = trimEntity(sk, e.id, xs[0]); if (r) { st().skSet(r, { force: true, record: true }); return; } } }
  }

  // ───── smart dimension
  dimCandidate(cursor: Vec2): Constraint | null {
    const sk = this.ss.sk; const picks = this.dimPicks; if (!picks.length) return null;
    const ent = (id: string) => sk.entities.find(e => e.id === id);
    const centerOf = (p: { kind: string; id: string }) => { if (p.kind === "pt") return p.id; const e = ent(p.id) as any; return e?.c; };
    const mk = (type: ConstraintType, refs: string[], extra: Partial<Constraint> = {}): Constraint => { const c: Constraint = { id: uid("d"), type, refs, pos: cursor, ...extra }; c.value = measureDim(sk, c); return c; };
    if (picks.length === 1) {
      const p = picks[0]; if (p.kind === "pt") return null; const e = ent(p.id)!;
      if (e.type === "line") {
        const a = P(sk, e.p1), b = P(sk, e.p2); const minx = Math.min(a[0], b[0]), maxx = Math.max(a[0], b[0]), miny = Math.min(a[1], b[1]), maxy = Math.max(a[1], b[1]);
        const horizontalish = Math.abs(a[1] - b[1]) < 1e-9, verticalish = Math.abs(a[0] - b[0]) < 1e-9;
        if (!horizontalish && !verticalish) {
          if ((cursor[1] > maxy || cursor[1] < miny) && cursor[0] > minx && cursor[0] < maxx) return mk("hdistance", [e.p1, e.p2], { sign: Math.sign(b[0] - a[0]) || 1 });
          if ((cursor[0] > maxx || cursor[0] < minx) && cursor[1] > miny && cursor[1] < maxy) return mk("vdistance", [e.p1, e.p2], { sign: Math.sign(b[1] - a[1]) || 1 });
        }
        return mk("distance", [e.id]);
      }
      if (e.type === "circle") return mk("diameter", [e.id]);
      if (e.type === "arc") return mk("radius", [e.id]);
      return null;
    }
    const [p, q] = picks; const ep = p.kind === "ent" ? ent(p.id) : null, eq = q.kind === "ent" ? ent(q.id) : null;
    if (ep?.type === "line" && eq?.type === "line") {
      const a = P(sk, ep.p1), b = P(sk, ep.p2), c = P(sk, eq.p1), d = P(sk, eq.p2); const u = sub2(b, a), v = sub2(d, c);
      const cr = cross2(u, v) / (len2(u) * len2(v) || 1);
      if (Math.abs(cr) < 1e-6) return mk("lineLineDistance", [ep.id, eq.id]);
      const ang = Math.atan2(cross2(u, v), u[0] * v[0] + u[1] * v[1]); return mk("angle", [ep.id, eq.id], { sign: Math.sign(ang) || 1 });
    }
    if (ep?.type === "line" || eq?.type === "line") {
      const line = ep?.type === "line" ? p : q, other = line === p ? q : p; const pt = centerOf(other); if (!pt) return null;
      return mk("pointLineDistance", [pt, line.id]);
    }
    const a = centerOf(p), b = centerOf(q); if (!a || !b || a === b) return null;
    const A = P(sk, a), B = P(sk, b); const minx = Math.min(A[0], B[0]), maxx = Math.max(A[0], B[0]), miny = Math.min(A[1], B[1]), maxy = Math.max(A[1], B[1]);
    if ((cursor[1] > maxy || cursor[1] < miny) && cursor[0] >= minx && cursor[0] <= maxx && maxx - minx > 1e-9) return mk("hdistance", [a, b], { sign: Math.sign(B[0] - A[0]) || 1 });
    if ((cursor[0] > maxx || cursor[0] < minx) && cursor[1] >= miny && cursor[1] <= maxy && maxy - miny > 1e-9) return mk("vdistance", [a, b], { sign: Math.sign(B[1] - A[1]) || 1 });
    return mk("distance", [a, b]);
  }
  onDimPlaced?: (c: Constraint) => void;
  dimClick(raw: Vec2) {
    const sk = this.ss.sk;
    const h = hitSketch(sk, raw, this.tol);
    const existing = this.dimHit?.(raw);
    if (existing && !this.dimPicks.length) { const c = sk.constraints.find(k => k.id === existing); if (c && DIM_TYPES.has(c.type)) this.onDimPlaced?.(c); return; }
    if (h && this.dimPicks.length < 2 && !this.dimPicks.some(p => p.id === h.id)) {
      this.dimPicks.push(h); this.version++;
      const cand = this.dimCandidate(raw);
      if (this.dimPicks.length === 1 && h.kind === "pt") st().setStatus("Select a second entity to dimension");
      void cand; return;
    }
    // place
    const cand = this.dimCandidate(raw);
    if (cand) {
      const n = clone(sk); const count = sk.constraints.filter(c => DIM_TYPES.has(c.type)).length;
      cand.name = `D${count + 1}`; n.constraints.push(cand);
      st().skSet(n, { force: true });
      const after = st().sketch!.solve;
      if (after?.status === "over") st().setStatus("Adding this dimension will make the sketch over defined");
      this.onDimPlaced?.(cand);
    }
    this.dimPicks = []; this.version++;
  }

  // ───── typed numeric input
  typedFields(): string[] | null {
    const t = this.tool, n = this.pts.length;
    if ((t === "line" || t === "centerline") && n === 1) return ["Length", "Angle"];
    if (t === "circle" && this.mode !== "perimeter" && n === 1) return ["Radius"];
    if (t === "rect" && (this.mode === "corner" || this.mode === "" || this.mode === "center") && n === 1) return ["Width", "Height"];
    if (t === "polygon" && n === 1) return ["Radius"];
    return null;
  }
  key(e: KeyboardEvent): boolean {
    const fields = this.typedFields();
    if (fields && (/^[0-9.\-]$/.test(e.key) || (this.typed && (e.key === "Backspace" || e.key === "Tab" || e.key === "Enter")))) {
      if (!this.typed) this.typed = { fields, values: fields.map(() => ""), active: 0 };
      const t = this.typed;
      if (e.key === "Tab") { t.active = (t.active + 1) % t.fields.length; }
      else if (e.key === "Backspace") t.values[t.active] = t.values[t.active].slice(0, -1);
      else if (e.key === "Enter") { this.applyTyped(); return true; }
      else t.values[t.active] += e.key;
      this.version++; return true;
    }
    if (e.key === "Enter" && this.tool === "spline") { this.finishSpline(); return true; }
    if (e.key === "Escape") {
      if (this.pts.length || this.dimPicks.length || this.typed) { this.pts = []; this.chainStart = null; this.dimPicks = []; this.typed = null; this.version++; return true; }
      return false;
    }
    return false;
  }
  applyTyped() {
    const t = this.typed!; const nums = t.values.map(v => parseFloat(v));
    const a = this.pts[0].p; const tool = this.tool;
    if (tool === "line" || tool === "centerline") {
      const cur = this.cur?.p || [a[0] + 1, a[1]]; let L = isFinite(nums[0]) ? nums[0] : len2(sub2(cur, a)); let ang = isFinite(nums[1]) ? nums[1] * Math.PI / 180 : Math.atan2(cur[1] - a[1], cur[0] - a[0]);
      const b: Vec2 = [a[0] + L * Math.cos(ang), a[1] + L * Math.sin(ang)];
      const isH = Math.abs(Math.sin(ang)) < 1e-9, isV = Math.abs(Math.cos(ang)) < 1e-9;
      this.pts.push({ p: b, h: isH, v: isV, infer: [] }); this.typed = null; this.tryComplete();
      return;
    }
    if (tool === "circle" || tool === "polygon") { if (!isFinite(nums[0])) return; this.pts.push({ p: [a[0] + nums[0], a[1]], infer: [] }); this.tryComplete([nums[0]]); return; }
    if (tool === "rect") { const cur = this.cur?.p || a; const w = isFinite(nums[0]) ? nums[0] : (cur[0] - a[0]); const h = isFinite(nums[1]) ? nums[1] : (cur[1] - a[1]); this.pts.push({ p: [a[0] + w, a[1] + h], infer: [] }); this.tryComplete([w, h]); return; }
  }

  // ───── preview overlay
  overlay(): Overlay {
    const ov: Overlay = { lines: [], dashed: [], pts: [], snap: this.cur };
    const sk = this.ss.sk; const cur = this.cur?.p; const tool = this.tool, mode = this.mode; const pts = this.pts.map(p => p.p);
    if (this.cur?.infer) ov.dashed.push(...this.cur.infer);
    if (this.boxStart && this.boxCur) ov.box = [this.boxStart[0], this.boxStart[1], this.boxCur[0], this.boxCur[1]];
    if (tool === "dimension") { ov.dimPreview = cur ? this.dimCandidate(cur) : null; return ov; }
    if (!cur) return ov;
    const n = pts.length;
    const circlePoly = (c: Vec2, r: number) => Array.from({ length: 65 }, (_, i) => [c[0] + r * Math.cos(i / 64 * Math.PI * 2), c[1] + r * Math.sin(i / 64 * Math.PI * 2)] as Vec2);
    const lbl = (at: Vec2, text: string) => { ov.label = { at, text }; };
    if ((tool === "line" || tool === "centerline") && n >= 1) { const a = pts[n - 1]; (tool === "centerline" ? ov.dashed : ov.lines).push([a, cur]); lbl(cur, `${len2(sub2(cur, a)).toFixed(2)} ∠${(Math.atan2(cur[1] - a[1], cur[0] - a[0]) * 180 / Math.PI).toFixed(1)}°`); }
    if (tool === "circle") { if (mode === "perimeter") { if (n === 2) { const c = circle3(pts[0], pts[1], cur); if (c) ov.lines.push(circlePoly(c.c, c.r)); } else if (n === 1) ov.dashed.push([pts[0], cur]); } else if (n === 1) { const r = len2(sub2(cur, pts[0])); ov.lines.push(circlePoly(pts[0], r)); ov.dashed.push([pts[0], cur]); lbl(cur, `R ${r.toFixed(2)}`); } }
    if (tool === "rect" && n >= 1) {
      const a = pts[0];
      if (mode === "center") { const dx = cur[0] - a[0], dy = cur[1] - a[1]; ov.lines.push([[a[0] - dx, a[1] - dy], [a[0] + dx, a[1] - dy], [a[0] + dx, a[1] + dy], [a[0] - dx, a[1] + dy], [a[0] - dx, a[1] - dy]]); lbl(cur, `${Math.abs(2 * dx).toFixed(2)} × ${Math.abs(2 * dy).toFixed(2)}`); }
      else if (mode === "3corner" || mode === "3center" || mode === "parallelogram") { if (n === 1) ov.lines.push([a, cur]); else { const b = pts[1]; if (mode === "parallelogram") ov.lines.push([a, b, cur, [a[0] + cur[0] - b[0], a[1] + cur[1] - b[1]], a]); else { const u = sub2(b, a); const L = len2(u) || 1; const nr: Vec2 = [-u[1] / L, u[0] / L]; const w = (cur[0] - b[0]) * nr[0] + (cur[1] - b[1]) * nr[1]; if (mode === "3center") { ov.lines.push([[a[0] - u[0] - nr[0] * w, a[1] - u[1] - nr[1] * w], [a[0] + u[0] - nr[0] * w, a[1] + u[1] - nr[1] * w], [a[0] + u[0] + nr[0] * w, a[1] + u[1] + nr[1] * w], [a[0] - u[0] + nr[0] * w, a[1] - u[1] + nr[1] * w], [a[0] - u[0] - nr[0] * w, a[1] - u[1] - nr[1] * w]]); } else ov.lines.push([a, b, [b[0] + nr[0] * w, b[1] + nr[1] * w], [a[0] + nr[0] * w, a[1] + nr[1] * w], a]); } } }
      else { ov.lines.push([a, [cur[0], a[1]], cur, [a[0], cur[1]], a]); lbl(cur, `${Math.abs(cur[0] - a[0]).toFixed(2)} × ${Math.abs(cur[1] - a[1]).toFixed(2)}`); }
    }
    if (tool === "arc") {
      if (mode === "tangent" && n === 1 && this.pts[0].ptId) { const host = sk.entities.find(e => (e.type === "line" || e.type === "arc") && ((e as any).p1 === this.pts[0].ptId || (e as any).p2 === this.pts[0].ptId)) as any; if (host) { const arc = tangentArc(pts[0], tangentAt(sk, host, this.pts[0].ptId!), cur); if (arc) ov.lines.push(arcPoly(arc.c, pts[0], cur, arc.ccw)); } }
      else if (mode === "3point") { if (n === 1) ov.lines.push([pts[0], cur]); if (n === 2) { const c = circle3(pts[0], cur, pts[1]); if (c) ov.lines.push(arcPoly(c.c, pts[0], pts[1], arcThrough(c.c, pts[0], pts[1], cur))); } }
      else { if (n === 1) { ov.dashed.push([pts[0], cur]); ov.dashed.push(circlePoly(pts[0], len2(sub2(cur, pts[0])))); } if (n === 2) { const c = pts[0], a = pts[1]; const r = len2(sub2(a, c)); const ang = Math.atan2(cur[1] - c[1], cur[0] - c[0]); const e: Vec2 = [c[0] + r * Math.cos(ang), c[1] + r * Math.sin(ang)]; ov.lines.push(arcPoly(c, a, e, cross2(sub2(a, c), sub2(cur, c)) >= 0)); ov.dashed.push([c, a], [c, e]); } }
    }
    if (tool === "polygon" && n === 1) { const o = st().sketch!.toolOpts; const N = Math.max(3, o.sides | 0); const c = pts[0]; const r0 = len2(sub2(cur, c)); const r = o.inscribed ? r0 : r0 / Math.cos(Math.PI / N); const a0 = Math.atan2(cur[1] - c[1], cur[0] - c[0]); ov.lines.push(Array.from({ length: N + 1 }, (_, i) => [c[0] + r * Math.cos(a0 + i * 2 * Math.PI / N), c[1] + r * Math.sin(a0 + i * 2 * Math.PI / N)] as Vec2)); ov.dashed.push(circlePoly(c, r0)); }
    if (tool === "spline" && n >= 1) { ov.lines.push([...pts, cur]); ov.pts.push(...pts); }
    if (tool === "slot") { if (n === 1) ov.lines.push([pts[0], cur]); if (n === 2) { let [a, b] = pts; if (mode === "center") { const d = sub2(b, a); a = [pts[0][0] - d[0], pts[0][1] - d[1]]; } const u = sub2(b, a); const L = len2(u) || 1; const nr: Vec2 = [-u[1] / L, u[0] / L]; const r = Math.abs((cur[0] - b[0]) * nr[0] + (cur[1] - b[1]) * nr[1]); const A1: Vec2 = [a[0] - nr[0] * r, a[1] - nr[1] * r], B1: Vec2 = [b[0] - nr[0] * r, b[1] - nr[1] * r], B2: Vec2 = [b[0] + nr[0] * r, b[1] + nr[1] * r], A2: Vec2 = [a[0] + nr[0] * r, a[1] + nr[1] * r]; ov.lines.push([A1, B1], [B2, A2], arcPoly(b, B1, B2, true), arcPoly(a, A2, A1, true)); } }
    if (tool === "ellipse") { if (n === 1) ov.dashed.push([pts[0], cur]); if (n === 2) { const [c, m] = pts; const a = len2(sub2(m, c)); const rot = Math.atan2(m[1] - c[1], m[0] - c[0]); const b = Math.abs(-(cur[0] - c[0]) * Math.sin(rot) + (cur[1] - c[1]) * Math.cos(rot)); ov.lines.push(Array.from({ length: 65 }, (_, i) => { const t = i / 64 * Math.PI * 2; const x = a * Math.cos(t), y = b * Math.sin(t); return [c[0] + x * Math.cos(rot) - y * Math.sin(rot), c[1] + x * Math.sin(rot) + y * Math.cos(rot)] as Vec2; })); } }
    if (this.typed) ov.typed = { ...this.typed, at: cur };
    return ov;
  }
}

// ───── geometry helpers
export const cross2 = (a: Vec2, b: Vec2) => a[0] * b[1] - a[1] * b[0];
const polyA = (p: Vec2[]) => { let a = 0; for (let i = 0; i < p.length; i++) a += cross2(p[i], p[(i + 1) % p.length]); return a / 2; };
export function circle3(a: Vec2, b: Vec2, c: Vec2): { c: Vec2; r: number } | null {
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1])); if (Math.abs(d) < 1e-12) return null;
  const ux = ((a[0] ** 2 + a[1] ** 2) * (b[1] - c[1]) + (b[0] ** 2 + b[1] ** 2) * (c[1] - a[1]) + (c[0] ** 2 + c[1] ** 2) * (a[1] - b[1])) / d;
  const uy = ((a[0] ** 2 + a[1] ** 2) * (c[0] - b[0]) + (b[0] ** 2 + b[1] ** 2) * (a[0] - c[0]) + (c[0] ** 2 + c[1] ** 2) * (b[0] - a[0])) / d;
  return { c: [ux, uy], r: Math.hypot(a[0] - ux, a[1] - uy) };
}
function angOf(c: Vec2, p: Vec2) { return Math.atan2(p[1] - c[1], p[0] - c[0]); }
export function arcThrough(c: Vec2, a: Vec2, b: Vec2, m: Vec2) { // is m on CCW arc a→b?
  const T = Math.PI * 2; const nr = (v: number) => ((v % T) + T) % T; return nr(angOf(c, m) - angOf(c, a)) <= nr(angOf(c, b) - angOf(c, a));
}
export function arcPoly(c: Vec2, a: Vec2, b: Vec2, ccw: boolean): Vec2[] {
  const r = Math.hypot(a[0] - c[0], a[1] - c[1]); const T = Math.PI * 2; const nr = (v: number) => ((v % T) + T) % T;
  const a1 = angOf(c, a); let sw = nr(angOf(c, b) - a1); if (!ccw) sw = sw - T; if (Math.abs(sw) < 1e-9) sw = ccw ? T : -T;
  return Array.from({ length: 49 }, (_, i) => [c[0] + r * Math.cos(a1 + sw * i / 48), c[1] + r * Math.sin(a1 + sw * i / 48)] as Vec2);
}
function tangentAt(sk: Sketch, host: any, pid: string): Vec2 {
  if (host.type === "line") { const other = host.p1 === pid ? host.p2 : host.p1; const a = P(sk, other), b = P(sk, pid); const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1; return [(b[0] - a[0]) / L, (b[1] - a[1]) / L]; }
  const c = P(sk, host.c), p = P(sk, pid); const r: Vec2 = [p[0] - c[0], p[1] - c[1]]; const L = Math.hypot(r[0], r[1]) || 1;
  const ccwT: Vec2 = [-r[1] / L, r[0] / L]; return host.p2 === pid ? ccwT : [-ccwT[0], -ccwT[1]];
}
function tangentArc(s: Vec2, t: Vec2, e: Vec2): { c: Vec2; ccw: boolean } | null {
  const n: Vec2 = [-t[1], t[0]]; const d = sub2(e, s); const den = 2 * (n[0] * d[0] + n[1] * d[1]); if (Math.abs(den) < 1e-12) return null;
  const k = (d[0] * d[0] + d[1] * d[1]) / den; const c: Vec2 = [s[0] + n[0] * k, s[1] + n[1] * k];
  return { c, ccw: k > 0 };
}
export { sampleEntity, arcAngles };
