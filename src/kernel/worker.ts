/// <reference lib="webworker" />
// Geometry kernel worker — OpenCascade (via replicad) B-Rep modeling
import opencascade from "replicad-opencascadejs";
import wasmUrl from "replicad-opencascadejs/wasm?url";
import * as R from "replicad";
import type { Feature, PlaneDef, Vec3, Vec2, MeshData, FaceInfo, EdgeInfo, BuildResult, GeoRef } from "../types";
import { findProfiles, findChain, catmull, type Seg } from "../sketch/geom";
import { toWorld, add, mul, sub, norm, dot, cross, len } from "../math";

let ready: Promise<void> | null = null;
function init() {
  if (!ready) ready = (async () => { const oc = await (opencascade as any)({ locateFile: () => wasmUrl }); R.setOC(oc); })();
  return ready;
}

type Shape = any;
interface State { shape: Shape | null; tools: Record<string, { shape: Shape; op: "fuse" | "cut" | "intersect" }>; planes: Record<string, PlaneDef>; axes: Record<string, { o: Vec3; d: Vec3 }>; errors: Record<string, string> }

// ───── prefix cache
const cache = new Map<string, State>();
const hash = (s: string, seed = 0) => { let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed; for (let i = 0; i < s.length; i++) { const ch = s.charCodeAt(i); h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677); } h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909); h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909); return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36); };
const cacheSet = (k: string, s: State) => { cache.set(k, s); if (cache.size > 80) { const first = cache.keys().next().value; if (first) cache.delete(first); } };

// ───── geometry helpers
const W = (pl: PlaneDef, p: Vec2) => toWorld(pl, p[0], p[1]);
function edgeOfSeg(s: Seg, pl: PlaneDef): any[] {
  switch (s.t) {
    case "line": return Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]) < 1e-9 ? [] : [R.makeLine(W(pl, s.a), W(pl, s.b))];
    case "arc": return [R.makeThreePointArc(W(pl, s.a), W(pl, s.m), W(pl, s.b))];
    case "circle": return [R.makeCircle(s.r, W(pl, s.c), pl.n)];
    case "ellipse": { let a = s.a, b = s.b, rot = s.rot; if (b > a) { [a, b] = [b, a]; rot += Math.PI / 2; } const xd = add(mul(pl.x, Math.cos(rot)), mul(pl.y, Math.sin(rot))); return [R.makeEllipse(a, b, W(pl, s.c), pl.n, xd)]; }
    case "spline": { const pts = catmull(s.pts, 8).map(p => W(pl, p)); if (pts.length === 2) return [R.makeLine(pts[0], pts[1])]; return [R.makeBSplineApproximation(pts, { tolerance: 1e-3, smoothing: null, degMax: 3, degMin: 1 } as any)]; }
  }
}
const wireOf = (segs: Seg[], pl: PlaneDef) => R.assembleWire(segs.flatMap(s => edgeOfSeg(s, pl)));

function sketchOf(st: State, feats: Feature[], id: string) { const f = feats.find(x => x.id === id); if (!f?.sketch) throw new Error("Referenced sketch not found"); return f.sketch; }
function facesOfSketch(sk: any, contours?: number[]) {
  const { profiles, openEnds } = findProfiles(sk, contours);
  if (!profiles.length) throw new Error(openEnds.length ? "The sketch contour is open. Boss/Cut features require a closed contour." : "The sketch has no closed profile.");
  return profiles.map(p => faceWithHoles(wireOf(p.outer.segs, sk.plane), p.holes.map(h => wireOf(h.segs, sk.plane))));
}
function bboxDiag(s: Shape | null) { if (!s) return 500; try { const b = s.boundingBox; const [a, c] = b.bounds; return Math.hypot(c[0] - a[0], c[1] - a[1], c[2] - a[2]) + 10; } catch { return 1000; } }

function applyOp(st: State, tool: Shape, op: "fuse" | "cut" | "intersect", merge = true) {
  if (!st.shape) { if (op === "fuse") st.shape = tool; else throw new Error("The feature does not intersect the model body (no existing body to cut)."); return; }
  if (op === "fuse") st.shape = merge ? st.shape.fuse(tool) : R.makeCompound([st.shape, tool]);
  else if (op === "cut") { const before = R.measureVolume(st.shape); const r = st.shape.cut(tool); if (Math.abs(R.measureVolume(r) - before) < 1e-9) throw new Error("The cut does not intersect the model body."); st.shape = r; }
  else st.shape = st.shape.intersect(tool);
}

/** Face from an outer wire + hole wires. OCCT needs holes wound opposite to the outer boundary;
 *  sketch loops can come in either direction, so each hole is oriented by checking it reduces the area. */
