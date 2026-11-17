import { create } from "zustand";
import type { Doc, PartDoc, AssemblyDoc, DrawingDoc, Feature, Sketch, PlaneDef, Vec3, BuildResult, FeatureType, UnitSystem, Configuration } from "./types";
import { uid } from "./math";
import { solveSketch, type SolveResult } from "./sketch/solver";

// ───────── Selection
export type Sel =
  | { kind: "face"; index: number; point: Vec3; normal?: Vec3 | null; comp?: string; hit?: Vec3 }
  | { kind: "edge"; index: number; point: Vec3; comp?: string }
  | { kind: "vertex"; point: Vec3; comp?: string }
  | { kind: "plane"; id: string; plane: PlaneDef }
  | { kind: "axis"; id: string; axis: { o: Vec3; d: Vec3 } }
  | { kind: "feature"; id: string }
  | { kind: "origin" }
  | { kind: "sk"; id: string }         // sketch entity or point
  | { kind: "skc"; id: string }        // sketch constraint / dimension
  | { kind: "comp"; id: string }
  | { kind: "mate"; id: string };
export const selKey = (s: Sel): string => {
  switch (s.kind) {
    case "face": case "edge": return `${s.kind}:${s.comp || ""}:${s.index}`;
    case "vertex": return `v:${s.comp || ""}:${s.point.map(v => v.toFixed(4)).join(",")}`;
    case "origin": return "origin";
    default: return `${s.kind}:${(s as any).id}`;
  }
};

export interface PMState { type: string; editId?: string; draft: Feature; index: number; box?: string; extra?: any }
export interface SketchSession {
  featureId: string | null; name: string; isNew: boolean;
  sk: Sketch; solve: SolveResult | null;
  tool: string; mode: string;
  undo: Sketch[]; redo: Sketch[];
  toolOpts: { construction: boolean; sides: number; inscribed: boolean; keepOriginal?: boolean; offset: number; reverse?: boolean; scale: number; angle: number };
}
export interface DisplayState {
  style: "shaded" | "shadedEdges" | "wire" | "hlv" | "hlr";
  planes: boolean; origins: boolean; sketches: boolean; axes: boolean; grid: boolean; triad: boolean;
  section: { on: boolean; plane: "Front" | "Top" | "Right"; offset: number; flip: boolean };
  scene: "gradient" | "white" | "studio" | "dark";
  perspective: boolean;
}
export interface Options { gridSpacing: number; snapGrid: boolean; snapPoints: boolean; autoRelations: boolean; showRelations: boolean; inputDim: boolean; singleCommand: boolean; edgeQuality: "draft" | "normal" | "high"; autosaveMin: number; userName: string; selColor: string; antialias: boolean }

const defaultApp = (): PartDoc["appearance"] => ({ color: "#c9ced6", metalness: 0.15, roughness: 0.5, opacity: 1 });
const defaultCfg = (): Configuration => ({ id: "default", name: "Default", suppressed: {}, overrides: {} });

export function newPart(name = "Part1"): PartDoc {
  return { kind: "part", id: uid("doc"), name, features: [], rollback: null, material: null, appearance: defaultApp(), units: "MMGS", configs: [defaultCfg()], activeConfig: "default", props: { Description: "", PartNo: name }, counters: {} };
}
export function newAssembly(name = "Assembly1"): AssemblyDoc { return { kind: "assembly", id: uid("doc"), name, components: [], mates: [], explode: [], exploded: false, units: "MMGS", counters: {} }; }
export function newDrawing(name = "Draw1"): DrawingDoc {
  return { kind: "drawing", id: uid("doc"), name, sheet: "A3", scale: 1, projection: "third", sourceId: null, views: [], annos: [], units: "MMGS", counters: {}, title: { title: name, drawnBy: "Designer", date: new Date().toISOString().slice(0, 10), material: "", partNo: "", rev: "A", company: "OpenWorks CAD" } };
}

