import { useApp, insertFeature, nextName, consumerOf, effectiveFeatures, type Sel, type PMState } from "../store";
import type { PartDoc, AssemblyDoc, Feature, GeoRef, PlaneDef, Vec3, Mate, MateType } from "../types";
import { uid, planeFromNormal, norm, sub, PLANES } from "../math";
import { pmBus } from "./pmBus";
import { solveMates, localGeo, allowedMates, relTransform } from "../assembly/solver";
import { qFromAxisAngle, qMul, add } from "../math";

export const HOLE_TABLE: Record<string, { normal: number; close: number; loose: number; cbDia: number; cbDepth: number; csDia: number; tap: number }> = {
  M2: { normal: 2.4, close: 2.2, loose: 2.6, cbDia: 4.4, cbDepth: 2.2, csDia: 4.4, tap: 1.6 },
  M3: { normal: 3.4, close: 3.2, loose: 3.6, cbDia: 6.5, cbDepth: 3.3, csDia: 6.3, tap: 2.5 },
  M4: { normal: 4.5, close: 4.3, loose: 4.8, cbDia: 8, cbDepth: 4.4, csDia: 9.4, tap: 3.3 },
  M5: { normal: 5.5, close: 5.3, loose: 5.8, cbDia: 10, cbDepth: 5.4, csDia: 10.4, tap: 4.2 },
  M6: { normal: 6.6, close: 6.4, loose: 7, cbDia: 11, cbDepth: 6.5, csDia: 12.6, tap: 5 },
  M8: { normal: 9, close: 8.4, loose: 10, cbDia: 15, cbDepth: 8.6, csDia: 17.3, tap: 6.8 },
  M10: { normal: 11, close: 10.5, loose: 12, cbDia: 18, cbDepth: 10.8, csDia: 20, tap: 8.5 },
  M12: { normal: 13.5, close: 13, loose: 14.5, cbDia: 20, cbDepth: 13, csDia: 24, tap: 10.2 },
  M16: { normal: 17.5, close: 17, loose: 18.5, cbDia: 26, cbDepth: 17.5, csDia: 32, tap: 14 },
};
export function holeDims(p: any) {
  const h = HOLE_TABLE[p.size] || HOLE_TABLE.M5;
  const dia = p.htype === "tap" ? h.tap : p.fit === "close" ? h.close : p.fit === "loose" ? h.loose : h.normal;
  return { dia, cbDia: h.cbDia, cbDepth: h.cbDepth, csDia: h.csDia, csAngle: 90 };
}

const st = () => useApp.getState();
const partDoc = () => { const s = st(); const d = s.activeId ? s.docs[s.activeId] : null; return d?.kind === "part" ? d as PartDoc : null; };

