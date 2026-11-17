import { useApp, type Sel } from "../store";
import type { PartDoc, AssemblyDoc } from "../types";
import { runCommand, editFeature, editSketch, deleteFeatures, setSuppressed, isSuppressed, startSketchCmd } from "./actions";
import { openFeaturePM } from "./pm";

export interface MenuItem { label?: string; icon?: string; action?: () => void; disabled?: boolean; sep?: boolean; checked?: boolean; hint?: string }
export interface MenuState { x: number; y: number; items: MenuItem[]; toolbar?: MenuItem[] }

const st = () => useApp.getState();
const open = (x: number, y: number, items: MenuItem[], toolbar?: MenuItem[]) => useApp.setState({ menu: { x, y, items, toolbar } as any });

/** Right-click in the graphics area */
export function onContextMenu(x: number, y: number, sel: Sel | null) {
  const s = st(); const d = s.activeId ? s.docs[s.activeId] : null;
  if (sel && !s.selection.some(q => JSON.stringify(q) === JSON.stringify(sel))) s.select(sel);
  const items: MenuItem[] = []; const tb: MenuItem[] = [];
  if (s.sketch) {
    items.push({ label: "Select", icon: "smartSel", action: () => s.setTool("select") }, { label: "Smart Dimension", icon: "dimension", action: () => runCommand("dimension") }, { sep: true });
    items.push({ label: "Line", icon: "line", action: () => runCommand("line") }, { label: "Centerline", icon: "centerline", action: () => runCommand("centerline") }, { label: "Circle", icon: "circle", action: () => runCommand("circle") }, { label: "Corner Rectangle", icon: "rect", action: () => runCommand("rect") }, { label: "Trim Entities", icon: "trim", action: () => runCommand("trim") }, { sep: true });
    if (sel?.kind === "sk") { items.push({ label: "Construction Geometry", icon: "construction", action: () => runCommand("construction") }, { label: "Add Relation…", icon: "relations", action: () => runCommand("relations") }, { label: "Delete", icon: "delete", action: () => runCommand("delete") }, { sep: true }); tb.push({ icon: "construction", hint: "Construction Geometry", action: () => runCommand("construction") }, { icon: "relations", hint: "Add Relation", action: () => runCommand("relations") }, { icon: "dimension", hint: "Smart Dimension", action: () => runCommand("dimension") }); }
    items.push({ label: "Normal To", icon: "normalTo", action: () => runCommand("normalTo") }, { label: "Zoom to Fit", icon: "zoomFit", action: () => runCommand("zoomFit") }, { sep: true }, { label: "Exit Sketch", icon: "exitSketch", action: () => s.exitSketch(true) }, { label: "Discard Changes and Exit", icon: "delete", action: () => s.exitSketch(false) });
    return open(x, y, items, tb);
  }
  if (d?.kind === "part") {
    if (sel?.kind === "face") {
      const info = s.builds[d.id]?.main?.faces[sel.index];
      tb.push({ icon: "sketch", hint: "Sketch", action: () => startSketchCmd() }, { icon: "normalTo", hint: "Normal To", action: () => runCommand("normalTo") }, { icon: "appearance", hint: "Appearance", action: () => runCommand("appearance") }, { icon: "measure", hint: "Measure", action: () => runCommand("measure") });
      items.push({ label: `Face<${sel.index + 1}> (${info?.type?.toLowerCase().replace("cylindre", "cylinder") || "face"})`, disabled: true });
      if (info?.type === "PLANE") items.push({ label: "Sketch", icon: "sketch", action: () => startSketchCmd() }, { label: "Hole Wizard…", icon: "hole", action: () => openFeaturePM("hole") });
      items.push({ label: "Fillet edges of face", icon: "fillet", action: () => openFeaturePM("fillet") }, { label: "Shell (remove face)", icon: "shell", action: () => openFeaturePM("shell") }, { label: "Reference Plane…", icon: "plane", action: () => openFeaturePM("plane") }, { sep: true });
      const fid = featureOfFace(d, sel.index); if (fid) { const f = d.features.find(x => x.id === fid)!; items.push({ label: `Edit Feature (${f.name})`, icon: "edit", action: () => editFeature(fid) }); }
    } else if (sel?.kind === "edge") {
      tb.push({ icon: "fillet", hint: "Fillet", action: () => openFeaturePM("fillet") }, { icon: "chamfer", hint: "Chamfer", action: () => openFeaturePM("chamfer") }, { icon: "measure", hint: "Measure", action: () => runCommand("measure") });
      items.push({ label: `Edge<${sel.index + 1}>`, disabled: true }, { label: "Fillet…", icon: "fillet", action: () => openFeaturePM("fillet") }, { label: "Chamfer…", icon: "chamfer", action: () => openFeaturePM("chamfer") }, { label: "Reference Axis…", icon: "axis", action: () => openFeaturePM("axis") }, { sep: true });
    } else if (sel?.kind === "plane") {
      tb.push({ icon: "sketch", hint: "Sketch", action: () => startSketchCmd() }, { icon: "normalTo", hint: "Normal To", action: () => runCommand("normalTo") });
      items.push({ label: sel.plane.name || sel.id, disabled: true }, { label: "Sketch", icon: "sketch", action: () => startSketchCmd() }, { label: "Offset Plane…", icon: "plane", action: () => openFeaturePM("plane") }, { label: "Mirror about this plane…", icon: "mirror", action: () => openFeaturePM("mirror") }, { sep: true });
    }
    items.push({ label: "Zoom to Fit", icon: "zoomFit", action: () => runCommand("zoomFit") }, { label: "Previous View", icon: "prevView", action: () => runCommand("prevView") }, { label: "Section View", icon: "section", action: () => runCommand("section") }, { sep: true });
    items.push({ label: "Measure", icon: "measure", action: () => runCommand("measure") }, { label: "Mass Properties", icon: "massProps", action: () => runCommand("massProps") }, { label: "Material…", icon: "material", action: () => runCommand("material") }, { label: "Appearance…", icon: "appearance", action: () => runCommand("appearance") });
    if (s.selection.length) items.push({ sep: true }, { label: "Clear Selection", action: () => s.select(null) });
    return open(x, y, items, tb);
  }
  if (d?.kind === "assembly") {
    const compId = sel && ((sel as any).comp || (sel.kind === "comp" ? sel.id : null));
    if (compId) { const c = d.components.find(q => q.id === compId); if (c) { tb.push({ icon: "mate", hint: "Mate", action: () => runCommand("mate") }, { icon: "hideShow", hint: "Hide", action: () => compToggle(d, c.id, "hidden") }, { icon: "move", hint: "Move", action: () => runCommand("moveComp") }); items.push(...compItems(d, c.id)); items.push({ sep: true }); } }
    items.push({ label: "Mate…", icon: "mate", action: () => runCommand("mate") }, { label: "Insert Components…", icon: "insertComp", action: () => runCommand("insertComp") }, { label: d.exploded ? "Collapse" : "Explode", icon: "explode", action: () => runCommand("toggleExplode"), disabled: !d.explode.length }, { label: "Interference Detection", icon: "interference", action: () => runCommand("interference") }, { sep: true }, { label: "Zoom to Fit", icon: "zoomFit", action: () => runCommand("zoomFit") }, { label: "Show Hidden Components", action: () => st().updateDoc(d.id, (a: AssemblyDoc) => ({ ...a, components: a.components.map(c => ({ ...c, hidden: false })) })) });
    return open(x, y, items, tb);
  }
}