export const FEATURE_LABEL: Record<string, string> = {
  sketch: "Sketch", extrude: "Boss-Extrude", cut: "Cut-Extrude", revolve: "Revolve", revolveCut: "Cut-Revolve", sweep: "Sweep", sweepCut: "Cut-Sweep", loft: "Loft", loftCut: "Cut-Loft",
  fillet: "Fillet", chamfer: "Chamfer", shell: "Shell", draft: "Draft", hole: "Hole", linearPattern: "LPattern", circularPattern: "CirPattern", mirror: "Mirror", plane: "Plane", axis: "Axis", point: "Point", import: "Imported",
};

/** feature list after applying the active configuration & rollback */
export function effectiveFeatures(doc: PartDoc, includeRolledBack = false): Feature[] {
  const cfg = doc.configs.find(c => c.id === doc.activeConfig);
  const list = doc.features.map(f => {
    let g = f;
    if (cfg) {
      const sup = cfg.suppressed[f.id];
      const ov = Object.entries(cfg.overrides).filter(([k]) => k.startsWith(f.id + "."));
      if (sup !== undefined || ov.length) { g = { ...f, suppressed: sup ?? f.suppressed, params: { ...f.params } }; for (const [k, v] of ov) setPath(g.params, k.slice(f.id.length + 1), v); }
    }
    return g;
  });
  return includeRolledBack || doc.rollback === null ? list : list.slice(0, doc.rollback);
}
export function setPath(o: any, path: string, v: any) { const ks = path.split("."); let cur = o; for (let i = 0; i < ks.length - 1; i++) { cur[ks[i]] = { ...(cur[ks[i]] || {}) }; cur = cur[ks[i]]; } cur[ks[ks.length - 1]] = v; }
export function getPath(o: any, path: string) { return path.split(".").reduce((a, k) => a?.[k], o); }

export const childrenOf = (doc: PartDoc, id: string) => doc.features.filter(f => f.id !== id && JSON.stringify(f.params || {}).includes(`"${id}"`)).map(f => f.id);
export const parentsOf = (doc: PartDoc, f: Feature) => doc.features.filter(g => g.id !== f.id && JSON.stringify(f.params || {}).includes(`"${g.id}"`)).map(g => g.id);
export const consumerOf = (doc: PartDoc, sketchId: string) => doc.features.find(f => f.type !== "sketch" && (f.params?.sketchId === sketchId || f.params?.profileId === sketchId || f.params?.pathId === sketchId || (f.params?.profiles || []).includes(sketchId)));

const LIB_KEY = "openworks.library.v1";
export function loadLibrary(): Record<string, Doc> { try { return JSON.parse(localStorage.getItem(LIB_KEY) || "{}"); } catch { return {}; } }
function saveLibrary(lib: Record<string, Doc>) { try { localStorage.setItem(LIB_KEY, JSON.stringify(lib)); } catch (e) { console.warn("library save failed", e); } }

interface AppState {
  docs: Record<string, Doc>;
  order: string[];
  activeId: string | null;
  hist: Record<string, { undo: Doc[]; redo: Doc[] }>;
  dirty: Record<string, boolean>;
  builds: Record<string, BuildResult>;
  preview: BuildResult | null;
  building: boolean;
  cmTab: string;
  pm: PMState | null;
  selection: Sel[];
  hover: Sel | null;
  sketch: SketchSession | null;
  display: DisplayState;
  options: Options;
  status: string;
  cursor: string;
  dialog: { name: string; data?: any } | null;
  menu: { x: number; y: number; items: any[] } | null;
  viewCmd: { seq: number; kind: string; plane?: PlaneDef; data?: any };
  library: Record<string, Doc>;
  recent: string[];
  toast: { msg: string; seq: number } | null;
  taskPane: boolean;
  taskTab: string;
  leftTab: "tree" | "config" | "props";
  interference: any[] | null;
  measure: any | null;
  shortcutBar: { x: number; y: number } | null;
  pendingPick: string | null; // e.g. "sketchPlane"
  selFilter: string | null;
  // actions
  set: (p: Partial<AppState>) => void;
  newDoc: (kind: "part" | "assembly" | "drawing") => string;
  addDoc: (d: Doc, open?: boolean) => void;
  closeDoc: (id: string) => void;
  activate: (id: string) => void;
  updateDoc: (id: string, fn: (d: any) => any, record?: boolean) => void;
  undo: () => void; redo: () => void;
  saveDoc: (id?: string) => void;
  removeFromLibrary: (id: string) => void;
  select: (s: Sel | null, additive?: boolean) => void;
  setStatus: (s: string) => void;
  showToast: (s: string) => void;
  cmd: (kind: string, extra?: Partial<{ plane: PlaneDef; data: any }>) => void;
  // sketch
  startSketch: (plane: PlaneDef, label: string, featureId?: string) => void;
  exitSketch: (ok: boolean) => void;
  skSet: (sk: Sketch, opts?: { record?: boolean; drag?: Record<string, [number, number]>; force?: boolean }) => boolean;
  skUndo: () => void; skRedo: () => void;
  setTool: (tool: string, mode?: string) => void;
}