function faceWithHoles(outer: any, holes: any[]): any {
  if (!holes.length) return R.makeFace(outer);
  const Ao = R.measureArea(R.makeFace(outer.clone()));
  const fixed = holes.map(h => { try { const a = R.measureArea(R.makeFace(outer.clone(), [h.clone()])); return a < Ao - 1e-9 ? h : R.cast(h.wrapped.Reversed()); } catch { return h; } });
  return R.makeFace(outer, fixed as any);
}
/** true parametric midpoint of an edge (replicad's pointAt() is not reliably normalised) */
function edgeMid(e: any): Vec3 {
  try { const ad = e._geomAdaptor(); const u = (ad.FirstParameter() + ad.LastParameter()) / 2; const q = ad.Value(u); return [q.X(), q.Y(), q.Z()]; } catch { /* */ }
  try { const s = e.startPoint, t = e.endPoint; return [(s.x + t.x) / 2, (s.y + t.y) / 2, (s.z + t.z) / 2]; } catch { return [1e9, 1e9, 1e9]; }
}
function resolveEdges(shape: Shape, refs: GeoRef[]) {
  const edges = shape.edges as any[]; const mids = edges.map(edgeMid);
  const tol = Math.max(0.05, bboxDiag(shape) * 2e-3);
  return refs.map(r => { let bi = -1, bd = Infinity; mids.forEach((m, i) => { const d = len(sub(m, r.point)); if (d < bd) { bd = d; bi = i; } }); if (bd > tol * 20 && edges[r.index]) return edges[r.index]; return edges[bi]; }).filter(Boolean);
}
function resolveFaces(shape: Shape, refs: GeoRef[]) {
  const faces = shape.faces as any[];
  const info = faces.map(f => { const c = f.center; let n: Vec3 | null = null; try { const v = f.normalAt(); n = [v.x, v.y, v.z]; } catch { /* */ } return { c: [c.x, c.y, c.z] as Vec3, n }; });
  return refs.map(r => { let bi = -1, bd = Infinity; info.forEach((m, i) => { let d = len(sub(m.c, r.point)); if (r.normal && m.n && dot(r.normal, m.n) < 0.9) d += 1e6; if (d < bd) { bd = d; bi = i; } }); return faces[bi]; }).filter(Boolean);
}
const rPlane = (p: PlaneDef) => new R.Plane(p.origin, p.x, p.n);

function extrudeFaces(faces: any[], pl: PlaneDef, p: any, diag: number, isCut: boolean): Shape {
  const n = pl.n; const sgn = (p.reverse ? -1 : 1) * (isCut ? -1 : 1); // cuts go into the material (−normal) by default
  let d1 = p.depth ?? 10; let start = p.offset ?? 0;
  const ec = p.end || "blind";
  if (ec === "throughAll") d1 = diag * 2;
  let solids: Shape[] = [];
  for (const f0 of faces) {
    const mk = (from: number, dist: number, dir: number) => { let f = f0.clone(); if (Math.abs(from) > 1e-12) f = f.translate(mul(n, from)); return R.basicFaceExtrusion(f, new R.Vector(mul(n, dist * dir))); };
    let s: Shape;
    if (ec === "midPlane") s = mk(start - d1 / 2, d1, 1);
    else if (ec === "throughAllBoth") s = mk(start - diag * 2, diag * 4, 1);
    else s = mk(start * sgn, d1, sgn);
    if (p.dir2?.enabled && ec !== "midPlane" && ec !== "throughAllBoth") {
      const d2 = p.dir2.end === "throughAll" ? diag * 2 : (p.dir2.depth ?? 10);
      s = s.fuse(mk(start * sgn, d2, -sgn));
    }
    if (p.draft?.angle) {
      try {
        const sides = s.faces.filter((f: any) => { try { const v = f.normalAt(); return Math.abs(dot([v.x, v.y, v.z], n)) < 0.2; } catch { return true; } });
        const neutral = new R.Plane(add(pl.origin, mul(n, start * sgn)), pl.x, mul(n, sgn));
        s = s.draft((p.draft.outward ? -1 : 1) * p.draft.angle, (fd: any) => fd.inList(sides), neutral);
      } catch (e) { throw new Error("Draft could not be applied with these parameters."); }
    }
    solids.push(s);
  }
  let out = solids[0]; for (let i = 1; i < solids.length; i++) out = out.fuse(solids[i]);
  void isCut; return out;
}

