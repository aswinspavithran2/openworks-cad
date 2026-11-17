import { useApp, effectiveFeatures, childrenOf, insertFeature, newPart, newAssembly, type Sel } from "../store";
import type { PartDoc, AssemblyDoc, DrawingDoc, Doc, Feature, Sketch, SkEntity } from "../types";
import { kernel } from "../kernel/client";
import { openFeaturePM, openMatePM, resolveAssembly } from "./pm";
import { planeFromNormal, uid, toWorld } from "../math";
import { sampleEntity, arcAngles, offsetEntities, chainFrom } from "../sketch/geom";
import { MATERIALS } from "./materials";

const st = () => useApp.getState();
const active = () => { const s = st(); return s.activeId ? s.docs[s.activeId] : null; };
const part = () => { const d = active(); return d?.kind === "part" ? d as PartDoc : null; };

export function download(name: string, data: BlobPart, type = "application/octet-stream") {
  const url = URL.createObjectURL(new Blob([data], { type })); const a = document.createElement("a"); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 4000);
}
function pickFile(accept: string): Promise<File | null> {
  return new Promise(res => { const i = document.createElement("input"); i.type = "file"; i.accept = accept; i.onchange = () => res(i.files?.[0] || null); i.click(); });
}
const ext = (d: Doc) => d.kind === "part" ? "cpart" : d.kind === "assembly" ? "casm" : "cdrw";

export function startSketchCmd() {
  const s = st(); if (s.sketch) return s.exitSketch(true);
  if (!part()) return;
  const sel = s.selection[0];
  if (sel?.kind === "plane") return s.startSketch(sel.plane, sel.plane.name || sel.id);
  if (sel?.kind === "face") { const info = s.builds[s.activeId!]?.main?.faces[sel.index]; if (info?.type === "PLANE" && info.normal) return s.startSketch(planeFromNormal(info.center, info.normal, `Face<${sel.index + 1}>`), `Face<${sel.index + 1}>`); }
  useApp.setState({ pendingPick: "sketchPlane", pm: null, status: "Select a plane or planar face on which to create a sketch" });
}

export function editSketch(fid: string) { const p = part(); const f = p?.features.find(x => x.id === fid); if (!f?.sketch) return; st().startSketch(f.sketch.plane, f.sketch.planeLabel, fid); }
export function editFeature(fid: string) { const p = part(); const f = p?.features.find(x => x.id === fid); if (!f) return; if (f.type === "sketch") return editSketch(fid); openFeaturePM(f.type, fid); }

export function deleteFeatures(ids: string[]) {
  const s = st(); const p = part(); if (!p) return;
  const kids = new Set<string>(); ids.forEach(id => childrenOf(p, id).forEach(k => kids.add(k)));
  ids.forEach(id => kids.delete(id));
  const names = (arr: string[]) => arr.map(id => p.features.find(f => f.id === id)?.name).join(", ");
  useApp.setState({ dialog: { name: "confirmDelete", data: { ids, kids: [...kids], text: `Delete ${names(ids)}?`, kidText: kids.size ? `Dependent features: ${names([...kids])}` : "" } } });
  void s;
}
export function doDelete(ids: string[], withKids: boolean, kids: string[]) {
  const s = st(); const del = new Set([...ids, ...(withKids ? kids : [])]);
  s.updateDoc(s.activeId!, (d: PartDoc) => {
    const features = d.features.filter(f => !del.has(f.id));
    const rb = d.rollback === null ? null : Math.min(d.rollback, features.length);
    return { ...d, features, rollback: rb };
  });
  useApp.setState({ selection: [], dialog: null, pm: null });
}
export function setSuppressed(ids: string[], v: boolean, withDeps = true) {
  const s = st(); const p = part(); if (!p) return;
  const all = new Set(ids); if (withDeps) { let grow = true; while (grow) { grow = false; for (const id of [...all]) for (const k of childrenOf(p, id)) if (!all.has(k)) { all.add(k); grow = true; } } }
  s.updateDoc(p.id, (d: PartDoc) => ({ ...d, configs: d.configs.map(c => c.id === d.activeConfig ? { ...c, suppressed: { ...c.suppressed, ...Object.fromEntries([...all].map(id => [id, v])) } } : c) }));
}
export function isSuppressed(p: PartDoc, f: Feature) { const c = p.configs.find(x => x.id === p.activeConfig); return c?.suppressed[f.id] ?? !!f.suppressed; }

