import { useState, useEffect, useRef } from "react";
import { useApp } from "../store";
import { runCommand } from "./actions";
import { Icon } from "./Icons";

type MI = { label: string; cmd?: string; arg?: any; key?: string; icon?: string; sep?: boolean; sub?: MI[]; when?: (k: string | null, sk: boolean) => boolean; checked?: () => boolean };
const sep: MI = { label: "", sep: true };
const isPart = (k: string | null) => k === "part"; const isAsm = (k: string | null) => k === "assembly"; const isDoc = (k: string | null) => !!k;
const disp = (key: string) => () => (useApp.getState().display as any)[key];

const MENUS: Record<string, MI[]> = {
  File: [
    { label: "New…", cmd: "new", key: "Ctrl+N", icon: "new" }, { label: "Open…", cmd: "open", key: "Ctrl+O", icon: "open" }, { label: "Close", cmd: "close", key: "Ctrl+W", when: isDoc }, sep,
    { label: "Save", cmd: "save", key: "Ctrl+S", icon: "save", when: isDoc }, { label: "Save As… (download)", cmd: "saveAs", key: "Ctrl+Shift+S", when: isDoc }, sep,
    { label: "Import", icon: "importI", sub: [{ label: "STEP (*.step, *.stp)…", cmd: "import", arg: "step" }, { label: "STL (*.stl)…", cmd: "import", arg: "stl" }, { label: "OBJ (*.obj)…", cmd: "import", arg: "obj" }, { label: "DXF → sketch (*.dxf)…", cmd: "import", arg: "dxf" }] },
    { label: "Export", icon: "exportI", when: isDoc, sub: [{ label: "STL (*.stl)", cmd: "export", arg: "stl" }, { label: "STEP AP214 (*.step)", cmd: "export", arg: "step" }, { label: "IGES (*.igs)", cmd: "export", arg: "iges" }, { label: "OBJ (*.obj)", cmd: "export", arg: "obj" }, { label: "DXF (sketch / drawing)", cmd: "export", arg: "dxf" }, { label: "SVG (drawing)", cmd: "export", arg: "svg" }, { label: "PDF (drawing)", cmd: "export", arg: "pdf" }, { label: "PNG image", cmd: "export", arg: "png" }] },
    sep, { label: "Print…", cmd: "print", key: "Ctrl+P", icon: "print", when: isDoc }, { label: "Properties…", cmd: "properties", when: isDoc }, sep, { label: "Make Assembly from Part", cmd: "makeAsm", when: isPart }, { label: "Make Drawing from Part / Assembly", cmd: "makeDrw", when: k => isPart(k) || isAsm(k) },
  ],
  Edit: [
    { label: "Undo", cmd: "undo", key: "Ctrl+Z", icon: "undo" }, { label: "Redo", cmd: "redo", key: "Ctrl+Y", icon: "redo" }, sep,
    { label: "Cut", cmd: "cutClip", key: "Ctrl+X" }, { label: "Copy", cmd: "copy", key: "Ctrl+C" }, { label: "Paste", cmd: "paste", key: "Ctrl+V" }, { label: "Delete", cmd: "delete", key: "Del", icon: "delete" }, sep,
    { label: "Select All", cmd: "selectAll", key: "Ctrl+A" }, { label: "Rebuild", cmd: "rebuild", key: "Ctrl+B", icon: "rebuild" }, { label: "Force Rebuild", cmd: "forceRebuild", key: "Ctrl+Q" }, sep,
    { label: "Appearance…", cmd: "appearance", icon: "appearance", when: isPart }, { label: "Equations…", cmd: "equations", icon: "equations", when: isPart }, { label: "Design Table…", cmd: "designTable", icon: "designTable", when: isPart },
  ],
  View: [
    { label: "Display", sub: [{ label: "Shaded With Edges", cmd: "style", arg: "shadedEdges", checked: () => useApp.getState().display.style === "shadedEdges" }, { label: "Shaded", cmd: "style", arg: "shaded", checked: () => useApp.getState().display.style === "shaded" }, { label: "Hidden Lines Removed", cmd: "style", arg: "hlr", checked: () => useApp.getState().display.style === "hlr" }, { label: "Hidden Lines Visible", cmd: "style", arg: "hlv", checked: () => useApp.getState().display.style === "hlv" }, { label: "Wireframe", cmd: "style", arg: "wire", checked: () => useApp.getState().display.style === "wire" }, sep, { label: "Section View", cmd: "section", checked: () => useApp.getState().display.section.on }] },
    { label: "Modify", sub: [{ label: "Zoom to Fit", cmd: "zoomFit", key: "F" }, { label: "Zoom to Area", cmd: "zoomArea" }, { label: "Zoom In", cmd: "zoomIn", key: "Shift+Z" }, { label: "Zoom Out", cmd: "zoomOut", key: "Z" }, { label: "Previous View", cmd: "prevView" }] },
    { label: "Orientation", sub: [["Front", "front", "Ctrl+1"], ["Back", "back", "Ctrl+2"], ["Left", "left", "Ctrl+3"], ["Right", "right", "Ctrl+4"], ["Top", "top", "Ctrl+5"], ["Bottom", "bottom", "Ctrl+6"], ["Isometric", "iso", "Ctrl+7"], ["Trimetric", "trimetric", ""], ["Dimetric", "dimetric", ""]].map(([l, a, k]) => ({ label: l, cmd: "view", arg: a, key: k })).concat([{ label: "Normal To", cmd: "normalTo", arg: "", key: "Ctrl+8" }]) },
    sep,
    { label: "Planes", cmd: "toggle", arg: "planes", checked: disp("planes") }, { label: "Origins", cmd: "toggle", arg: "origins", checked: disp("origins") }, { label: "Axes", cmd: "toggle", arg: "axes", checked: disp("axes") }, { label: "Sketches", cmd: "toggle", arg: "sketches", checked: disp("sketches") }, { label: "Grid", cmd: "toggle", arg: "grid", checked: disp("grid") }, { label: "View Triad", cmd: "toggle", arg: "triad", checked: disp("triad") }, sep,
    { label: "Task Pane", cmd: "taskPane", checked: () => useApp.getState().taskPane },
  ],
  Insert: [
    { label: "Boss/Base", when: isPart, sub: [{ label: "Extrude…", cmd: "extrude", icon: "extrude" }, { label: "Revolve…", cmd: "revolve", icon: "revolve" }, { label: "Sweep…", cmd: "sweep", icon: "sweep" }, { label: "Loft…", cmd: "loft", icon: "loft" }] },
    { label: "Cut", when: isPart, sub: [{ label: "Extrude…", cmd: "cut", icon: "cut" }, { label: "Revolve…", cmd: "revolveCut", icon: "revolveCut" }, { label: "Sweep…", cmd: "sweepCut", icon: "sweepCut" }, { label: "Loft…", cmd: "loftCut", icon: "loftCut" }] },
    { label: "Features", when: isPart, sub: [{ label: "Fillet…", cmd: "fillet", icon: "fillet" }, { label: "Chamfer…", cmd: "chamfer", icon: "chamfer" }, { label: "Shell…", cmd: "shell", icon: "shell" }, { label: "Draft…", cmd: "draft", icon: "draft" }, { label: "Hole Wizard…", cmd: "hole", icon: "hole" }] },
    { label: "Pattern/Mirror", when: isPart, sub: [{ label: "Linear Pattern…", cmd: "linearPattern", icon: "linearPattern" }, { label: "Circular Pattern…", cmd: "circularPattern", icon: "circularPattern" }, { label: "Mirror…", cmd: "mirror", icon: "mirror" }] },
    { label: "Reference Geometry", when: isPart, sub: [{ label: "Plane…", cmd: "plane", icon: "plane" }, { label: "Axis…", cmd: "axis", icon: "axis" }] },
    { label: "Sketch", cmd: "sketch", icon: "sketch", when: isPart },
    { label: "Component", when: isAsm, sub: [{ label: "Existing Part…", cmd: "insertComp", icon: "insertComp" }] },
    { label: "Mate…", cmd: "mate", icon: "mate", when: isAsm }, { label: "Exploded View…", cmd: "explode", icon: "explode", when: isAsm },
  ],
  Tools: [
    { label: "Sketch Entities", when: isPart, sub: ["line", "centerline", "circle", "rect", "arc", "polygon", "slot", "ellipse", "spline", "point"].map(t => ({ label: t[0].toUpperCase() + t.slice(1), cmd: t, icon: t })) },
    { label: "Sketch Tools", when: (k, sk) => isPart(k) && sk, sub: [{ label: "Trim", cmd: "trim", icon: "trim" }, { label: "Extend", cmd: "extend", icon: "extend" }, { label: "Offset Entities", cmd: "offset", icon: "offset" }, { label: "Mirror Entities", cmd: "sketchMirror", icon: "sketchMirror" }, { label: "Convert Entities", cmd: "convert", icon: "convert" }, { label: "Move", cmd: "move", icon: "move" }, { label: "Rotate", cmd: "rotate", icon: "rotate" }, { label: "Scale", cmd: "scale", icon: "scale" }, { label: "Linear Sketch Pattern", cmd: "sketchLinear", icon: "linearPattern" }, { label: "Circular Sketch Pattern", cmd: "sketchCircular", icon: "circularPattern" }] },
    { label: "Dimensions", when: isPart, sub: [{ label: "Smart Dimension", cmd: "dimension", icon: "dimension" }] },
    { label: "Relations", when: (k, sk) => isPart(k) && sk, sub: [{ label: "Add…", cmd: "relations", icon: "relations" }] },
    sep,
    { label: "Evaluate", sub: [{ label: "Measure…", cmd: "measure", icon: "measure" }, { label: "Mass Properties…", cmd: "massProps", icon: "massProps" }, { label: "Check…", cmd: "check", icon: "check" }, { label: "Interference Detection…", cmd: "interference", icon: "interference", when: isAsm }, { label: "Assembly Statistics", cmd: "asmStats", icon: "stats", when: isAsm }] },
    { label: "Material…", cmd: "material", icon: "material", when: isPart }, sep, { label: "Options…", cmd: "options", icon: "options" },
  ],
  Window: [{ label: "Task Pane", cmd: "taskPane" }],
  Help: [{ label: "Quick Reference / Shortcuts", cmd: "help", icon: "help", key: "F1" }, { label: "Open Sample Bracket", cmd: "sample" }, { label: "Open Sample Assembly", cmd: "sampleAsm" }, sep, { label: "About OpenWorks CAD", cmd: "about" }],
};