function thinFaces(sk: any, t: number, side: string): any[] {
  // closed profiles → ring, open chains → offset band polygon
  const { profiles } = findProfiles(sk);
  if (profiles.length) {
    return profiles.map(pr => {
      const w = wireOf(pr.outer.segs, sk.plane);
      const inner = side === "mid" ? null : w.clone().offset2D(side === "rev" ? t : -t, "intersection");
      if (side === "mid") { const a = w.clone().offset2D(t / 2, "intersection"), b = w.clone().offset2D(-t / 2, "intersection"); return faceWithHoles(a, [b]); }
      return side === "rev" ? faceWithHoles(inner as any, [w]) : faceWithHoles(w, [inner as any]);
    });
  }
  const chain = findChain(sk); if (!chain.length) throw new Error("No sketch entities for thin feature.");
  const pts: Vec2[] = []; chain.forEach(s => { const pp = s.t === "line" ? [s.a, s.b] : s.t === "arc" ? sampleArc(s) : s.t === "spline" ? catmull(s.pts) : []; pts.push(...(pts.length ? pp.slice(1) : pp)); });
  const off = (d: number) => pts.map((p, i) => { const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)]; const dx = b[0] - a[0], dy = b[1] - a[1]; const L = Math.hypot(dx, dy) || 1; return [p[0] - dy / L * d, p[1] + dx / L * d] as Vec2; });
  const [d1, d2] = side === "mid" ? [t / 2, -t / 2] : side === "rev" ? [0, -t] : [t, 0];
  const A = off(d1), B = off(d2).reverse();
  return [R.makePolygon([...A, ...B].map(p => W(sk.plane, p)))];
}
function sampleArc(s: Seg & { t: "arc" }): Vec2[] {
  const a1 = Math.atan2(s.a[1] - s.c[1], s.a[0] - s.c[0]), a2 = Math.atan2(s.b[1] - s.c[1], s.b[0] - s.c[0]), am = Math.atan2(s.m[1] - s.c[1], s.m[0] - s.c[0]);
  const T = Math.PI * 2; const nr = (v: number) => ((v % T) + T) % T; let sw = nr(a2 - a1); if (nr(am - a1) > sw) sw -= T;
  return Array.from({ length: 25 }, (_, i) => [s.c[0] + s.r * Math.cos(a1 + sw * i / 24), s.c[1] + s.r * Math.sin(a1 + sw * i / 24)] as Vec2);
}

function holeTool(p: any, pl: PlaneDef, pt: Vec2, diag: number): Shape {
  const o = W(pl, pt); const d = mul(pl.n, -1); const x = pl.x;
  const P3 = (r: number, z: number) => add(add(o, mul(x, r)), mul(d, z));
  const R0 = p.dia / 2; const through = p.end === "throughAll"; const depth = through ? diag * 2 : p.depth; const z0 = -0.01;
  let top: [number, number][];
  if (p.htype === "cbore") top = [[0, z0], [p.cbDia / 2, z0], [p.cbDia / 2, p.cbDepth], [R0, p.cbDepth]];
  else if (p.htype === "csink") { const rcs = p.csDia / 2; const zc = (rcs - R0) / Math.tan((p.csAngle || 90) * Math.PI / 360); top = [[0, z0], [rcs, z0], [R0, zc]]; }
  else top = [[0, z0], [R0, z0]];
  const prof: [number, number][] = [...top, [R0, depth], through ? [0, depth] : [0, depth + R0 * Math.tan(31 * Math.PI / 180)]];
  const face = R.makePolygon(prof.map(([r, z]) => P3(r, z)));
  return R.revolution(face, o, d, 360);
}

function transformClone(s: Shape, t: { p: Vec3; q: number[] }) {
  let c = s.clone(); const [qx, qy, qz, qw] = t.q; const w = Math.max(-1, Math.min(1, qw)); const ang = 2 * Math.acos(w); const sn = Math.sqrt(1 - w * w);
  if (ang > 1e-9 && sn > 1e-9) c = c.rotate(ang * 180 / Math.PI, [0, 0, 0], [qx / sn, qy / sn, qz / sn]);
  if (len(t.p) > 1e-12) c = c.translate(t.p);
  return c;
}