// ───────── file ops
export async function openFile() {
  const f = await pickFile(".cpart,.casm,.cdrw,.json"); if (!f) return;
  try { const bundle = JSON.parse(await f.text()); loadBundle(bundle); } catch (e) { st().showToast("Could not open file: " + (e as Error).message); }
}
export function loadBundle(bundle: any) {
  const s = st(); const main: Doc = bundle.doc || bundle; const deps: Doc[] = bundle.deps || [];
  for (const d of deps) if (!s.docs[d.id]) s.addDoc(d, false);
  s.addDoc(main, true); useApp.setState({ cmTab: main.kind === "part" ? "Features" : main.kind === "assembly" ? "Assembly" : "View Layout" });
}
export function saveAs() {
  const s = st(); const d = active(); if (!d) return;
  const deps: Doc[] = [];
  if (d.kind === "assembly") for (const c of d.components) { const p = s.docs[c.partId]; if (p && !deps.includes(p)) deps.push(p); }
  if (d.kind === "drawing" && d.sourceId && s.docs[d.sourceId]) { const src = s.docs[d.sourceId]; deps.push(src); if (src.kind === "assembly") for (const c of src.components) { const p = s.docs[c.partId]; if (p && !deps.includes(p)) deps.push(p); } }
  download(`${d.name}.${ext(d)}`, JSON.stringify({ format: "openworks", version: 1, doc: d, deps }, null, 1), "application/json");
  s.saveDoc(d.id);
}
function asmPayload(a: AssemblyDoc) { const s = st(); return a.components.filter(c => !c.hidden).map(c => ({ features: effectiveFeatures(s.docs[c.partId] as PartDoc), t: c.t })); }
export async function exportAs(fmt: string) {
  const s = st(); const d = active(); if (!d) return;
  try {
    if (fmt === "png") return s.cmd("screenshot");
    if (fmt === "dxf") {
      if (d.kind === "drawing") return window.dispatchEvent(new CustomEvent("cad:drawingExport", { detail: "dxf" }));
      const sk = s.sketch?.sk || (part()?.features.find(f => f.id === (s.selection[0] as any)?.id)?.sketch) || [...(part()?.features || [])].reverse().find(f => f.sketch)?.sketch;
      if (!sk) return s.showToast("Select a sketch to export as DXF");
      return download(`${d.name}.dxf`, sketchToDXF(sk), "application/dxf");
    }
    if (fmt === "svg" || fmt === "pdf") { if (d.kind === "drawing") return window.dispatchEvent(new CustomEvent("cad:drawingExport", { detail: fmt })); return s.showToast("SVG/PDF export is available from Drawing documents"); }
    if (fmt === "iges") { s.showToast("IGES writer is not included in this kernel build — exporting STEP (AP214) instead"); fmt = "step"; }
    if (d.kind === "drawing") return s.showToast("Use SVG / PDF / DXF export for drawings");
    useApp.setState({ status: `Exporting ${fmt.toUpperCase()}…` });
    if (fmt === "obj") return exportOBJ(d);
    const buf = d.kind === "assembly" ? await kernel.exportShape(fmt as any, null, asmPayload(d)) : await kernel.exportShape(fmt as any, effectiveFeatures(d as PartDoc));
    download(`${d.name}.${fmt === "step" ? "step" : "stl"}`, buf, fmt === "step" ? "application/step" : "model/stl");
    useApp.setState({ status: `Exported ${d.name}.${fmt}` });
  } catch (e) { s.showToast("Export failed: " + (e as Error).message); }
}
function exportOBJ(d: Doc) {
  const s = st(); const lines: string[] = ["# OpenWorks CAD OBJ export", `o ${d.name}`]; let off = 1;
  const add = (m: any, t?: { p: number[]; q: number[] }) => {
    const V = m.vertices, N = m.normals, T = m.triangles;
    const tf = (x: number, y: number, z: number) => { if (!t) return [x, y, z]; const [qx, qy, qz, qw] = t.q; const ix = qw * x + qy * z - qz * y, iy = qw * y + qz * x - qx * z, iz = qw * z + qx * y - qy * x, iw = -qx * x - qy * y - qz * z; return [ix * qw + iw * -qx + iy * -qz - iz * -qy + t.p[0], iy * qw + iw * -qy + iz * -qx - ix * -qz + t.p[1], iz * qw + iw * -qz + ix * -qy - iy * -qx + t.p[2]]; };
    for (let i = 0; i < V.length; i += 3) lines.push(`v ${tf(V[i], V[i + 1], V[i + 2]).map(v => v.toFixed(5)).join(" ")}`);
    for (let i = 0; i < N.length; i += 3) lines.push(`vn ${N[i].toFixed(4)} ${N[i + 1].toFixed(4)} ${N[i + 2].toFixed(4)}`);
    for (let i = 0; i < T.length; i += 3) { const a = T[i] + off, b = T[i + 1] + off, c = T[i + 2] + off; lines.push(`f ${a}//${a} ${b}//${b} ${c}//${c}`); }
    off += V.length / 3;
  };
  if (d.kind === "part") { const m = s.builds[d.id]?.main; if (!m) return s.showToast("Nothing to export"); add(m); }
  else if (d.kind === "assembly") for (const c of d.components) { const m = s.builds[c.partId]?.main; if (m) { lines.push(`g ${c.name}`); add(m, c.t as any); } }
  download(`${d.name}.obj`, lines.join("\n"), "model/obj"); useApp.setState({ status: `Exported ${d.name}.obj` });
}
export function sketchToDXF(sk: Sketch): string {
  const out: string[] = ["0", "SECTION", "2", "ENTITIES"];
  const P = (id: string) => sk.points[id];
  for (const e of sk.entities) {
    const layer = e.construction ? "CONSTRUCTION" : "0";
    if (e.type === "line") out.push("0", "LINE", "8", layer, "10", String(P(e.p1).x), "20", String(P(e.p1).y), "30", "0", "11", String(P(e.p2).x), "21", String(P(e.p2).y), "31", "0");
    else if (e.type === "circle") out.push("0", "CIRCLE", "8", layer, "10", String(P(e.c).x), "20", String(P(e.c).y), "30", "0", "40", String(e.r));
    else if (e.type === "arc") { const { c, r, a1, sw } = arcAngles(sk, e); out.push("0", "ARC", "8", layer, "10", String(c[0]), "20", String(c[1]), "30", "0", "40", String(r), "50", String(a1 * 180 / Math.PI), "51", String((a1 + sw) * 180 / Math.PI)); }
    else if (e.type !== "point") { const pts = sampleEntity(sk, e, 64); for (let i = 0; i < pts.length - 1; i++) out.push("0", "LINE", "8", layer, "10", String(pts[i][0]), "20", String(pts[i][1]), "30", "0", "11", String(pts[i + 1][0]), "21", String(pts[i + 1][1]), "31", "0"); }
  }
  out.push("0", "ENDSEC", "0", "EOF"); return out.join("\n");
}
export async function importFile(fmt: string) {
  const s = st(); const f = await pickFile(fmt === "step" ? ".step,.stp" : fmt === "stl" ? ".stl" : fmt === "obj" ? ".obj" : ".dxf"); if (!f) return;
  let buf: Uint8Array = new Uint8Array(await f.arrayBuffer()); let format = fmt;
  if (fmt === "dxf") return importDXF(new TextDecoder().decode(buf), f.name);
  if (fmt === "obj") { buf = objToStl(new TextDecoder().decode(buf)); format = "stl"; }
  let doc = part(); if (!doc) { const d = newPart(f.name.replace(/\.[^.]+$/, "")); s.addDoc(d, true); doc = d; }
  let bin = ""; const CH = 0x8000; for (let i = 0; i < buf.length; i += CH) bin += String.fromCharCode.apply(null, Array.from(buf.subarray(i, i + CH)));
  insertFeature(doc.id, { type: "import", params: { format, data: btoa(bin), file: f.name } } as any);
  useApp.setState({ status: `Imported ${f.name}` });
}
function objToStl(txt: string): Uint8Array<ArrayBuffer> {
  const v: number[][] = []; const tris: number[][] = [];
  for (const line of txt.split(/\r?\n/)) { const p = line.trim().split(/\s+/); if (p[0] === "v") v.push(p.slice(1, 4).map(Number)); else if (p[0] === "f") { const idx = p.slice(1).map(x => { const i = parseInt(x.split("/")[0]); return i < 0 ? v.length + i : i - 1; }); for (let k = 1; k < idx.length - 1; k++) tris.push([idx[0], idx[k], idx[k + 1]]); } }
  const out = new DataView(new ArrayBuffer(84 + tris.length * 50)); out.setUint32(80, tris.length, true);
  tris.forEach((t, i) => { const o = 84 + i * 50; t.forEach((vi, k) => { const p = v[vi] || [0, 0, 0]; out.setFloat32(o + 12 + k * 12, p[0], true); out.setFloat32(o + 16 + k * 12, p[1], true); out.setFloat32(o + 20 + k * 12, p[2], true); }); });
  return new Uint8Array(out.buffer);
}
function importDXF(txt: string, name: string) {
  const s = st(); let doc = part(); if (!doc) { const d = newPart(name.replace(/\.[^.]+$/, "")); s.addDoc(d, true); doc = d; }
  const codes = txt.split(/\r?\n/).map(x => x.trim()); const sk: Sketch = { id: uid("sk"), plane: { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], n: [0, 0, 1], name: "Front Plane" }, planeLabel: "Front Plane", points: { O: { id: "O", x: 0, y: 0, fixed: true } }, entities: [], constraints: [] };
  const pt = (x: number, y: number) => { for (const k in sk.points) { const p = sk.points[k]; if (Math.hypot(p.x - x, p.y - y) < 1e-6) return k; } const id = uid("p"); sk.points[id] = { id, x, y }; return id; };
  for (let i = 0; i < codes.length - 1; i += 2) {
    if (codes[i] !== "0") continue; const type = codes[i + 1]; const g: Record<string, number> = {}; let j = i + 2;
    while (j < codes.length - 1 && codes[j] !== "0") { g[codes[j]] = parseFloat(codes[j + 1]); j += 2; }
    if (type === "LINE") sk.entities.push({ id: uid("e"), type: "line", p1: pt(g["10"], g["20"]), p2: pt(g["11"], g["21"]) });
    if (type === "CIRCLE") sk.entities.push({ id: uid("e"), type: "circle", c: pt(g["10"], g["20"]), r: g["40"] });
    if (type === "ARC") { const c = [g["10"], g["20"]], r = g["40"], a1 = g["50"] * Math.PI / 180, a2 = g["51"] * Math.PI / 180; sk.entities.push({ id: uid("e"), type: "arc", c: pt(c[0], c[1]), p1: pt(c[0] + r * Math.cos(a1), c[1] + r * Math.sin(a1)), p2: pt(c[0] + r * Math.cos(a2), c[1] + r * Math.sin(a2)) }); }
  }
  insertFeature(doc.id, { type: "sketch", sketch: sk, params: {} } as any);
  s.showToast(`Imported ${sk.entities.length} entities from ${name} into a sketch on the Front Plane`);
}