const MAX_UNDO = 100;

export const useApp = create<AppState>((set, get) => ({
  docs: {}, order: [], activeId: null, hist: {}, dirty: {}, builds: {}, preview: null, building: false,
  cmTab: "Features", pm: null, selection: [], hover: null, sketch: null,
  display: { style: "shadedEdges", planes: false, origins: true, sketches: true, axes: true, grid: true, triad: true, section: { on: false, plane: "Front", offset: 0, flip: false }, scene: "gradient", perspective: false },
  options: { gridSpacing: 10, snapGrid: false, snapPoints: true, autoRelations: true, showRelations: true, inputDim: true, singleCommand: false, edgeQuality: "normal", autosaveMin: 10, userName: "Designer", selColor: "#1f9e4a", antialias: true, ...(() => { try { return JSON.parse(localStorage.getItem("openworks.options") || "{}"); } catch { return {}; } })() },
  status: "Ready", cursor: "", dialog: null, menu: null, viewCmd: { seq: 0, kind: "" }, library: loadLibrary(), recent: JSON.parse(localStorage.getItem("openworks.recent") || "[]"), toast: null,
  taskPane: false, taskTab: "library", leftTab: "tree", interference: null, measure: null, shortcutBar: null, pendingPick: null, selFilter: null,

  set: (p) => set(p as any),
  newDoc: (kind) => {
    const docs = get().docs; const count = (k: string) => Object.values(docs).filter(d => d.kind === k).length + 1;
    const d = kind === "part" ? newPart(`Part${count("part")}`) : kind === "assembly" ? newAssembly(`Assembly${count("assembly")}`) : newDrawing(`Draw${count("drawing")}`);
    get().addDoc(d, true);
    set({ cmTab: kind === "part" ? "Features" : kind === "assembly" ? "Assembly" : "View Layout" });
    return d.id;
  },
  addDoc: (d, open = true) => set(s => ({ docs: { ...s.docs, [d.id]: d }, order: open && !s.order.includes(d.id) ? [...s.order, d.id] : s.order, activeId: open ? d.id : s.activeId, hist: { ...s.hist, [d.id]: s.hist[d.id] || { undo: [], redo: [] } }, selection: open ? [] : s.selection, pm: open ? null : s.pm, sketch: open ? null : s.sketch })),
  closeDoc: (id) => set(s => { const order = s.order.filter(x => x !== id); return { order, activeId: s.activeId === id ? order[order.length - 1] || null : s.activeId, pm: null, sketch: null, selection: [] }; }),
  activate: (id) => { const d = get().docs[id]; set({ activeId: id, pm: null, sketch: null, selection: [], cmTab: d?.kind === "part" ? "Features" : d?.kind === "assembly" ? "Assembly" : "View Layout" }); },
  updateDoc: (id, fn, record = true) => set(s => {
    const old = s.docs[id]; if (!old) return {};
    const nd = fn(old); if (nd === old) return {};
    const h = s.hist[id] || { undo: [], redo: [] };
    return { docs: { ...s.docs, [id]: nd }, dirty: { ...s.dirty, [id]: true }, hist: record ? { ...s.hist, [id]: { undo: [...h.undo.slice(-MAX_UNDO), old], redo: [] } } : s.hist };
  }),
  undo: () => {
    const s = get(); if (s.sketch) return s.skUndo();
    const id = s.activeId; if (!id) return; const h = s.hist[id]; if (!h?.undo.length) { s.showToast("Nothing to undo"); return; }
    const prev = h.undo[h.undo.length - 1];
    set({ docs: { ...s.docs, [id]: prev }, hist: { ...s.hist, [id]: { undo: h.undo.slice(0, -1), redo: [...h.redo, s.docs[id]] } }, pm: null, selection: [] });
    s.showToast("Action undone");
  },
  redo: () => {
    const s = get(); if (s.sketch) return s.skRedo();
    const id = s.activeId; if (!id) return; const h = s.hist[id]; if (!h?.redo.length) return;
    const next = h.redo[h.redo.length - 1];
    set({ docs: { ...s.docs, [id]: next }, hist: { ...s.hist, [id]: { undo: [...h.undo, s.docs[id]], redo: h.redo.slice(0, -1) } }, pm: null });
    s.showToast("Action redone");
  },
  saveDoc: (id) => {
    const s = get(); const did = id || s.activeId; if (!did) return; const d = s.docs[did];
    const lib = { ...loadLibrary(), [d.id]: d }; saveLibrary(lib);
    // also save referenced parts of assemblies
    if (d.kind === "assembly") { for (const c of d.components) { const p = s.docs[c.partId]; if (p) lib[p.id] = p; } saveLibrary(lib); }
    const recent = [d.id, ...s.recent.filter(r => r !== d.id)].slice(0, 10); localStorage.setItem("openworks.recent", JSON.stringify(recent));
    set({ library: lib, dirty: { ...s.dirty, [d.id]: false }, recent });
    s.showToast(`Saved “${d.name}” to the browser library`);
  },
  removeFromLibrary: (id) => { const lib = { ...loadLibrary() }; delete lib[id]; saveLibrary(lib); set({ library: lib }); },
  select: (sel, additive = false) => set(s => {
    if (!sel) return { selection: [] };
    const k = selKey(sel); const has = s.selection.some(x => selKey(x) === k);
    if (additive) return { selection: has ? s.selection.filter(x => selKey(x) !== k) : [...s.selection, sel] };
    return { selection: [sel] };
  }),
  setStatus: (status) => set({ status }),
  showToast: (msg) => { const seq = Date.now(); set({ toast: { msg, seq } }); setTimeout(() => { if (get().toast?.seq === seq) set({ toast: null }); }, 2200); },
  cmd: (kind, extra = {}) => set(s => ({ viewCmd: { seq: s.viewCmd.seq + 1, kind, ...extra } })),

  // ───────── Sketch session
  startSketch: (plane, label, featureId) => {
    const s = get(); const doc = s.docs[s.activeId!] as PartDoc; if (!doc || doc.kind !== "part") return;
    let sk: Sketch, name: string, isNew = !featureId;
    if (featureId) { const f = doc.features.find(x => x.id === featureId)!; sk = JSON.parse(JSON.stringify(f.sketch)); name = f.name; }
    else { sk = { id: uid("sk"), plane, planeLabel: label, points: { O: { id: "O", x: 0, y: 0, fixed: true } }, entities: [], constraints: [] }; name = `Sketch${(doc.counters.sketch || 0) + 1}`; }
    const solve = solveSketch(sk);
    set({ sketch: { featureId: featureId || null, name, isNew, sk, solve, tool: "select", mode: "", undo: [], redo: [], toolOpts: { construction: false, sides: 6, inscribed: true, offset: 5, scale: 1, angle: 90 } }, cmTab: "Sketch", pm: null, selection: [], pendingPick: null, status: `Editing ${name}` });
    s.cmd("normal", { plane: sk.plane });
  },
  exitSketch: (ok) => {
    const s = get(); const ss = s.sketch; if (!ss) return; const id = s.activeId!;
    if (ok) {
      const hasGeo = ss.sk.entities.length > 0;
      if (ss.isNew && hasGeo) {
        const f: Feature = { id: uid("f"), type: "sketch", name: ss.name, params: {}, sketch: ss.sk };
        s.updateDoc(id, (d: PartDoc) => { const at = d.rollback ?? d.features.length; const features = d.features.slice(); features.splice(at, 0, f); return { ...d, features, rollback: d.rollback === null ? null : d.rollback + 1, counters: { ...d.counters, sketch: (d.counters.sketch || 0) + 1 } }; });
        set({ selection: [{ kind: "feature", id: f.id }] });
      } else if (!ss.isNew && ss.featureId) {
        s.updateDoc(id, (d: PartDoc) => ({ ...d, features: d.features.map(f => f.id === ss.featureId ? { ...f, sketch: ss.sk } : f) }));
      }
    }
    set({ sketch: null, cmTab: "Features", status: ok ? "Ready" : "Sketch changes discarded" });
  },
  skSet: (sk, opts = {}) => {
    const ss = get().sketch; if (!ss) return false;
    const res = solveSketch(sk, { drag: opts.drag });
    if (!res.ok && !opts.force) { if (opts.drag) return false; }
    const next = res.ok || opts.force ? res.sketch : sk;
    const record = opts.record !== false;
    set({ sketch: { ...ss, sk: next, solve: res, undo: record ? [...ss.undo.slice(-80), ss.sk] : ss.undo, redo: record ? [] : ss.redo } });
    return res.ok;
  },
  skUndo: () => { const ss = get().sketch; if (!ss || !ss.undo.length) return; const prev = ss.undo[ss.undo.length - 1]; set({ sketch: { ...ss, sk: prev, solve: solveSketch(prev), undo: ss.undo.slice(0, -1), redo: [...ss.redo, ss.sk] } }); },
  skRedo: () => { const ss = get().sketch; if (!ss || !ss.redo.length) return; const nx = ss.redo[ss.redo.length - 1]; set({ sketch: { ...ss, sk: nx, solve: solveSketch(nx), redo: ss.redo.slice(0, -1), undo: [...ss.undo, ss.sk] } }); },
  setTool: (tool, mode = "") => { const ss = get().sketch; if (!ss) return; set({ sketch: { ...ss, tool, mode }, selection: tool === "select" || tool === "dimension" || ["trim", "extend", "offset", "mirror", "move", "copy", "rotate", "scale", "convert"].includes(tool) ? get().selection : [] }); },
}));