// ───── feature evaluation
async function applyFeature(st: State, f: Feature, feats: Feature[]): Promise<{ tool?: Shape; result?: Shape }> {
  const p = f.params || {};
  const diag = bboxDiag(st.shape);
  switch (f.type) {
    case "sketch": return {};
    case "plane": {
      let pl: PlaneDef = p.base;
      if (p.refPlane && st.planes[p.refPlane]) pl = st.planes[p.refPlane];
      let n = pl.n, x = pl.x, y = pl.y;
      if (p.angle && p.rotAxis) { const ang = p.angle * Math.PI / 180; const rot = (v: Vec3) => { const k = norm(p.rotAxis.d); return add(add(mul(v, Math.cos(ang)), mul(cross(k, v), Math.sin(ang))), mul(k, dot(k, v) * (1 - Math.cos(ang)))); }; n = rot(n); x = rot(x); y = rot(y); }
      if (p.flip) { n = mul(n, -1); x = mul(x, -1); }
      st.planes[f.id] = { origin: add(pl.origin, mul(n, p.offset || 0)), x, y, n, name: f.name };
      return {};
    }
    case "axis": st.axes[f.id] = { o: p.o, d: norm(p.d) }; return {};
    case "point": return {};
    case "import": {
      const bin = Uint8Array.from(atob(p.data), c => c.charCodeAt(0));
      const blob = new Blob([bin]);
      const s = p.format === "stl" ? await R.importSTL(blob) : await R.importSTEP(blob);
      applyOp(st, s, "fuse"); return { tool: s };
    }
    case "extrude": case "cut": {
      const sk = sketchOf(st, feats, p.sketchId);
      const isCut = f.type === "cut";
      const faces = p.thin?.enabled ? thinFaces(sk, p.thin.thickness || 1, p.thin.side || "fwd") : facesOfSketch(sk, p.contours);
      const tool = extrudeFaces(faces, sk.plane, p, diag, isCut);
      applyOp(st, tool, isCut ? (p.flipSide ? "intersect" : "cut") : "fuse", p.merge !== false);
      return { tool };
    }
    case "revolve": case "revolveCut": {
      const sk = sketchOf(st, feats, p.sketchId);
      const ax = sk.entities.find((e: any) => e.id === p.axis) || sk.entities.find((e: any) => e.type === "line" && e.construction);
      if (!ax || ax.type !== "line") throw new Error("Select an axis of revolution (a centerline or line in the sketch).");
      const skNoAxis = { ...sk, entities: sk.entities.filter((e: any) => e.id !== ax.id) };
      const a = W(sk.plane, [sk.points[ax.p1].x, sk.points[ax.p1].y]), b = W(sk.plane, [sk.points[ax.p2].x, sk.points[ax.p2].y]);
      const dir = norm(sub(b, a));
      const faces = p.thin?.enabled ? thinFaces(skNoAxis, p.thin.thickness || 1, p.thin.side || "fwd") : facesOfSketch(skNoAxis, p.contours);
      let ang = Math.min(360, Math.max(0.01, p.angle ?? 360)); const sgn = p.reverse ? -1 : 1;
      let tool: Shape | null = null;
      for (const f0 of faces) {
        let fc = f0; let total = ang; let startA = 0;
        if (p.end === "midPlane") startA = -ang / 2; else if (p.dir2?.enabled) { startA = -(p.dir2.angle || 0) * sgn; total = ang + (p.dir2.angle || 0); }
        total = Math.min(360, total);
        if (Math.abs(startA) > 1e-9 && total < 360) fc = fc.clone().rotate(startA * sgn, a, dir);
        const s = R.revolution(fc, a, mul(dir, sgn), total);
        tool = tool ? tool.fuse(s) : s;
      }
      applyOp(st, tool, f.type === "revolveCut" ? "cut" : "fuse", p.merge !== false);
      return { tool };
    }
    case "sweep": case "sweepCut": {
      const prof = sketchOf(st, feats, p.profileId), path = sketchOf(st, feats, p.pathId);
      const { profiles } = findProfiles(prof); if (!profiles.length) throw new Error("Sweep profile must be a closed contour.");
      const chain = findChain(path); if (!chain.length) throw new Error("Sweep path is empty.");
      const spine = wireOf(chain, path.plane);
      let tool: Shape | null = null;
      for (const pr of profiles) {
        let s = R.genericSweep(wireOf(pr.outer.segs, prof.plane), spine, { frenet: p.orient !== "constant", transitionMode: "round" } as any);
        for (const h of pr.holes) s = s.cut(R.genericSweep(wireOf(h.segs, prof.plane), spine, { frenet: p.orient !== "constant", transitionMode: "round" } as any));
        tool = tool ? tool.fuse(s) : s;
      }
      applyOp(st, tool, f.type === "sweepCut" ? "cut" : "fuse", p.merge !== false);
      return { tool };
    }
    case "loft": case "loftCut": {
      const ids: string[] = p.profiles || []; if (ids.length < 2) throw new Error("Select at least two profiles for a loft.");
      const wires = ids.map(id => { const sk = sketchOf(st, feats, id); const { profiles } = findProfiles(sk); if (!profiles.length) throw new Error("Loft profiles must be closed contours."); return wireOf(profiles[0].outer.segs, sk.plane); });
      if (p.close && wires.length > 2) wires.push(wires[0].clone());
      const tool = R.loft(wires, { ruled: !!p.ruled });
      applyOp(st, tool, f.type === "loftCut" ? "cut" : "fuse", p.merge !== false);
      return { tool };
    }
    case "fillet": {
      if (!st.shape) throw new Error("No body to fillet.");
      const edges = resolveEdges(st.shape, p.edges || []); if (!edges.length) throw new Error("Select edges to fillet.");
      const r: any = p.ftype === "variable" ? [p.radius, p.radius2 ?? p.radius] : p.radius;
      st.shape = st.shape.fillet((e: any) => edges.some((t: any) => t.isSame(e)) ? r : null);
      return { result: st.shape };
    }
    case "chamfer": {
      if (!st.shape) throw new Error("No body to chamfer.");
      const edges = resolveEdges(st.shape, p.edges || []); if (!edges.length) throw new Error("Select edges to chamfer.");
      if (p.ctype === "equal" || !p.ctype) st.shape = st.shape.chamfer((e: any) => edges.some((t: any) => t.isSame(e)) ? p.distance : null);
      else {
        let s = st.shape;
        for (const edge of edges) {
          const adj = (s.faces as any[]).find(fc => (fc.edges as any[]).some(ee => ee.isSame(edge)));
          const cfg: any = p.ctype === "angle" ? { distance: p.distance, angle: p.angle ?? 45, selectedFace: (ff: any) => ff.inList([adj]) } : { distances: p.flip ? [p.distance2, p.distance] : [p.distance, p.distance2], selectedFace: (ff: any) => ff.inList([adj]) };
          s = s.chamfer(cfg, (ef: any) => ef.inList([edge]));
        }
        st.shape = s;
      }
      return { result: st.shape };
    }
    case "shell": {
      if (!st.shape) throw new Error("No body to shell.");
      const faces = resolveFaces(st.shape, p.faces || []);
      const t = (p.outward ? -1 : 1) * (p.thickness || 1);
      if (!faces.length) throw new Error("Select at least one face to remove for the shell.");
      st.shape = st.shape.shell(t, (ff: any) => ff.inList(faces));
      return { result: st.shape };
    }
    case "draft": {
      if (!st.shape) throw new Error("No body to draft.");
      const faces = resolveFaces(st.shape, p.faces || []); if (!faces.length) throw new Error("Select faces to draft.");
      const pl: PlaneDef = p.neutral; if (!pl) throw new Error("Select a neutral plane.");
      st.shape = st.shape.draft((p.reverse ? -1 : 1) * (p.angle || 1), (ff: any) => ff.inList(faces), new R.Plane(pl.origin, pl.x, pl.n));
      return { result: st.shape };
    }
    case "hole": {
      const pl: PlaneDef = p.plane; if (!pl) throw new Error("Select a face for hole placement.");
      const pts: Vec2[] = p.points || []; if (!pts.length) throw new Error("Place at least one hole position.");
      let tool: Shape | null = null;
      for (const pt of pts) { const t = holeTool(p, pl, pt, diag); tool = tool ? tool.fuse(t) : t; }
      applyOp(st, tool, "cut"); return { tool };
    }
    case "linearPattern": case "circularPattern": case "mirror": {
      const src: string[] = p.features || [];
      const tools = src.map(id => st.tools[id]).filter(Boolean);
      const bodyMode = !tools.length && f.type === "mirror" && st.shape;
      if (!tools.length && !bodyMode) throw new Error("Select features to pattern (extrudes, cuts, revolves, holes…).");
      const xforms: ((s: Shape) => Shape)[] = [];
      if (f.type === "linearPattern") {
        const d1 = norm(p.dir || [1, 0, 0]), d2 = norm(p.dir2?.dir || [0, 0, 1]);
        const n1 = Math.max(1, p.count | 0), n2 = p.dir2?.enabled ? Math.max(1, p.dir2.count | 0) : 1;
        const skip: string[] = p.skip || [];
        for (let i = 0; i < n1; i++) for (let j = 0; j < n2; j++) {
          if (!i && !j) continue; if (skip.includes(`${i},${j}`)) continue;
          const off = add(mul(d1, i * (p.spacing || 10) * (p.reverse ? -1 : 1)), mul(d2, j * (p.dir2?.spacing || 10) * (p.dir2?.reverse ? -1 : 1)));
          xforms.push(s => s.clone().translate(off));
        }
      } else if (f.type === "circularPattern") {
        const ax = p.axisRef && st.axes[p.axisRef] ? st.axes[p.axisRef] : p.axis || { o: [0, 0, 0], d: [0, 1, 0] };
        const n = Math.max(1, p.count | 0); const total = p.angle ?? 360;
        const step = p.equal !== false ? (Math.abs(total - 360) < 1e-6 ? 360 / n : total / Math.max(1, n - 1)) : total;
        for (let i = 1; i < n; i++) { if ((p.skip || []).includes(String(i))) continue; xforms.push(s => s.clone().rotate(step * i * (p.reverse ? -1 : 1), ax.o, ax.d)); }
      } else {
        const pl: PlaneDef = p.plane; if (!pl) throw new Error("Select a mirror plane.");
        xforms.push(s => s.clone().mirror(pl.n, pl.origin));
      }
      if (bodyMode) { let res = st.shape; for (const x of xforms) res = res.fuse(x(st.shape)); st.shape = res; return { result: res }; }
      let combined: Shape | null = null;
      for (const t of tools) for (const x of xforms) { const inst = x(t.shape); if (t.op === "fuse") st.shape = st.shape ? st.shape.fuse(inst) : inst; else if (st.shape) st.shape = t.op === "cut" ? st.shape.cut(inst) : st.shape.intersect(inst); combined = combined ? R.makeCompound([combined, inst]) : inst; }
      return { tool: combined, result: st.shape };
    }
  }
  return {};
}