// ───────── sketch edit ops (PM driven)
export function sketchSelected(): string[] { return st().selection.filter(x => x.kind === "sk").map(x => (x as any).id).filter(id => st().sketch?.sk.entities.some(e => e.id === id)); }
export function sketchOffset() {
  const s = st(); const ss = s.sketch; if (!ss) return; let ids = sketchSelected(); if (!ids.length) return s.showToast("Select sketch entities to offset");
  if (ids.length === 1) ids = chainFrom(ss.sk, ids[0]);
  const d = ss.toolOpts.offset * (ss.toolOpts.reverse ? -1 : 1);
  let sk = offsetEntities(ss.sk, ids, d, ss.toolOpts.construction);
  if ((ss.toolOpts as any).bidirectional) sk = offsetEntities(sk, ids, -d, ss.toolOpts.construction);
  s.skSet(sk, { force: true }); s.showToast("Offset applied");
}
export function transformSketch(kind: "move" | "copy" | "rotate" | "scale" | "mirror" | "linear" | "circular", p: any) {
  const s = st(); const ss = s.sketch; if (!ss) return; const ids = sketchSelected();
  const sk: Sketch = { ...ss.sk, points: { ...ss.sk.points }, entities: ss.sk.entities.slice(), constraints: ss.sk.constraints.slice() };
  let ents = sk.entities.filter(e => ids.includes(e.id));
  if (kind === "mirror") { const axis = ents.find(e => e.id === p.axis) || sk.entities.find(e => e.id === p.axis); ents = ents.filter(e => e.id !== p.axis); if (!axis || axis.type !== "line") return s.showToast("Select a line / centerline to mirror about (last selected)"); p.axisLine = axis; }
  if (!ents.length) return s.showToast("Select sketch entities first");
  const ptIds = new Set<string>(); ents.forEach(e => entPts(e).forEach(x => ptIds.add(x)));
  const mapPoint = (fn: (x: number, y: number) => [number, number], copy: boolean, suffix = "") => {
    const map: Record<string, string> = {};
    for (const id of ptIds) { const q = sk.points[id]; const [x, y] = fn(q.x, q.y); if (copy || id === "O") { const nid = uid("p" + suffix); sk.points[nid] = { id: nid, x, y }; map[id] = nid; } else { sk.points[id] = { ...q, x, y }; map[id] = id; } }
    return map;
  };
  const cloneEnts = (map: Record<string, string>, sc = 1) => ents.map(e => remap(e, map, sc));
  if (kind === "move" || kind === "copy") { const m = mapPoint((x, y) => [x + p.dx, y + p.dy], kind === "copy"); if (kind === "copy") sk.entities.push(...cloneEnts(m)); else { stripFix(sk, ptIds); } }
  else if (kind === "rotate") { const a = p.angle * Math.PI / 180, cx = p.cx || 0, cy = p.cy || 0; const m = mapPoint((x, y) => [cx + (x - cx) * Math.cos(a) - (y - cy) * Math.sin(a), cy + (x - cx) * Math.sin(a) + (y - cy) * Math.cos(a)], !!p.copy); if (p.copy) sk.entities.push(...cloneEnts(m)); else { stripHV(sk, ents); } }
  else if (kind === "scale") { const f = p.factor || 1, cx = p.cx || 0, cy = p.cy || 0; const m = mapPoint((x, y) => [cx + (x - cx) * f, cy + (y - cy) * f], !!p.copy); if (p.copy) sk.entities.push(...cloneEnts(m, f)); else sk.entities = sk.entities.map(e => ids.includes(e.id) && (e.type === "circle" || e.type === "ellipse") ? scaleEnt(e, f) : e); sk.constraints = sk.constraints.filter(c => !(c.value !== undefined && c.refs.some(r => ids.includes(r) || ptIds.has(r)))); }
  else if (kind === "mirror") {
    const L = p.axisLine; const a = sk.points[L.p1], b = sk.points[L.p2]; const dx = b.x - a.x, dy = b.y - a.y; const l2 = dx * dx + dy * dy;
    const m = mapPoint((x, y) => { const t = ((x - a.x) * dx + (y - a.y) * dy) / l2; const fx = a.x + t * dx, fy = a.y + t * dy; return [2 * fx - x, 2 * fy - y]; }, true);
    const copies = ents.map(e => { const r = remap(e, m); if (r.type === "arc") return { ...r, p1: r.p2, p2: r.p1 }; return r; });
    sk.entities.push(...copies);
    for (const id of ptIds) if (m[id] && id !== m[id] && !(ents.some(e => (e as any).c === id) && false)) sk.constraints.push({ id: uid("c"), type: "symmetric", refs: [id, m[id], L.id] });
  }
  else if (kind === "linear") { for (let i = 1; i < (p.count || 2); i++) { const m = mapPoint((x, y) => [x + p.dx * i, y + p.dy * i], true, String(i)); sk.entities.push(...cloneEnts(m)); } }
  else if (kind === "circular") { const n = p.count || 4; for (let i = 1; i < n; i++) { const a = (p.angle ?? 360) / (Math.abs((p.angle ?? 360) - 360) < 1e-6 ? n : n - 1) * i * Math.PI / 180; const cx = p.cx || 0, cy = p.cy || 0; const m = mapPoint((x, y) => [cx + (x - cx) * Math.cos(a) - (y - cy) * Math.sin(a), cy + (x - cx) * Math.sin(a) + (y - cy) * Math.cos(a)], true, String(i)); sk.entities.push(...cloneEnts(m)); } }
  s.skSet(sk, { force: true });
}
const entPts = (e: SkEntity): string[] => e.type === "line" ? [e.p1, e.p2] : e.type === "arc" ? [e.c, e.p1, e.p2] : e.type === "circle" || e.type === "ellipse" ? [e.c] : e.type === "spline" ? e.pts : [e.p];
function remap(e: SkEntity, m: Record<string, string>, sc = 1): SkEntity {
  const id = uid("e"); const g = (x: string) => m[x] || x;
  switch (e.type) { case "line": return { ...e, id, p1: g(e.p1), p2: g(e.p2) }; case "arc": return { ...e, id, c: g(e.c), p1: g(e.p1), p2: g(e.p2) }; case "circle": return { ...e, id, c: g(e.c), r: e.r * sc }; case "ellipse": return { ...e, id, c: g(e.c), a: e.a * sc, b: e.b * sc }; case "spline": return { ...e, id, pts: e.pts.map(g) }; default: return { ...e, id, p: g((e as any).p) } as SkEntity; }
}
const scaleEnt = (e: any, f: number) => e.type === "circle" ? { ...e, r: e.r * f } : { ...e, a: e.a * f, b: e.b * f };
function stripFix(sk: Sketch, pts: Set<string>) { sk.constraints = sk.constraints.filter(c => !(c.type === "fix" && c.refs.some(r => pts.has(r)))); }
function stripHV(sk: Sketch, ents: SkEntity[]) { const ids = new Set(ents.map(e => e.id)); sk.constraints = sk.constraints.filter(c => !((c.type === "horizontal" || c.type === "vertical") && ids.has(c.refs[0]))); }

