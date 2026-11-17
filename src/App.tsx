import { useEffect } from "react";
import { useApp, effectiveFeatures } from "./store";
import type { PartDoc, AssemblyDoc, DrawingDoc, Feature } from "./types";
import { kernel, kernelStatus } from "./kernel/client";
import Viewport from "./viewport/Viewport";
import { MenuBar } from "./ui/MenuBar";
import { CommandManager } from "./ui/CommandManager";
import { LeftPanel } from "./ui/LeftPanel";
import { HeadsUp } from "./ui/HeadsUp";
import { StatusBar } from "./ui/StatusBar";
import { TaskPane } from "./ui/TaskPane";
import { Dialogs } from "./ui/Dialogs";
import { ContextMenu, ShortcutBar, Toast } from "./ui/Overlays";
import { DrawingSheet } from "./drawing/DrawingSheet";
import { pmConfirm, pmCancel, openFeaturePM, resolveAssembly } from "./ui/pm";
import { runCommand, editFeature, startSketchCmd } from "./ui/actions";
import { makeSampleBracket } from "./ui/samples";
import { ErrorBoundary } from "./ui/ErrorBoundary";

const st = () => useApp.getState();
const PREVIEW_TYPES = new Set(["extrude", "cut", "revolve", "revolveCut", "sweep", "sweepCut", "loft", "loftCut", "fillet", "chamfer", "shell", "draft", "hole", "linearPattern", "circularPattern", "mirror", "plane", "axis"]);

// ───────── build pipeline (debounced, serial)
const lastKey: Record<string, string> = {};
let lastPreviewKey = ""; let timer: any = null; let running = false; let again = false; let forceAll = false;
let shownErr = "";
function neededParts(): string[] {
  const s = st(); const out = new Set<string>(); const d = s.activeId ? s.docs[s.activeId] : null;
  const addAsm = (a: AssemblyDoc) => a.components.forEach(c => out.add(c.partId));
  if (d?.kind === "part") out.add(d.id);
  if (d?.kind === "assembly") addAsm(d);
  if (d?.kind === "drawing" && d.sourceId) { const src = s.docs[d.sourceId]; if (src?.kind === "part") out.add(src.id); if (src?.kind === "assembly") addAsm(src); }
  return [...out].filter(id => s.docs[id]?.kind === "part");
}
export function scheduleBuild(delay = 90) { clearTimeout(timer); timer = setTimeout(runBuilds, delay); }
async function runBuilds() {
  if (running) { again = true; return; }
  if (!kernelStatus.ready) { scheduleBuild(300); return; }
  running = true;
  try {
    // 1) part bodies
    for (const id of neededParts()) {
      const doc = st().docs[id] as PartDoc; const feats = effectiveFeatures(doc); const key = JSON.stringify(feats);
      if (!forceAll && lastKey[id] === key && st().builds[id]) continue;
      useApp.setState({ building: true });
      try {
        const r = await kernel.build(feats); lastKey[id] = key;
        useApp.setState(s => ({ builds: { ...s.builds, [id]: r } }));
        const errs = Object.entries(r.errors || {}); const sig = errs.map(e => e.join(":")).join("|");
        if (errs.length && sig !== shownErr) { const f = doc.features.find(x => x.id === errs[0][0]); st().showToast(`⚠ ${f?.name || "Feature"}: ${errs[0][1]}`); }
        shownErr = sig;
        const a = st().activeId ? st().docs[st().activeId!] : null; if (a?.kind === "assembly" && a.mates.length) resolveAssembly();
      } catch (e) { lastKey[id] = key; st().showToast("Rebuild error: " + (e as Error).message); }
    }
    forceAll = false;
    // 2) PropertyManager preview
    const s = st(); const pm = s.pm; const d = s.activeId ? s.docs[s.activeId] : null;
    if (pm && d?.kind === "part" && PREVIEW_TYPES.has(pm.type)) {
      let list: Feature[], index: number;
      if (pm.editId) { list = effectiveFeatures(d, true); index = list.findIndex(f => f.id === pm.editId); }
      else { list = effectiveFeatures(d).slice(); index = Math.min(pm.index, list.length); list.splice(index, 0, pm.draft); }
      const key = JSON.stringify([d.id, list.slice(0, index), pm.draft]);
      if (key !== lastPreviewKey && index >= 0) {
        lastPreviewKey = key; useApp.setState({ building: true });
        try { const r = await kernel.build(list, { edit: { index, feature: pm.draft } }); if (st().pm && st().pm!.draft.id === pm.draft.id) useApp.setState({ preview: r }); }
        catch (e) { useApp.setState({ preview: null }); st().setStatus("Preview failed: " + (e as Error).message); }
      }
    } else { lastPreviewKey = ""; if (s.preview) useApp.setState({ preview: null }); }
  } finally { running = false; useApp.setState({ building: false }); if (again) { again = false; scheduleBuild(10); } }
}