async function runFeatures(feats: Feature[], uptoExclusive: number): Promise<{ st: State; key: string }> {
  let key = "root"; let st: State = { shape: null, tools: {}, planes: {}, axes: {}, errors: {} };
  let startIdx = 0;
  const keys: string[] = [];
  for (let i = 0; i < uptoExclusive; i++) { key = hash(key + JSON.stringify(feats[i])); keys.push(key); }
  for (let i = uptoExclusive - 1; i >= 0; i--) { const c = cache.get(keys[i]); if (c) { st = cloneState(c); startIdx = i + 1; break; } }
  for (let i = startIdx; i < uptoExclusive; i++) {
    const f = feats[i];
    if (!f.suppressed) {
      try { const r = await applyFeature(st, f, feats); if (r.tool) st.tools[f.id] = { shape: r.tool, op: f.type.toLowerCase().includes("cut") || f.type === "hole" ? "cut" : (f.type === "extrude" || f.type === "cut") && f.params?.flipSide ? "intersect" : "fuse" }; }
      catch (e: any) { st.errors[f.id] = cleanErr(e); }
    }
    cacheSet(keys[i], cloneState(st));
  }
  return { st, key: keys[uptoExclusive - 1] || "root" };
}
const cloneState = (s: State): State => ({ shape: s.shape, tools: { ...s.tools }, planes: { ...s.planes }, axes: { ...s.axes }, errors: { ...s.errors } });
function cleanErr(e: any): string {
  const m = typeof e === "number" ? "Geometry kernel failure (OCC exception)." : (e?.message || String(e));
  if (/BRep_API|StdFail|not done|NotDone|Standard_/i.test(m) || /^\d+$/.test(m)) return "The geometry could not be created with these parameters (try a smaller radius / different dimensions).";
  return m;
}