/** project selected model edges into the active sketch */
export function convertEntities() {
  const s = st(); const ss = s.sketch; const b = s.builds[s.activeId!]?.main; if (!ss || !b) return;
  const sels = s.selection.filter(x => x.kind === "edge" || x.kind === "face") as any[];
  if (!sels.length) return s.showToast("Select model edges or faces, then Convert Entities");
  const edgeIds = new Set<number>();
  for (const x of sels) { if (x.kind === "edge") edgeIds.add(x.index); else { const fg = b.faceGroups.find(g => g.faceId === x.index); if (!fg) continue; const vs = new Set<string>(); for (let i = fg.start; i < fg.start + fg.count; i++) { const k = b.triangles[i]; vs.add(`${b.vertices[k * 3].toFixed(3)},${b.vertices[k * 3 + 1].toFixed(3)},${b.vertices[k * 3 + 2].toFixed(3)}`); } for (const g of b.edgeGroups) { let all = true; for (let i = g.start; i < g.start + g.count; i++) if (!vs.has(`${b.lines[i * 3].toFixed(3)},${b.lines[i * 3 + 1].toFixed(3)},${b.lines[i * 3 + 2].toFixed(3)}`)) { all = false; break; } if (all) edgeIds.add(g.edgeId); } } }
  const pl = ss.sk.plane; const sk: Sketch = { ...ss.sk, points: { ...ss.sk.points }, entities: ss.sk.entities.slice(), constraints: ss.sk.constraints.slice() };
  const loc = (p: number[]) => { const r = [p[0] - pl.origin[0], p[1] - pl.origin[1], p[2] - pl.origin[2]]; return [r[0] * pl.x[0] + r[1] * pl.x[1] + r[2] * pl.x[2], r[0] * pl.y[0] + r[1] * pl.y[1] + r[2] * pl.y[2]] as [number, number]; };
  const pt = (q: [number, number]) => { for (const k in sk.points) { const p = sk.points[k]; if (Math.hypot(p.x - q[0], p.y - q[1]) < 1e-5) return k; } const id = uid("p"); sk.points[id] = { id, x: q[0], y: q[1], fixed: true }; return id; };
  for (const eid of edgeIds) {
    const info = b.edges[eid]; if (!info) continue;
    if (info.type === "LINE" && info.a && info.b) { const a = loc(info.a), c = loc(info.b); if (Math.hypot(a[0] - c[0], a[1] - c[1]) > 1e-6) sk.entities.push({ id: uid("e"), type: "line", p1: pt(a), p2: pt(c) }); continue; }
    if (info.circle && info.a && info.b) {
      const c = loc(info.circle.c); const closed = Math.hypot(info.a[0] - info.b[0], info.a[1] - info.b[1], info.a[2] - info.b[2]) < 1e-6;
      if (closed) { sk.entities.push({ id: uid("e"), type: "circle", c: pt(c), r: info.circle.r }); sk.constraints.push({ id: uid("c"), type: "fix", refs: [sk.entities[sk.entities.length - 1].id] }); }
      else { const a = loc(info.a), e2 = loc(info.b), m = loc(info.mid); const cr = (a[0] - c[0]) * (m[1] - c[1]) - (a[1] - c[1]) * (m[0] - c[0]); sk.entities.push(cr >= 0 ? { id: uid("e"), type: "arc", c: pt(c), p1: pt(a), p2: pt(e2) } : { id: uid("e"), type: "arc", c: pt(c), p1: pt(e2), p2: pt(a) }); }
      continue;
    }
    // generic: polyline from mesh lines
    const pts: [number, number][] = []; for (const g of b.edgeGroups.filter(g => g.edgeId === eid)) for (let i = g.start; i < g.start + g.count; i += 2) { const q = loc([b.lines[i * 3], b.lines[i * 3 + 1], b.lines[i * 3 + 2]]); pts.push(q); }
    if (info.b) pts.push(loc(info.b)); const ids = pts.filter((_, i) => i % Math.max(1, Math.floor(pts.length / 12)) === 0 || i === pts.length - 1).map(pt);
    if (ids.length >= 2) sk.entities.push({ id: uid("e"), type: "spline", pts: ids });
  }
  s.skSet(sk, { force: true }); useApp.setState({ selection: [] }); s.showToast(`Converted ${edgeIds.size} edge(s) into the sketch`);
}