export function defaultParams(type: string, doc: PartDoc | null): any {
  const s = st(); const sel = s.selection;
  // pick a sketch: selected sketch or latest unconsumed sketch
  let sketchId: string | null = null;
  const selSk = sel.find(x => x.kind === "feature" && doc?.features.find(f => f.id === (x as any).id)?.type === "sketch") as any;
  if (selSk) sketchId = selSk.id;
  else if (doc) { const feats = effectiveFeatures(doc); for (let i = feats.length - 1; i >= 0; i--) { const f = feats[i]; if (f.type === "sketch" && !consumerOf(doc, f.id)) { sketchId = f.id; break; } } }
  const edges: GeoRef[] = sel.filter(x => x.kind === "edge").map((x: any) => ({ kind: "edge", index: x.index, point: x.point }));
  const faces: GeoRef[] = sel.filter(x => x.kind === "face").map((x: any) => ({ kind: "face", index: x.index, point: x.point, normal: x.normal || undefined }));
  const featSel = sel.filter(x => x.kind === "feature").map((x: any) => x.id).filter(id => doc?.features.find(f => f.id === id && f.type !== "sketch"));
  const selPlane = sel.find(x => x.kind === "plane") as any;
  const selFacePlane = sel.find(x => x.kind === "face") as any;
  switch (type) {
    case "extrude": return { sketchId, end: "blind", depth: 10, reverse: false, offset: 0, dir2: { enabled: false, end: "blind", depth: 10 }, draft: { angle: 0, outward: false }, thin: { enabled: false, thickness: 1, side: "fwd" }, merge: true, contours: [] };
    case "cut": return { sketchId, end: "throughAll", depth: 10, reverse: false, offset: 0, dir2: { enabled: false, end: "blind", depth: 10 }, draft: { angle: 0, outward: false }, thin: { enabled: false, thickness: 1, side: "fwd" }, flipSide: false, contours: [] };
    case "revolve": case "revolveCut": { const sk = doc?.features.find(f => f.id === sketchId)?.sketch; const ax = sk?.entities.find(e => e.type === "line" && e.construction); return { sketchId, axis: ax?.id || null, angle: 360, end: "blind", reverse: false, dir2: { enabled: false, angle: 0 }, thin: { enabled: false, thickness: 1, side: "fwd" }, merge: true }; }
    case "sweep": case "sweepCut": return { profileId: sketchId, pathId: null, orient: "follow", merge: true };
    case "loft": case "loftCut": return { profiles: sketchId ? [sketchId] : [], ruled: false, close: false, merge: true };
    case "fillet": return { edges, radius: 5, radius2: 2, ftype: "constant" };
    case "chamfer": return { edges, ctype: "equal", distance: 2, distance2: 3, angle: 45, flip: false };
    case "shell": return { faces, thickness: 2, outward: false };
    case "draft": return { faces: [], neutral: selFacePlane?.normal ? planeFromNormal(selFacePlane.point, selFacePlane.normal) : selPlane?.plane || null, neutralLabel: selFacePlane ? `Face<${selFacePlane.index + 1}>` : selPlane?.id || "", angle: 3, reverse: false };
    case "hole": { const p: any = { plane: null, faceLabel: "", points: [], htype: "cbore", standard: "ISO", size: "M5", fit: "normal", end: "throughAll", depth: 20 }; if (selFacePlane?.normal) { p.plane = planeFromNormal(selFacePlane.point, selFacePlane.normal); p.faceLabel = `Face<${selFacePlane.index + 1}>`; } return { ...p, ...holeDims(p) }; }
    case "linearPattern": return { features: featSel, dir: null, dirLabel: "", spacing: 20, count: 3, reverse: false, dir2: { enabled: false, dir: null, dirLabel: "", spacing: 20, count: 2, reverse: false }, skip: [] };
    case "circularPattern": return { features: featSel, axis: null, axisLabel: "", angle: 360, count: 4, equal: true, reverse: false };
    case "mirror": return { features: featSel, plane: selPlane?.plane || (selFacePlane?.normal ? planeFromNormal(selFacePlane.point, selFacePlane.normal) : null), planeLabel: selPlane?.id || (selFacePlane ? `Face<${selFacePlane.index + 1}>` : "") };
    case "plane": return { base: selPlane?.plane || (selFacePlane?.normal ? planeFromNormal(selFacePlane.point, selFacePlane.normal) : PLANES.Front), baseLabel: selPlane?.id || (selFacePlane ? `Face<${selFacePlane.index + 1}>` : "Front Plane"), offset: 20, flip: false, angle: 0, rotAxis: null };
    case "axis": return { o: [0, 0, 0], d: [0, 1, 0], label: "Y axis" };
  }
  return {};
}

export const PM_BOXES: Record<string, string[]> = {
  extrude: ["sketch"], cut: ["sketch"], revolve: ["sketch", "axis"], revolveCut: ["sketch", "axis"], sweep: ["profile", "path"], sweepCut: ["profile", "path"], loft: ["profiles"], loftCut: ["profiles"],
  fillet: ["edges"], chamfer: ["edges"], shell: ["faces"], draft: ["neutral", "faces"], hole: ["face", "points"], linearPattern: ["features", "dir", "dir2"], circularPattern: ["features", "axis"], mirror: ["plane", "features"], plane: ["base"], axis: ["axisRef"],
  mate: ["mateA", "mateB"], explode: ["comps"], measure: ["items"],
};