export function exec(item: MI) {
  if (!item.cmd) return;
  if (item.cmd === "sample") return window.dispatchEvent(new CustomEvent("cad:sample"));
  if (item.cmd === "sampleAsm") return import("./samples").then(m => m.makeSampleAssembly());
  if (item.cmd === "makeAsm") return import("./actions").then(m => m.newAssemblyFromPart());
  if (item.cmd === "makeDrw") { const s = useApp.getState(); const src = s.activeId!; const id = s.newDoc("drawing"); const sd = s.docs[src]; s.updateDoc(id, d => ({ ...d, sourceId: src, title: { ...d.title, title: sd.name, partNo: sd.name, material: (sd as any).material || "" } }), false); return; }
  runCommand(item.cmd, item.arg);
}

function MenuList({ items, close }: { items: MI[]; close: () => void }) {
  const kind = useApp(s => s.activeId ? s.docs[s.activeId]?.kind ?? null : null); const sk = useApp(s => !!s.sketch);
  const [sub, setSub] = useState<number | null>(null);
  return <div className="dropdown" onMouseLeave={() => setSub(null)}>
    {items.map((it, i) => it.sep ? <div key={i} className="dd-sep" /> : (() => {
      const dis = it.when ? !it.when(kind, sk) : false;
      return <div key={i} className={`dd-item ${dis ? "disabled" : ""} ${it.sub ? "has-sub" : ""}`} onMouseEnter={() => setSub(it.sub ? i : null)} onClick={e => { e.stopPropagation(); if (dis || it.sub) return; exec(it); close(); }}>
        <span className="dd-ico">{it.checked ? (it.checked() ? "✓" : "") : it.icon ? <Icon name={it.icon} size={16} /> : null}</span>
        <span className="dd-label">{it.label}</span>
        <span className="dd-key">{it.key || (it.sub ? "▸" : "")}</span>
        {it.sub && sub === i && !dis && <div className="dd-sub"><MenuList items={it.sub} close={close} /></div>}
      </div>;
    })())}
  </div>;
}