// ───────── commands
export function runCommand(id: string, arg?: any) {
  const s = st(); const d = active();
  const featureCmds = ["extrude", "cut", "revolve", "revolveCut", "sweep", "sweepCut", "loft", "loftCut", "fillet", "chamfer", "shell", "draft", "hole", "linearPattern", "circularPattern", "mirror", "plane", "axis"];
  if (featureCmds.includes(id)) { if (!part()) return s.showToast("Open a part document first"); useApp.setState({ pendingPick: null }); return openFeaturePM(id); }
  const skTools = ["line", "centerline", "circle", "rect", "arc", "polygon", "spline", "slot", "ellipse", "point", "trim", "extend", "dimension"];
  if (skTools.includes(id)) {
    if (!s.sketch) { if (!part()) return; startSketchCmd(); if (!useApp.getState().sketch) { useApp.setState({ status: "Select a plane first, then choose the sketch tool again" }); return; } }
    const tool = id === "centerline" ? "centerline" : id; const mode = arg ?? (id === "circle" ? "center" : id === "rect" ? "corner" : id === "arc" ? "center" : id === "slot" ? "straight" : "");
    useApp.getState().setTool(tool, mode);
    useApp.setState({ status: TOOL_HINT[tool] || "" }); return;
  }
  switch (id) {
    case "new": return useApp.setState({ dialog: { name: "new" } });
    case "newPart": return s.newDoc("part");
    case "newAssembly": return s.newDoc("assembly");
    case "newDrawing": { const nid = s.newDoc("drawing"); const src = Object.values(s.docs).find(x => x.kind !== "drawing" && s.order.includes(x.id)); if (src) s.updateDoc(nid, (dd: DrawingDoc) => ({ ...dd, sourceId: src.id, title: { ...dd.title, title: src.name, partNo: src.name } }), false); return; }
    case "open": return openFile();
    case "save": return d && s.saveDoc();
    case "saveAs": return saveAs();
    case "export": return exportAs(arg);
    case "import": return importFile(arg);
    case "print": if (d?.kind === "drawing") return window.dispatchEvent(new CustomEvent("cad:drawingExport", { detail: "pdf" })); return window.print();
    case "properties": return useApp.setState({ dialog: { name: "properties" } });
    case "close": return d && s.closeDoc(d.id);
    case "undo": return s.undo();
    case "redo": return s.redo();
    case "delete": return deleteSelection();
    case "selectAll": if (s.sketch) useApp.setState({ selection: s.sketch.sk.entities.map(e => ({ kind: "sk", id: e.id } as Sel)) }); else if (part()) useApp.setState({ selection: (s.builds[d!.id]?.main?.edges || []).map(e => ({ kind: "edge", index: e.id, point: e.mid } as Sel)) }); return;
    case "copy": return copySel();
    case "paste": return pasteSel();
    case "cutClip": copySel(); return deleteSelection();
    case "rebuild": case "forceRebuild": useApp.setState({ builds: { ...s.builds, [d?.id || ""]: undefined as any } }); window.dispatchEvent(new CustomEvent("cad:rebuild", { detail: id === "forceRebuild" })); if (d?.kind === "assembly") resolveAssembly(); return s.showToast("Rebuilt");
    case "zoomFit": return s.cmd("fit");
    case "zoomArea": return s.cmd("zoomArea");
    case "zoomIn": return s.cmd("zoomIn");
    case "zoomOut": return s.cmd("zoomOut");
    case "prevView": return s.cmd("prev");
    case "view": return s.cmd(arg);
    case "normalTo": if (s.sketch) return s.cmd("normal", { plane: s.sketch.sk.plane }); return s.cmd("normalToSel");
    case "style": return useApp.setState({ display: { ...s.display, style: arg } });
    case "toggle": return useApp.setState({ display: { ...s.display, [arg]: !(s.display as any)[arg] } });
    case "section": return useApp.setState({ display: { ...s.display, section: { ...s.display.section, on: !s.display.section.on } }, dialog: !s.display.section.on ? { name: "section" } : null });
    case "scene": return useApp.setState({ display: { ...s.display, scene: arg } });
    case "sketch": return startSketchCmd();
    case "exitSketch": return s.exitSketch(true);
    case "construction": { const ss = s.sketch; if (!ss) return; const ids = sketchSelected(); if (ids.length) { s.skSet({ ...ss.sk, entities: ss.sk.entities.map(e => ids.includes(e.id) ? { ...e, construction: !e.construction } as SkEntity : e) }, { force: true }); } else useApp.setState({ sketch: { ...ss, toolOpts: { ...ss.toolOpts, construction: !ss.toolOpts.construction } } }); return; }
    case "offset": case "sketchMirror": case "convert": case "move": case "copyEnt": case "rotate": case "scale": case "sketchLinear": case "sketchCircular": case "relations": {
      if (!s.sketch) return s.showToast("Available in sketch mode");
      if (id === "convert") return convertEntities();
      return useApp.setState({ sketch: { ...s.sketch, tool: "select", mode: id } });
    }
    case "measure": return useApp.setState({ pm: { type: "measure", draft: { id: "measure", type: "sketch", name: "Measure", params: { items: [] } }, index: 0, box: "items" }, selection: [], status: "Select entities to measure" });
    case "massProps": return useApp.setState({ dialog: { name: "mass" } });
    case "check": return useApp.setState({ dialog: { name: "check" } });
    case "options": return useApp.setState({ dialog: { name: "options" } });
    case "equations": return useApp.setState({ dialog: { name: "equations" } });
    case "designTable": return useApp.setState({ dialog: { name: "designTable" } });
    case "material": return useApp.setState({ dialog: { name: "material" } });
    case "appearance": return useApp.setState({ dialog: { name: "appearance" } });
    case "insertComp": return useApp.setState({ dialog: { name: "insertComp" } });
    case "mate": if (d?.kind !== "assembly") return; return openMatePM();
    case "moveComp": case "rotateComp": if (d?.kind !== "assembly") return; return useApp.setState({ pm: { type: id, draft: { id, type: "sketch", name: id === "moveComp" ? "Move Component" : "Rotate Component", params: { dx: 0, dy: 0, dz: 0, rx: 0, ry: 0, rz: 0 } }, index: 0, box: "", extra: { base: d } }, status: "Drag a free component in the graphics area" });
    case "explode": if (d?.kind !== "assembly") return; return useApp.setState({ pm: { type: "explode", draft: { id: "explode", type: "sketch", name: "Explode", params: { comps: [], dir: [0, 1, 0], dist: 50 } }, index: 0, box: "comps" }, status: "Select components to explode" });
    case "toggleExplode": if (d?.kind !== "assembly") return; return s.updateDoc(d.id, (a: AssemblyDoc) => ({ ...a, exploded: !a.exploded }));
    case "interference": return useApp.setState({ dialog: { name: "interference" } });
    case "asmStats": return useApp.setState({ dialog: { name: "asmStats" } });
    case "linearCompPattern": return useApp.setState({ dialog: { name: "compPattern" } });
    case "mirrorComp": return useApp.setState({ dialog: { name: "mirrorComp" } });
    case "help": return useApp.setState({ dialog: { name: "help" } });
    case "about": return useApp.setState({ dialog: { name: "about" } });
    case "taskPane": return useApp.setState({ taskPane: !s.taskPane });
    case "filter": return useApp.setState({ selFilter: s.selFilter === arg ? null : arg });
  }
}
export const TOOL_HINT: Record<string, string> = {
  line: "Line: click start point, click end point (chains). Type a value for length · Esc ends chain", centerline: "Centerline: click start and end", circle: "Circle: click center, then radius (or type radius)", rect: "Rectangle: click first corner, then opposite corner (or type W Tab H)",
  arc: "Arc: click center, start, end", polygon: "Polygon: click center, then a vertex", spline: "Spline: click points, double-click / Enter to finish", slot: "Slot: click first center, second center, then width", ellipse: "Ellipse: center, major axis, minor axis",
  point: "Point: click to place", trim: "Power trim: drag across entities, or click a segment to remove it", extend: "Extend: click near the end of a line", dimension: "Smart Dimension: select entities, click to place, enter value",
};