export function openFeaturePM(type: string, editId?: string) {
  const s = st(); const doc = partDoc();
  if (s.sketch && type !== "sketchTool") s.exitSketch(true);
  if (!doc && !["mate", "insertComp", "explode", "moveComp", "rotateComp", "measure"].includes(type)) return;
  let draft: Feature; let index: number;
  if (editId && doc) {
    const f = doc.features.find(x => x.id === editId)!; draft = JSON.parse(JSON.stringify(f)); index = doc.features.indexOf(f);
  } else {
    const d = doc || (s.docs[s.activeId!] as any);
    const [name] = nextName(d, type);
    draft = { id: uid("f"), type: type as any, name, params: defaultParams(type, doc) };
    index = doc ? (doc.rollback ?? doc.features.length) : 0;
  }
  let box = (PM_BOXES[type] || [])[0];
  if (["extrude", "cut", "revolve", "revolveCut"].includes(type) && draft.params.sketchId) box = type.startsWith("revolve") ? "axis" : "";
  if ((type === "sweep" || type === "sweepCut") && draft.params.profileId) box = "path";
  if (type === "fillet" || type === "chamfer") box = "edges";
  if (type === "hole" && draft.params.plane) box = "points";
  if (type === "mirror" && draft.params.plane) box = "features";
  const pm: PMState = { type, editId, draft, index, box };
  useApp.setState({ pm, selection: [], status: pmHint(pm) });
}
export function pmHint(pm: PMState): string {
  const h: Record<string, string> = { sketch: "Select a sketch (in the tree or graphics area)", axis: "Select a centerline / axis", profile: "Select the profile sketch", path: "Select the path sketch", profiles: "Select profile sketches in order", edges: "Select edges", faces: pm.type === "shell" ? "Select faces to remove" : "Select faces", neutral: "Select the neutral plane / face", face: "Select a planar face for hole placement", points: "Click on the face to place hole centers", features: "Select features to pattern / mirror (in tree)", dir: "Select a linear edge or axis for Direction 1", dir2: "Select a linear edge for Direction 2", plane: "Select a mirror plane / planar face", base: "Select a reference plane or planar face", mateA: "Select the first entity (face/edge) on a component", mateB: "Select the second entity on another component", comps: "Select components to explode" };
  return h[pm.box || ""] || `${pm.draft.name}: set parameters, then ✔`;
}
export function updateDraft(fn: (p: any) => any) { const pm = st().pm; if (!pm) return; useApp.setState({ pm: { ...pm, draft: { ...pm.draft, params: fn({ ...pm.draft.params }) } } }); }
export function setBox(box: string) { const pm = st().pm; if (!pm) return; const n = { ...pm, box }; useApp.setState({ pm: n, status: pmHint(n) }); }

const geoRef = (s: Sel): GeoRef | null => s.kind === "edge" ? { kind: "edge", index: s.index, point: s.point } : s.kind === "face" ? { kind: "face", index: s.index, point: s.point, normal: s.normal || undefined } : null;
const toggleRef = (list: GeoRef[], r: GeoRef) => list.some(x => x.kind === r.kind && x.index === r.index) ? list.filter(x => !(x.kind === r.kind && x.index === r.index)) : [...list, r];