// ───── meshing
function meshShape(shape: Shape): MeshData | null {
  if (!shape) return null;
  const diag = bboxDiag(shape);
  const tol = Math.max(0.005, diag * 4e-4);
  const m = shape.mesh({ tolerance: tol, angularTolerance: 0.15 });
  const me = shape.meshEdges({ tolerance: tol, angularTolerance: 0.15 });
  const faces = shape.faces as any[], edges = shape.edges as any[];
  const fIdx = new Map<number, number>(); faces.forEach((f, i) => fIdx.set(f.hashCode, i));
  const eIdx = new Map<number, number>(); edges.forEach((e, i) => eIdx.set(e.hashCode, i));
  const faceInfo: FaceInfo[] = faces.map((f, i) => {
    const c = f.center; let n: Vec3 | null = null; let axis: FaceInfo["axis"];
    const type = f.geomType as string;
    try { const v = f.normalAt(); n = [v.x, v.y, v.z]; } catch { /* */ }
    if (type === "CYLINDRE" || type === "CONE") { try { const cy = type === "CYLINDRE" ? f._geomAdaptor().Cylinder() : f._geomAdaptor().Cone(); const ax = cy.Axis(); axis = { o: [ax.Location().X(), ax.Location().Y(), ax.Location().Z()], d: [ax.Direction().X(), ax.Direction().Y(), ax.Direction().Z()], r: type === "CYLINDRE" ? cy.Radius() : cy.RefRadius() }; } catch { /* */ } }
    let area = 0; try { area = R.measureArea(f); } catch { /* */ }
    return { id: i, type, center: [c.x, c.y, c.z], normal: type === "PLANE" ? n : n, axis, area };
  });
  const edgeInfo: EdgeInfo[] = edges.map((e, i) => {
    let mid: Vec3 = [0, 0, 0]; let circle: EdgeInfo["circle"]; let a: Vec3 | undefined, b: Vec3 | undefined; let L = 0;
    try { const s = e.startPoint, t = e.endPoint; a = [s.x, s.y, s.z]; b = [t.x, t.y, t.z]; L = e.length; } catch { /* */ }
    mid = edgeMid(e);
    if (e.geomType === "CIRCLE") { try { const ci = e._geomAdaptor().Circle(); const l = ci.Location(), d = ci.Axis().Direction(); circle = { c: [l.X(), l.Y(), l.Z()], n: [d.X(), d.Y(), d.Z()], r: ci.Radius() }; } catch { /* */ } }
    return { id: i, type: e.geomType, mid, circle, a, b, length: L };
  });
  let bbox: [Vec3, Vec3] | null = null; try { const bb = shape.boundingBox.bounds; bbox = [bb[0], bb[1]]; } catch { /* */ }
  return {
    vertices: new Float32Array(m.vertices), normals: new Float32Array(m.normals), triangles: new Uint32Array(m.triangles),
    faceGroups: m.faceGroups.map((g: any) => ({ start: g.start, count: g.count, faceId: fIdx.get(g.faceId) ?? -1 })),
    lines: new Float32Array(me.lines), edgeGroups: me.edgeGroups.map((g: any) => ({ start: g.start, count: g.count, edgeId: eIdx.get(g.edgeId) ?? -1 })),
    faces: faceInfo, edges: edgeInfo, bbox,
  };
}
const transferables = (m: MeshData | null | undefined) => m ? [m.vertices.buffer, m.normals.buffer, m.triangles.buffer, m.lines.buffer] : [];