function featureOfFace(d: PartDoc, _face: number): string | null { const feats = d.features.filter(f => f.type !== "sketch" && !["plane", "axis", "point"].includes(f.type)); return feats.length ? feats[feats.length - 1].id : null; }
function compToggle(d: AssemblyDoc, id: string, key: "hidden" | "transparent" | "fixed") { st().updateDoc(d.id, (a: AssemblyDoc) => ({ ...a, components: a.components.map(c => c.id === id ? { ...c, [key]: !c[key] } : c) })); }

export function compItems(d: AssemblyDoc, id: string): MenuItem[] {
  const c = d.components.find(q => q.id === id)!; const s = st();
  return [
    { label: `${c.name}<${c.instance}>`, disabled: true },
    { label: "Open Part", icon: "part", action: () => s.activate(c.partId) },
    { label: c.hidden ? "Show Component" : "Hide Component", icon: "hideShow", action: () => compToggle(d, id, "hidden") },
    { label: "Change Transparency", checked: !!c.transparent, action: () => compToggle(d, id, "transparent") },
    { label: c.fixed ? "Float" : "Fix", icon: "fix", action: () => compToggle(d, id, "fixed") },
    { label: "Delete Component", icon: "delete", action: () => { s.select({ kind: "comp", id }); runCommand("delete"); } },
  ];
}