function planeOfSel(s: Sel): { plane: PlaneDef; label: string } | null {
  const b = st().builds[st().activeId!];
  if (s.kind === "plane") return { plane: s.plane, label: s.plane.name || s.id };
  if (s.kind === "face") { const f = b?.main?.faces[s.index]; if (f?.type === "PLANE" && f.normal) return { plane: planeFromNormal(f.center, f.normal), label: `Face<${s.index + 1}>` }; }
  return null;
}
function dirOfSel(s: Sel): { d: Vec3; o: Vec3; label: string } | null {
  const b = st().builds[st().activeId!];
  if (s.kind === "edge") { const e = b?.main?.edges[s.index]; if (e?.a && e.b && e.type === "LINE") return { d: norm(sub(e.b, e.a)), o: e.a, label: `Edge<${s.index + 1}>` }; if (e?.circle) return { d: e.circle.n, o: e.circle.c, label: `Edge<${s.index + 1}> axis` }; }
  if (s.kind === "axis") return { d: s.axis.d, o: s.axis.o, label: st().docs[st().activeId!] && (partDoc()?.features.find(f => f.id === s.id)?.name || "Axis") };
  if (s.kind === "face") { const f = b?.main?.faces[s.index]; if (f?.axis) return { d: f.axis.d, o: f.axis.o, label: `Face<${s.index + 1}> axis` }; if (f?.normal && f.type === "PLANE") return { d: f.normal, o: f.center, label: `Face<${s.index + 1}> normal` }; }
  if (s.kind === "plane") return { d: s.plane.n, o: s.plane.origin, label: `${s.plane.name || s.id} normal` };
  return null;
}