function massOf(shape: Shape) {
  try {
    const vp = R.measureShapeVolumeProperties(shape); const volume = vp.volume; const com = vp.centerOfMass as Vec3;
    let inertia: number[] | undefined;
    try { const M = (vp as any).wrapped.MatrixOfInertia(); inertia = []; for (let r = 1; r <= 3; r++) for (let c = 1; c <= 3; c++) inertia.push(M.Value(r, c)); } catch { /* */ }
    return { volume, area: R.measureArea(shape), com, inertia };
  } catch { return null; }
}

// ───── handlers
async function build(payload: any): Promise<BuildResult> {
  const t0 = performance.now();
  const feats: Feature[] = payload.features;
  const edit = payload.edit as { index: number; feature: Feature } | undefined;
  let main: MeshData | null = null, preview: MeshData | null = null, previewTool = false;
  let errors: Record<string, string> = {}, planes = {}, axes = {}, mass: any = null;
  let key = "";
  if (edit) {
    const list = feats.slice(); list[edit.index] = edit.feature;
    const { st } = await runFeatures(list, edit.index);
    main = meshShape(st.shape); errors = st.errors; planes = st.planes; axes = st.axes;
    const st2 = cloneState(st);
    try {
      const r = await applyFeature(st2, edit.feature, list);
      if (r.tool && ["extrude", "cut", "revolve", "revolveCut", "sweep", "sweepCut", "loft", "loftCut", "hole"].includes(edit.feature.type)) { preview = meshShape(r.tool); previewTool = true; }
      else if (st2.shape && st2.shape !== st.shape) preview = meshShape(st2.shape);
      planes = st2.planes; axes = st2.axes;
    } catch (e: any) { errors = { ...errors, [edit.feature.id]: cleanErr(e) }; }
  } else {
    const r = await runFeatures(feats, feats.length);
    key = r.key; main = meshShape(r.st.shape); errors = r.st.errors; planes = r.st.planes; axes = r.st.axes;
    if (payload.mass && r.st.shape) mass = massOf(r.st.shape);
  }
  return { key, main, preview, previewTool, errors, planes, axes, mass, time: performance.now() - t0 };
}

async function shapeOf(feats: Feature[]) { const { st } = await runFeatures(feats, feats.length); return st.shape; }

async function assemblyShape(comps: { features: Feature[]; t: any }[]) {
  const shapes: Shape[] = [];
  for (const c of comps) { const s = await shapeOf(c.features); if (s) shapes.push(transformClone(s, c.t)); }
  return shapes;
}