export function MenuBar() {
  const [open, setOpen] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const s = useApp();
  const doc = s.activeId ? s.docs[s.activeId] : null;
  useEffect(() => { const f = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(null); }; window.addEventListener("mousedown", f); return () => window.removeEventListener("mousedown", f); }, []);
  const [q, setQ] = useState("");
  const all = Object.values(MENUS).flatMap(m => m.flatMap(i => i.sub ? i.sub : [i])).filter(i => i.cmd && !i.sep);
  const hits = q ? all.filter(i => i.label.toLowerCase().includes(q.toLowerCase())).slice(0, 8) : [];
  return (
    <div className="menubar" ref={ref}>
      <div className="logo" title="OpenWorks CAD"><span>OW</span><b>OpenWorks</b></div>
      <div className="menus">
        {Object.keys(MENUS).map(m => <div key={m} className={`menu ${open === m ? "open" : ""}`} onMouseDown={e => { e.stopPropagation(); setOpen(open === m ? null : m); }} onMouseEnter={() => open && setOpen(m)}>
          {m}{open === m && <div onMouseDown={e => e.stopPropagation()}><MenuList items={MENUS[m]} close={() => setOpen(null)} /></div>}
        </div>)}
      </div>
      <div className="qat">
        {[["new", "new", "New (Ctrl+N)"], ["open", "open", "Open (Ctrl+O)"], ["save", "save", "Save (Ctrl+S)"], ["print", "print", "Print"], ["undo", "undo", "Undo (Ctrl+Z)"], ["redo", "redo", "Redo (Ctrl+Y)"], ["rebuild", "rebuild", "Rebuild (Ctrl+B)"], ["options", "options", "Options"]].map(([c, ic, t]) => <button key={c} title={t} onClick={() => runCommand(c)}><Icon name={ic} size={18} /></button>)}
      </div>
      <div className="doc-tabs">
        {s.order.map(id => { const d = s.docs[id]; if (!d) return null; return <div key={id} className={`doc-tab ${id === s.activeId ? "active" : ""}`} onClick={() => s.activate(id)} title={d.name}>
          <Icon name={d.kind} size={14} /> <span>{d.name}{s.dirty[id] ? " *" : ""}</span>
          <i onClick={e => { e.stopPropagation(); if (s.dirty[id] && !confirm(`Close “${d.name}” without saving changes?`)) return; s.closeDoc(id); }}>×</i>
        </div>; })}
      </div>
      <div className="title">{doc ? `${doc.name}${s.sketch ? ` — ${s.sketch.name}` : ""}` : "OpenWorks CAD"}</div>
      <div className="search">
        <input placeholder="Search Commands" value={q} onChange={e => setQ(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && hits[0]) { exec(hits[0]); setQ(""); } if (e.key === "Escape") setQ(""); }} />
        {hits.length > 0 && <div className="dropdown search-hits">{hits.map((h, i) => <div key={i} className="dd-item" onMouseDown={() => { exec(h); setQ(""); }}><span className="dd-ico">{h.icon && <Icon name={h.icon} size={16} />}</span><span className="dd-label">{h.label}</span><span className="dd-key">{h.key || ""}</span></div>)}</div>}
      </div>
    </div>
  );
}