/** Route a viewport/tree selection into the active PM. Returns true if consumed. */
export function pmPick(s: Sel, _additive: boolean): boolean {
  const pm = st().pm; if (!pm) return false; const box = pm.box; const doc = partDoc();
  const isSketch = (id: string) => doc?.features.find(f => f.id === id)?.type === "sketch";
  const p = pm.draft.params;
  const done = (np: any, nextBox?: string) => { const n = { ...pm, draft: { ...pm.draft, params: np }, box: nextBox ?? pm.box }; useApp.setState({ pm: n, status: pmHint(n) }); return true; };
  switch (box) {
    case "sketch": if (s.kind === "feature" && isSketch(s.id)) { const np = { ...p, sketchId: s.id }; if (pm.type.startsWith("revolve")) { const sk = doc!.features.find(f => f.id === s.id)!.sketch!; np.axis = sk.entities.find(e => e.type === "line" && e.construction)?.id || null; return done(np, "axis"); } return done(np, ""); } return false;
    case "profile": if (s.kind === "feature" && isSketch(s.id)) return done({ ...p, profileId: s.id }, "path"); return false;
    case "path": if (s.kind === "feature" && isSketch(s.id)) return done({ ...p, pathId: s.id }, ""); return false;
    case "profiles": if (s.kind === "feature" && isSketch(s.id)) return done({ ...p, profiles: p.profiles.includes(s.id) ? p.profiles.filter((x: string) => x !== s.id) : [...p.profiles, s.id] }); return false;
    case "edges": { if (s.kind === "edge") return done({ ...p, edges: toggleRef(p.edges, geoRef(s)!) }); if (s.kind === "face") { // add all edges bounding the face (approximation by mesh adjacency)
        const b = st().builds[st().activeId!]?.main; if (!b) return false; const fg = b.faceGroups.find(g => g.faceId === s.index); if (!fg) return false;
        const vs = new Set<string>(); for (let i = fg.start; i < fg.start + fg.count; i++) { const k = b.triangles[i]; vs.add(`${b.vertices[k * 3].toFixed(3)},${b.vertices[k * 3 + 1].toFixed(3)},${b.vertices[k * 3 + 2].toFixed(3)}`); }
        let edges = p.edges as GeoRef[];
        for (const g of b.edgeGroups) { let all = true; for (let i = g.start; i < g.start + g.count; i++) { const k = `${b.lines[i * 3].toFixed(3)},${b.lines[i * 3 + 1].toFixed(3)},${b.lines[i * 3 + 2].toFixed(3)}`; if (!vs.has(k)) { all = false; break; } } if (all) { const info = b.edges[g.edgeId]; if (info && !edges.some(e => e.index === g.edgeId)) edges = [...edges, { kind: "edge", index: g.edgeId, point: info.mid }]; } }
        return done({ ...p, edges }); } return false; }
    case "faces": if (s.kind === "face") return done({ ...p, faces: toggleRef(p.faces, geoRef(s)!) }); return false;
    case "neutral": { const r = planeOfSel(s); if (r) return done({ ...p, neutral: r.plane, neutralLabel: r.label }, "faces"); return false; }
    case "face": { if (s.kind === "face") { const r = planeOfSel(s); if (r) return done({ ...p, plane: r.plane, faceLabel: r.label, points: [] }, "points"); st().setStatus("Hole placement requires a planar face"); return true; } return false; }
    case "points": return false; // handled by viewport click on face (see holeClick)
    case "features": if (s.kind === "feature" && !isSketch(s.id)) return done({ ...p, features: p.features.includes(s.id) ? p.features.filter((x: string) => x !== s.id) : [...p.features, s.id] }); return false;
    case "dir": { const r = dirOfSel(s); if (r) return done({ ...p, dir: r.d, dirLabel: r.label }, "features"); return false; }
    case "dir2": { const r = dirOfSel(s); if (r) return done({ ...p, dir2: { ...p.dir2, enabled: true, dir: r.d, dirLabel: r.label } }, "features"); return false; }
    case "axis": {
      if (pm.type === "circularPattern") { const r = dirOfSel(s); if (r) return done({ ...p, axis: { o: r.o, d: r.d }, axisLabel: r.label, axisRef: s.kind === "axis" ? s.id : undefined }, "features"); return false; }
      if (s.kind === "sk") return done({ ...p, axis: s.id }, ""); return false;
    }
    case "plane": { const r = planeOfSel(s); if (r) return done({ ...p, plane: r.plane, planeLabel: r.label }, "features"); return false; }
    case "base": { const r = planeOfSel(s); if (r) return done({ ...p, base: r.plane, baseLabel: r.label, refPlane: s.kind === "plane" && !["Front", "Top", "Right"].includes(s.id) ? s.id : undefined }); if (s.kind === "edge") { const d = dirOfSel(s); if (d) return done({ ...p, rotAxis: { o: d.o, d: d.d }, rotAxisLabel: d.label, angle: p.angle || 45 }); } return false; }
    case "axisRef": { const r = dirOfSel(s); if (r) return done({ ...p, o: r.o, d: r.d, label: r.label }); return false; }
    case "mateA": case "mateB": {
      if ((s.kind === "face" || s.kind === "edge") && s.comp) { const ref = { comp: s.comp, face: s.index, kind: s.kind }; const np = { ...p, [box === "mateA" ? "a" : "b"]: ref }; if (box === "mateA") return done(np, "mateB"); const n = done(np, ""); suggestMateType(); return n; }
      return false;
    }
    case "comps": if (s.kind === "comp" || (s as any).comp) { const id = s.kind === "comp" ? s.id : (s as any).comp; return done({ ...p, comps: p.comps.includes(id) ? p.comps.filter((x: string) => x !== id) : [...p.comps, id] }); } return false;
    case "items": { const items = [...(p.items || []), s].slice(-2); return done({ ...p, items }); }
  }
  return false;
}
pmBus.pick = pmPick;

function suggestMateType() {
  const pm = st().pm!; const p = pm.draft.params; const asm = st().docs[st().activeId!] as AssemblyDoc;
  const ga = p.a && geoOfRef(asm, p.a), gb = p.b && geoOfRef(asm, p.b);
  const allowed = allowedMates(ga, gb);
  let type: MateType = allowed[0];
  if (ga?.kind === "axis" && gb?.kind === "axis") type = "concentric";
  updateDraft(q => ({ ...q, mtype: allowed.includes(q.mtype) && q.userPicked ? q.mtype : type, allowed }));
  previewMate();
}
export function geoOfRef(asm: AssemblyDoc, ref: any) { const c = asm.components.find(x => x.id === ref.comp); if (!c) return null; return localGeo(st().builds[c.partId], ref); }