export default function App() {
  const activeKind = useApp(s => s.activeId ? s.docs[s.activeId]?.kind : null);
  const taskPane = useApp(s => s.taskPane);

  useEffect(() => {
    kernel.init(); kernelStatus.listeners.add(() => { useApp.setState({ status: "Geometry kernel ready" }); scheduleBuild(0); });
    const unsub = useApp.subscribe((s, p) => { if (s.docs !== p.docs || s.activeId !== p.activeId || s.pm !== p.pm) scheduleBuild(s.pm !== p.pm ? 140 : 60); });
    const onPM = (e: Event) => { const v = (e as CustomEvent).detail; if (v === "ok") pmConfirm(); else if (v === "keep") pmConfirm(true); else pmCancel(); };
    const onEdit = (e: Event) => editFeature((e as CustomEvent).detail);
    const onSample = () => makeSampleBracket();
    const onRebuild = (e: Event) => { if ((e as CustomEvent).detail) { forceAll = true; for (const k in lastKey) delete lastKey[k]; } scheduleBuild(0); };
    const onResolve = () => resolveAssembly();
    const onOpenPM = (e: Event) => openFeaturePM((e as CustomEvent).detail);
    window.addEventListener("cad:pm", onPM); window.addEventListener("cad:editFeature", onEdit); window.addEventListener("cad:sample", onSample);
    window.addEventListener("cad:rebuild", onRebuild); window.addEventListener("cad:resolve", onResolve); window.addEventListener("cad:openPM", onOpenPM);
    const onBefore = (e: BeforeUnloadEvent) => { if (Object.values(st().dirty).some(Boolean)) { e.preventDefault(); e.returnValue = ""; } };
    window.addEventListener("beforeunload", onBefore);
    // autosave to browser library
    const iv = setInterval(() => { const s = st(); const m = s.options.autosaveMin; if (!m) return; for (const id of s.order) if (s.dirty[id]) { const lib = JSON.parse(localStorage.getItem("openworks.autosave") || "{}"); lib[id] = s.docs[id]; try { localStorage.setItem("openworks.autosave", JSON.stringify(lib)); } catch { /* quota */ } } }, 60000);
    return () => { unsub(); clearInterval(iv); window.removeEventListener("cad:pm", onPM); window.removeEventListener("cad:editFeature", onEdit); window.removeEventListener("cad:sample", onSample); window.removeEventListener("cad:rebuild", onRebuild); window.removeEventListener("cad:resolve", onResolve); window.removeEventListener("cad:openPM", onOpenPM); window.removeEventListener("beforeunload", onBefore); };
  }, []);

  // ───────── keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement; if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      const s = st(); const ctrl = e.ctrlKey || e.metaKey; const k = e.key.toLowerCase();
      const go = (fn: () => void) => { e.preventDefault(); fn(); };
      if (ctrl) {
        if (k === "z") return go(() => e.shiftKey ? s.redo() : s.undo());
        if (k === "y") return go(() => s.redo());
        if (k === "s") return go(() => e.shiftKey ? runCommand("saveAs") : runCommand("save"));
        if (k === "o") return go(() => runCommand("open"));
        if (k === "n") return go(() => runCommand("new"));
        if (k === "q") return go(() => runCommand("forceRebuild"));
        if (k === "b") return go(() => runCommand("rebuild"));
        if (k === "a") return go(() => runCommand("selectAll"));
        if (k === "c") return go(() => runCommand("copy"));
        if (k === "v") return go(() => runCommand("paste"));
        if (k === "x") return go(() => runCommand("cutClip"));
        if (k === "p") return go(() => runCommand("print"));
        if (k === "w") return go(() => runCommand("close"));
        const views: Record<string, string> = { "1": "front", "2": "back", "3": "left", "4": "right", "5": "top", "6": "bottom", "7": "iso" };
        if (views[e.key]) return go(() => s.cmd(views[e.key]));
        if (e.key === "8") return go(() => runCommand("normalTo"));
        return;
      }
      if (e.altKey) return;
      if (e.key === "Escape") {
        if (s.menu || s.shortcutBar) return useApp.setState({ menu: null, shortcutBar: null });
        if (s.dialog) return useApp.setState({ dialog: null });
        if (s.cursor) return useApp.setState({ cursor: "", status: "Ready" });
        if (s.pendingPick) return useApp.setState({ pendingPick: null, status: "Ready" });
        if (s.sketch && s.sketch.tool !== "select") return s.setTool("select");
        if (s.pm) return pmCancel();
        if (s.selection.length) return s.select(null);
        return;
      }
      if (e.key === "Delete") return go(() => runCommand("delete"));
      if (e.key === "Enter" && s.pm) return go(() => pmConfirm());
      if (k === "f") return go(() => s.cmd("fit"));
      if (k === "z") return go(() => s.cmd(e.shiftKey ? "zoomIn" : "zoomOut"));
      if (k === "s") return go(() => { const vp = document.querySelector(".viewport") as HTMLElement; const r = vp?.getBoundingClientRect(); useApp.setState({ shortcutBar: { x: lastMouse[0] || (r ? r.left + r.width / 2 : 400), y: lastMouse[1] || (r ? r.top + r.height / 2 : 300) } }); });
      if (e.key === " ") return go(() => useApp.setState({ dialog: { name: "orientation" } }));
      const d = s.activeId ? s.docs[s.activeId] : null;
      if (d?.kind === "part") {
        const sk: Record<string, string> = { l: "line", c: "circle", r: "rect", a: "arc", d: "dimension", t: "trim", p: "polygon", n: "centerline" };
        if (sk[k] && !e.shiftKey) return go(() => runCommand(sk[k]));
        if (k === "e" && s.sketch) return go(() => s.exitSketch(true));
      }
    };
    const lastMouse: [number, number] = [0, 0];
    const onMove = (e: MouseEvent) => { lastMouse[0] = e.clientX; lastMouse[1] = e.clientY; };
    window.addEventListener("keydown", onKey); window.addEventListener("mousemove", onMove);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("mousemove", onMove); };
  }, []);

  return (
    <div className="app" onClick={() => { if (st().menu) useApp.setState({ menu: null }); }}>
      <MenuBar />
      <ErrorBoundary name="CommandManager"><CommandManager /></ErrorBoundary>
      <div className="main">
        <ErrorBoundary name="FeatureManager"><LeftPanel /></ErrorBoundary>
        <div className="center">
          <ErrorBoundary name={activeKind === "drawing" ? "Drawing sheet" : "Graphics area"}>{activeKind === "drawing" ? <DrawingSheet /> : <Viewport />}</ErrorBoundary>
          {activeKind !== "drawing" && <HeadsUp />}
        </div>
        {taskPane && <ErrorBoundary name="Task pane"><TaskPane /></ErrorBoundary>}
        <div className="task-tabs">
          {[["library", "Design Library"], ["explorer", "File Explorer"], ["appearance", "Appearances"], ["config", "Custom Properties"]].map(([ic, t]) => <button key={ic} title={t} onClick={() => useApp.setState(s => ({ taskPane: s.taskPane && (s as any).taskTab === ic ? false : true, taskTab: ic } as any))}><TaskIcon name={ic} /></button>)}
        </div>
      </div>
      <StatusBar />
      <ErrorBoundary name="Dialog" onReset={() => useApp.setState({ dialog: null })}><Dialogs /></ErrorBoundary>
      <ContextMenu />
      <ShortcutBar />
      <Toast />
    </div>
  );
}
import { Icon } from "./ui/Icons";
const TaskIcon = ({ name }: { name: string }) => <Icon name={name} size={18} />;
export { startSketchCmd };