export const activeDoc = () => { const s = useApp.getState(); return s.activeId ? s.docs[s.activeId] : null; };
export const useActiveDoc = () => useApp(s => (s.activeId ? s.docs[s.activeId] : null));

export function nextName(doc: PartDoc | AssemblyDoc | DrawingDoc, type: string): [string, Record<string, number>] {
  const n = (doc.counters[type] || 0) + 1; const label = FEATURE_LABEL[type] || type;
  return [`${label}${n}`, { ...doc.counters, [type]: n }];
}

/** insert a feature at the rollback position (or end) */
export function insertFeature(docId: string, f: Omit<Feature, "id" | "name"> & { id?: string; name?: string }, counterKey?: string) {
  const st = useApp.getState();
  let fid = f.id || uid("f");
  st.updateDoc(docId, (d: PartDoc) => {
    const [name, counters] = nextName(d, counterKey || f.type);
    const feat: Feature = { ...(f as Feature), id: fid, name: f.name || name };
    const at = d.rollback ?? d.features.length; const features = d.features.slice(); features.splice(at, 0, feat);
    return { ...d, features, counters, rollback: d.rollback === null ? null : d.rollback + 1 };
  });
  return fid;
}
export const unitLabel = (u: UnitSystem) => (u === "IPS" ? "in" : u === "CGS" ? "cm" : u === "MKS" ? "m" : "mm");
export const unitScale = (u: UnitSystem) => (u === "IPS" ? 1 / 25.4 : u === "CGS" ? 0.1 : u === "MKS" ? 0.001 : 1);
export type { FeatureType };
if (import.meta.env.DEV) (window as any).__app = useApp;