/** live mate preview: apply mates incl. draft */
export function previewMate() {
  const s = st(); const pm = s.pm; if (!pm || pm.type !== "mate") return; const p = pm.draft.params; if (!p.a || !p.b) return;
  const asm = pm.extra?.base as AssemblyDoc; if (!asm) return;
  const m: Mate = { id: "__draft", name: "draft", type: p.mtype, a: p.a, b: p.b, value: p.value, flip: p.flip };
  if (m.type === "lock") { const ca = asm.components.find(c => c.id === p.a.comp)!, cb = asm.components.find(c => c.id === p.b.comp)!; (m as any).rel = relTransform(ca.t, cb.t); }
  const res = solveMates({ ...asm, mates: [...asm.mates, m] }, s.builds);
  s.updateDoc(s.activeId!, () => ({ ...res.asm, mates: asm.mates }), false);
}

export function holeClick(world: Vec3) {
  const pm = st().pm; if (!pm || pm.type !== "hole" || pm.box !== "points" || !pm.draft.params.plane) return false;
  const pl: PlaneDef = pm.draft.params.plane; const r = sub(world, pl.origin);
  const uv: [number, number] = [r[0] * pl.x[0] + r[1] * pl.x[1] + r[2] * pl.x[2], r[0] * pl.y[0] + r[1] * pl.y[1] + r[2] * pl.y[2]];
  updateDraft(p => ({ ...p, points: [...p.points, uv] })); return true;
}

export function pmConfirm(keepOpen = false) {
  const s = st(); const pm = s.pm; if (!pm) return; const id = s.activeId!;
  if (pm.type === "mate") return confirmMate(keepOpen);
  if (pm.type === "explode") { const p = pm.draft.params; if (p.comps?.length) s.updateDoc(id, (d: AssemblyDoc) => ({ ...d, explode: [...d.explode, { id: uid("x"), comps: p.comps, dir: p.dir, dist: p.dist }], exploded: true })); if (keepOpen) { updateDraft(q => ({ ...q, comps: [] })); return; } useApp.setState({ pm: null, status: "Ready" }); return; }
  if (pm.type === "moveComp" || pm.type === "rotateComp" || pm.type === "insertComp" || pm.type === "measure") { useApp.setState({ pm: null, status: "Ready" }); return; }
  const doc = partDoc(); if (!doc) return;
  const err = s.preview?.errors?.[pm.draft.id];
  if (err && !pm.editId) { s.showToast(`Cannot create ${pm.draft.name}: ${err}`); return; }
  if (pm.editId) {
    s.updateDoc(id, (d: PartDoc) => ({ ...d, features: d.features.map(f => f.id === pm.editId ? { ...pm.draft } : f) }));
  } else {
    insertFeature(id, { ...pm.draft, name: undefined } as any, pm.type);
  }
  useApp.setState({ pm: keepOpen ? { ...pm, editId: undefined, draft: { ...pm.draft, id: uid("f"), params: defaultParams(pm.type, partDoc()) } } : null, preview: null, selection: [], status: `${pm.draft.name} ${pm.editId ? "updated" : "created"}` });
}
export function pmCancel() {
  const s = st(); const pm = s.pm;
  if (pm?.type === "mate" && pm.extra?.base) s.updateDoc(s.activeId!, () => pm.extra.base, false);
  if ((pm?.type === "moveComp" || pm?.type === "rotateComp") && pm.extra?.base) s.updateDoc(s.activeId!, () => pm.extra.base, false);
  useApp.setState({ pm: null, preview: null, status: "Ready" });
}