function projectShape(shape: Shape, v: any) {
  const dir: Vec3 = v.dir, xAx: Vec3 = v.xAxis; const yAx = cross(dir, xAx);
  let s = shape; let hatch = "";
  if (v.section) {
    const pl = new R.Plane(v.section.origin, v.section.x, v.section.n);
    const cut = s.cutPlane(pl, 0); if (cut) s = cut;
    // section faces → hatched region
    try {
      const n: Vec3 = v.section.n; const o: Vec3 = v.section.origin;
      const secFaces = (s.faces as any[]).filter(f => { if (f.geomType !== "PLANE") return false; const nv = f.normalAt(); const c = f.center; return Math.abs(Math.abs(dot([nv.x, nv.y, nv.z], n)) - 1) < 1e-4 && Math.abs(dot(sub([c.x, c.y, c.z], o), n)) < 1e-4; });
      const parts: string[] = [];
      for (const f of secFaces) { const m = f.mesh({ tolerance: 0.05, angularTolerance: 0.2 }); const V = m.vertices; const T = m.triangles; for (let i = 0; i < T.length; i += 3) { const pts = [T[i], T[i + 1], T[i + 2]].map(k => { const P: Vec3 = [V[3 * k], V[3 * k + 1], V[3 * k + 2]]; return `${dot(P, xAx).toFixed(3)} ${(-dot(P, yAx)).toFixed(3)}`; }); parts.push(`M${pts[0]}L${pts[1]}L${pts[2]}Z`); } }
      hatch = parts.join("");
    } catch { /* */ }
  }
  const pr = R.drawProjection(s, new R.ProjectionCamera([0, 0, 0], dir, xAx));
  const flat = (d: any) => { try { const p = d.toSVGPaths(); return (p as any[]).flat(3).filter((x: any) => typeof x === "string"); } catch { return []; } };
  let bb: number[] | null = null;
  try { const b = s.boundingBox.bounds; const corners: Vec3[] = []; for (const X of [b[0][0], b[1][0]]) for (const Y of [b[0][1], b[1][1]]) for (const Z of [b[0][2], b[1][2]]) corners.push([X, Y, Z]); const xs = corners.map(c => dot(c, xAx)), ys = corners.map(c => -dot(c, yAx)); bb = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]; } catch { /* */ }
  return { visible: flat(pr.visible), hidden: v.hidden ? flat(pr.hidden) : [], hatch, bbox: bb };
}

async function handle(type: string, payload: any): Promise<[any, Transferable[]]> {
  await init();
  switch (type) {
    case "init": return [true, []];
    case "build": { const r = await build(payload); return [r, [...transferables(r.main), ...transferables(r.preview)]]; }
    case "export": {
      const shapes: Shape[] = payload.assembly ? await assemblyShape(payload.assembly) : [await shapeOf(payload.features)].filter(Boolean);
      if (!shapes.length) throw new Error("Nothing to export — the model has no solid body.");
      const s = shapes.length === 1 ? shapes[0] : R.makeCompound(shapes);
      const blob: Blob = payload.format === "step" ? s.blobSTEP() : s.blobSTL({ binary: true, tolerance: payload.tolerance || 0.05, angularTolerance: payload.angular || 0.2 });
      const buf = await blob.arrayBuffer(); return [buf, [buf]];
    }
    case "project": {
      const shapes: Shape[] = payload.assembly ? await assemblyShape(payload.assembly) : [await shapeOf(payload.features)].filter(Boolean);
      if (!shapes.length) return [{}, []];
      const s = shapes.length === 1 ? shapes[0] : R.makeCompound(shapes);
      const out: Record<string, any> = {};
      for (const v of payload.views) { try { out[v.id] = projectShape(s, v); } catch (e: any) { out[v.id] = { error: cleanErr(e), visible: [], hidden: [] }; } }
      return [out, []];
    }
    case "interference": {
      const shapes = await Promise.all(payload.comps.map(async (c: any) => ({ id: c.id, s: transformClone(await shapeOf(c.features), c.t) })));
      const res: any[] = [];
      for (let i = 0; i < shapes.length; i++) for (let j = i + 1; j < shapes.length; j++) {
        try { const x = shapes[i].s.intersect(shapes[j].s); const v = R.measureVolume(x); if (v > 1e-6) res.push({ a: shapes[i].id, b: shapes[j].id, volume: v, mesh: meshShape(x) }); } catch { /* */ }
      }
      return [res, []];
    }
    case "mass": { const s = await shapeOf(payload.features); return [s ? massOf(s) : null, []]; }
  }
  throw new Error("unknown request " + type);
}

let queue = Promise.resolve();
self.onmessage = (ev: MessageEvent) => {
  const { id, type, payload } = ev.data;
  queue = queue.then(async () => {
    try { const [result, tr] = await handle(type, payload); (self as any).postMessage({ id, ok: true, result }, tr); }
    catch (e: any) { (self as any).postMessage({ id, ok: false, error: cleanErr(e) }); }
  });
};