/** Right-click on a FeatureManager item */
export function treeContextMenu(x: number, y: number, kind: string, id: string) {
  const s = st(); const d = s.activeId ? s.docs[s.activeId] : null; if (!d) return;
  const items: MenuItem[] = [];
  if (kind === "feature" && d.kind === "part") {
    const f = d.features.find(q => q.id === id); if (!f) return; const sup = isSuppressed(d, f); const idx = d.features.indexOf(f);
    if (f.type === "sketch") items.push({ label: "Edit Sketch", icon: "sketch", action: () => editSketch(id) });
    else items.push({ label: "Edit Feature", icon: "edit", action: () => editFeature(id) });
    if (f.type !== "sketch" && f.params?.sketchId) items.push({ label: "Edit Sketch", icon: "sketch", action: () => editSketch(f.params.sketchId) });
    items.push(
      { label: sup ? "Unsuppress" : "Suppress", icon: "suppress", action: () => setSuppressed([id], !sup) },
      { label: "Roll Back", icon: "undo", action: () => s.updateDoc(d.id, (p: PartDoc) => ({ ...p, rollback: idx }), false) },
      { label: "Roll to End", action: () => s.updateDoc(d.id, (p: PartDoc) => ({ ...p, rollback: null }), false), disabled: d.rollback === null },
      { label: "Rename", action: () => window.dispatchEvent(new CustomEvent("cad:rename", { detail: id })) },
      { sep: true },
      { label: "Delete…", icon: "delete", action: () => deleteFeatures([id]) },
    );
    if (f.type === "sketch") items.splice(1, 0, { label: "Hide / Show sketch", icon: "hideShow", action: () => s.updateDoc(d.id, (p: PartDoc) => ({ ...p, features: p.features.map(q => q.id === id ? { ...q, params: { ...q.params, hidden: !q.params?.hidden } } : q) }), false) });
  } else if (kind === "plane") {
    items.push({ label: "Sketch", icon: "sketch", action: () => startSketchCmd() }, { label: "Normal To", icon: "normalTo", action: () => runCommand("normalTo") }, { label: "Offset Plane…", icon: "plane", action: () => openFeaturePM("plane") });
  } else if (kind === "material" && d.kind === "part") {
    items.push({ label: "Edit Material…", icon: "material", action: () => runCommand("material") }, { label: "Remove Material", action: () => s.updateDoc(d.id, (p: PartDoc) => ({ ...p, material: null })), disabled: !d.material });
  } else if (kind === "comp" && d.kind === "assembly") items.push(...compItems(d, id));
  else if (kind === "mate" && d.kind === "assembly") {
    const m = d.mates.find(q => q.id === id)!;
    items.push({ label: m.suppressed ? "Unsuppress" : "Suppress", icon: "suppress", action: () => { s.updateDoc(d.id, (a: AssemblyDoc) => ({ ...a, mates: a.mates.map(q => q.id === id ? { ...q, suppressed: !q.suppressed } : q) })); } }, { label: "Flip Alignment", action: () => { s.updateDoc(d.id, (a: AssemblyDoc) => ({ ...a, mates: a.mates.map(q => q.id === id ? { ...q, flip: !q.flip } : q) })); window.dispatchEvent(new CustomEvent("cad:resolve")); } }, { label: "Delete", icon: "delete", action: () => { s.select({ kind: "mate", id }); runCommand("delete"); } });
  } else if (kind === "explode" && d.kind === "assembly") {
    items.push({ label: d.exploded ? "Collapse" : "Explode", icon: "explode", action: () => runCommand("toggleExplode") }, { label: "Delete Explode Steps", icon: "delete", action: () => s.updateDoc(d.id, (a: AssemblyDoc) => ({ ...a, explode: [], exploded: false })) });
  } else if (kind === "root") {
    items.push({ label: "Document Properties…", action: () => runCommand("properties") }, { label: "Rebuild", icon: "rebuild", action: () => runCommand("rebuild") });
    if (d.kind === "part") items.push({ label: "Make Assembly from Part", icon: "assembly", action: () => import("./actions").then(m => m.newAssemblyFromPart()) });
  }
  open(x, y, items);
}