// ───── assembly PMs
export function openMatePM() {
  const s = st(); const asm = s.docs[s.activeId!] as AssemblyDoc;
  const pre = s.selection.filter(x => (x.kind === "face" || x.kind === "edge") && (x as any).comp) as any[];
  const params: any = { a: pre[0] ? { comp: pre[0].comp, face: pre[0].index, kind: pre[0].kind } : null, b: pre[1] ? { comp: pre[1].comp, face: pre[1].index, kind: pre[1].kind } : null, mtype: "coincident", value: 10, flip: false, allowed: null };
  useApp.setState({ pm: { type: "mate", draft: { id: uid("m"), type: "sketch", name: "Mate", params }, index: 0, box: params.a ? (params.b ? "" : "mateB") : "mateA", extra: { base: asm } }, selection: [], status: "Select two entities to mate" });
  if (params.a && params.b) suggestMateType();
}
function confirmMate(keepOpen: boolean) {
  const s = st(); const pm = s.pm!; const p = pm.draft.params; const base = pm.extra.base as AssemblyDoc;
  if (!p.a || !p.b) { if (!keepOpen) useApp.setState({ pm: null }); return; }
  if (p.a.comp === p.b.comp) { s.showToast("Select entities on two different components"); return; }
  const n = (base.counters[p.mtype] || 0) + 1; const label = p.mtype[0].toUpperCase() + p.mtype.slice(1);
  const m: Mate = { id: uid("m"), name: `${label}${n}`, type: p.mtype, a: p.a, b: p.b, value: ["distance", "angle"].includes(p.mtype) ? p.value : undefined, flip: p.flip };
  if (m.type === "lock") { const ca = base.components.find(c => c.id === p.a.comp)!, cb = base.components.find(c => c.id === p.b.comp)!; (m as any).rel = relTransform(ca.t, cb.t); }
  const withMate = { ...base, mates: [...base.mates, m], counters: { ...base.counters, [p.mtype]: n } };
  const res = solveMates(withMate, s.builds);
  // restore base for undo recording, then record
  s.updateDoc(s.activeId!, () => base, false);
  s.updateDoc(s.activeId!, () => res.asm, true);
  if (res.status[m.id] === "error") s.showToast(`${m.name}: mate could not be satisfied (conflicting / over-defined)`);
  if (keepOpen) useApp.setState({ pm: { ...pm, draft: { ...pm.draft, params: { ...p, a: null, b: null, allowed: null, userPicked: false } }, box: "mateA", extra: { base: res.asm } } });
  else useApp.setState({ pm: null, status: `${m.name} added` });
}
export function resolveAssembly() { const s = st(); const asm = s.docs[s.activeId!] as AssemblyDoc; if (asm?.kind !== "assembly") return; const res = solveMates(asm, s.builds); s.updateDoc(asm.id, () => res.asm, false); return res; }

let dragBase: AssemblyDoc | null = null;
pmBus.dragComp = (compId, dx, dy, mode) => {
  const s = st(); const e = pmBus.engine; const asm = s.docs[s.activeId!] as AssemblyDoc; if (!e || asm?.kind !== "assembly") return;
  if (!dragBase) dragBase = asm;
  const { r, u } = e.camAxes(); const wpp = e.worldPerPixel();
  const comps = asm.components.map(c => {
    if (c.id !== compId) return c;
    if (mode === "rotate") { const q1 = qFromAxisAngle([u.x, u.y, u.z], dx * 0.01), q2 = qFromAxisAngle([r.x, r.y, r.z], dy * 0.01); const q = qMul(q1, qMul(q2, c.t.q as any)); return { ...c, t: { p: c.t.p, q } }; }
    return { ...c, t: { p: add(c.t.p, [r.x * dx * wpp - u.x * dy * wpp, r.y * dx * wpp - u.y * dy * wpp, r.z * dx * wpp - u.z * dy * wpp]), q: c.t.q } };
  });
  let nd = { ...asm, components: comps };
  if (nd.mates.length) nd = solveMates(nd, s.builds, 20).asm;
  s.updateDoc(asm.id, () => nd, false);
};
pmBus.dragEnd = () => { const s = st(); const asm = s.docs[s.activeId!] as AssemblyDoc; if (!dragBase || asm?.kind !== "assembly") return; const base = dragBase; dragBase = null; s.updateDoc(asm.id, () => base, false); s.updateDoc(asm.id, () => asm, true); };