function deleteSelection() {
  const s = st();
  if (s.sketch) {
    const ss = s.sketch; const ents = new Set(s.selection.filter(x => x.kind === "sk").map((x: any) => x.id)); const cons = new Set(s.selection.filter(x => x.kind === "skc").map((x: any) => x.id));
    if (!ents.size && !cons.size) return;
    const pts = new Set([...ents].filter(id => ss.sk.points[id]));
    let entities = ss.sk.entities.filter(e => !ents.has(e.id) && !(e.type === "point" && pts.has(e.p)) && !entPts(e).some(p => pts.has(p) && p !== "O"));
    const removed = new Set(ss.sk.entities.filter(e => !entities.includes(e)).map(e => e.id));
    const constraints = ss.sk.constraints.filter(c => !cons.has(c.id) && !c.refs.some(r => removed.has(r) || pts.has(r)));
    s.skSet({ ...ss.sk, entities, constraints }, { force: true }); useApp.setState({ selection: [] }); return;
  }
  const d = active();
  if (d?.kind === "part") { const ids = s.selection.filter(x => x.kind === "feature").map((x: any) => x.id); if (ids.length) deleteFeatures(ids); return; }
  if (d?.kind === "assembly") {
    const comps = new Set(s.selection.filter(x => x.kind === "comp").map((x: any) => x.id)); const mates = new Set(s.selection.filter(x => x.kind === "mate").map((x: any) => x.id));
    if (!comps.size && !mates.size) return;
    s.updateDoc(d.id, (a: AssemblyDoc) => ({ ...a, components: a.components.filter(c => !comps.has(c.id)), mates: a.mates.filter(m => !mates.has(m.id) && !comps.has(m.a.comp) && !comps.has(m.b.comp)), explode: a.explode.map(e => ({ ...e, comps: e.comps.filter(c => !comps.has(c)) })) }));
    useApp.setState({ selection: [] });
  }
  if (d?.kind === "drawing") window.dispatchEvent(new CustomEvent("cad:drawingDelete"));
}
let clipboard: any = null;
function copySel() {
  const s = st();
  if (s.sketch) { const ids = sketchSelected(); if (!ids.length) return; const ents = s.sketch.sk.entities.filter(e => ids.includes(e.id)); const pts: Record<string, any> = {}; ents.forEach(e => entPts(e).forEach(p => pts[p] = s.sketch!.sk.points[p])); clipboard = { kind: "sketch", ents, pts }; s.showToast(`Copied ${ents.length} entities`); return; }
  const p = part(); if (p) { const ids = s.selection.filter(x => x.kind === "feature").map((x: any) => x.id); const fs = p.features.filter(f => ids.includes(f.id) && f.type === "sketch"); if (fs.length) { clipboard = { kind: "features", fs }; s.showToast(`Copied ${fs.length} sketch(es)`); } }
}
function pasteSel() {
  const s = st(); if (!clipboard) return;
  if (clipboard.kind === "sketch" && s.sketch) {
    const sk = { ...s.sketch.sk, points: { ...s.sketch.sk.points }, entities: s.sketch.sk.entities.slice() }; const map: Record<string, string> = {}; const off = 10;
    for (const k in clipboard.pts) { const q = clipboard.pts[k]; const id = uid("p"); sk.points[id] = { id, x: q.x + off, y: q.y - off }; map[k] = id; }
    sk.entities.push(...clipboard.ents.map((e: SkEntity) => remap(e, map))); s.skSet(sk, { force: true }); return;
  }
  const p = part(); if (clipboard.kind === "features" && p) for (const f of clipboard.fs) insertFeature(p.id, { type: "sketch", sketch: { ...JSON.parse(JSON.stringify(f.sketch)), id: uid("sk") }, params: {} } as any);
}

export function applyMaterial(name: string | null) {
  const s = st(); const p = part(); if (!p) return; const m = MATERIALS.find(x => x.name === name);
  s.updateDoc(p.id, (d: PartDoc) => ({ ...d, material: name, appearance: m ? { ...d.appearance, color: m.color, metalness: m.metalness, roughness: m.roughness } : d.appearance }));
}

export function newAssemblyFromPart() { const s = st(); const p = part(); if (!p) return; const a = newAssembly(`${p.name}_Assembly`); a.components.push({ id: uid("c"), partId: p.id, name: p.name, instance: 1, t: { p: [0, 0, 0], q: [0, 0, 0, 1] }, fixed: true }); s.addDoc(a, true); useApp.setState({ cmTab: "Assembly" }); }
export { toWorld };
