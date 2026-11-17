import { useState, useEffect, useMemo, type ReactNode } from "react";
import { useApp, childrenOf, parentsOf, selKey, type Sel } from "../store";
import type { PartDoc, AssemblyDoc, DrawingDoc, Feature, Sketch } from "../types";
import { Icon } from "./Icons";
import { PropertyManager } from "./PropertyManager";
import { treeContextMenu } from "./contextMenus";
import { editFeature, isSuppressed } from "./actions";
import { pmBus } from "./pmBus";
import { solveSketch } from "../sketch/solver";
import { PLANES } from "../math";

const st = () => useApp.getState();
const skStatusCache = new WeakMap<Sketch, string>();
function skPrefix(sk?: Sketch): string {
  if (!sk) return ""; let v = skStatusCache.get(sk);
  if (v === undefined) { try { const r = solveSketch(sk); v = r.status === "over" ? "(+) " : r.status === "full" ? "" : "(-) "; } catch { v = ""; } skStatusCache.set(sk, v); }
  return v;
}
const FT_ICON: Record<string, string> = { sketch: "sketch", extrude: "extrude", cut: "cut", revolve: "revolve", revolveCut: "revolveCut", sweep: "sweep", sweepCut: "sweepCut", loft: "loft", loftCut: "loftCut", fillet: "fillet", chamfer: "chamfer", shell: "shell", draft: "draft", hole: "hole", linearPattern: "linearPattern", circularPattern: "circularPattern", mirror: "mirror", plane: "plane", axis: "axis", point: "point", import: "importI" };

function treeSelect(sel: Sel, additive: boolean) {
  const s = st();
  if (s.pm && pmBus.pick && pmBus.pick(sel, additive)) return;
  if (s.pendingPick === "sketchPlane" && sel.kind === "plane") { s.startSketch(sel.plane, sel.plane.name || sel.id); return; }
  s.select(sel, additive);
}

export function LeftPanel() {
  const s = useApp(); const doc = s.activeId ? s.docs[s.activeId] : null;
  const showPM = !!s.pm || !!s.sketch;
  const [tab, setTab] = useState<"tree" | "pm" | "config" | "props">("tree");
  useEffect(() => { if (showPM) setTab("pm"); else if (tab === "pm") setTab("tree"); }, [showPM, s.pm?.type, s.sketch?.featureId]);
  const [w, setW] = useState(270);
  return (
    <div className="left" style={{ width: w }}>
      <div className="lp-tabs">
        <button className={tab === "tree" ? "active" : ""} title="FeatureManager Design Tree" onClick={() => setTab("tree")}><Icon name={doc?.kind === "assembly" ? "assembly" : doc?.kind === "drawing" ? "drawing" : "part"} size={16} /></button>
        <button className={tab === "pm" ? "active" : ""} title="PropertyManager" onClick={() => setTab("pm")}><Icon name="config" size={16} /></button>
        <button className={tab === "config" ? "active" : ""} title="ConfigurationManager" onClick={() => setTab("config")}><Icon name="designTable" size={16} /></button>
        <button className={tab === "props" ? "active" : ""} title="Custom Properties" onClick={() => setTab("props")}><Icon name="note" size={16} /></button>
      </div>
      <div className="lp-body">
        {!doc && <div className="lp-empty">No document open.<br /><br />File ▸ New, or use the buttons in the graphics area.</div>}
        {doc && tab === "tree" && (doc.kind === "part" ? <PartTree doc={doc} /> : doc.kind === "assembly" ? <AsmTree doc={doc} /> : <DrawTree doc={doc} />)}
        {doc && tab === "pm" && <PropertyManager />}
        {doc && tab === "config" && <ConfigManager />}
        {doc && tab === "props" && <CustomProps />}
      </div>
      <div className="lp-resize" onPointerDown={e => { const x0 = e.clientX, w0 = w; const mv = (ev: PointerEvent) => setW(Math.max(200, Math.min(520, w0 + ev.clientX - x0))); const up = () => { window.removeEventListener("pointermove", mv); window.removeEventListener("pointerup", up); }; window.addEventListener("pointermove", mv); window.addEventListener("pointerup", up); }} />
    </div>
  );
}

function Row({ icon, label, depth = 0, selected, onClick, onDbl, onCtx, cls = "", children, open, setOpen, err, drag, title }: { icon: string; label: ReactNode; depth?: number; selected?: boolean; onClick?: (e: React.MouseEvent) => void; onDbl?: () => void; onCtx?: (e: React.MouseEvent) => void; cls?: string; children?: ReactNode; open?: boolean; setOpen?: (v: boolean) => void; err?: string; drag?: any; title?: string }) {
  return <>
    <div className={`tree-row ${selected ? "sel" : ""} ${cls}`} style={{ paddingLeft: 6 + depth * 16 }} onClick={onClick} onDoubleClick={onDbl} onContextMenu={e => { e.preventDefault(); e.stopPropagation(); onCtx?.(e); }} title={err || title} {...drag}>
      <span className="tw" onClick={e => { e.stopPropagation(); setOpen?.(!open); }}>{children ? (open ? "▾" : "▸") : ""}</span>
      <Icon name={icon} size={16} />
      <span className="tl">{label}</span>
      {err && <span className="terr">✖</span>}
    </div>
    {open && children}
  </>;
}

function PartTree({ doc }: { doc: PartDoc }) {
  const s = useApp(); const build = s.builds[doc.id]; const errors = build?.errors || {};
  const selKeys = new Set(s.selection.map(selKey));
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [renaming, setRenaming] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);
  useEffect(() => { const f = (e: Event) => setRenaming((e as CustomEvent).detail); window.addEventListener("cad:rename", f); return () => window.removeEventListener("cad:rename", f); }, []);
  useEffect(() => { const f = (e: KeyboardEvent) => { if (e.key === "F2") { const sel = st().selection.find(x => x.kind === "feature") as any; if (sel) setRenaming(sel.id); } }; window.addEventListener("keydown", f); return () => window.removeEventListener("keydown", f); }, []);
  const rb = doc.rollback ?? doc.features.length;
  // absorbed sketches (consumed by a later feature) are nested under it
  const absorbed = useMemo(() => { const m: Record<string, string[]> = {}; const used = new Set<string>(); for (const f of doc.features) { if (f.type === "sketch") continue; const ids = [f.params?.sketchId, f.params?.profileId, f.params?.pathId, ...(f.params?.profiles || [])].filter(Boolean); for (const id of ids) if (!used.has(id) && doc.features.find(g => g.id === id)) { (m[f.id] ||= []).push(id); used.add(id); } } return { m, used }; }, [doc.features]);
  const cfg = doc.configs.find(c => c.id === doc.activeConfig);

  const moveFeature = (id: string, to: number) => {
    const from = doc.features.findIndex(f => f.id === id); if (from < 0) return; const f = doc.features[from];
    const list = doc.features.filter(x => x.id !== id); let at = to > from ? to - 1 : to;
    const parents = parentsOf(doc, f); const kids = childrenOf(doc, id);
    const ixOf = (fid: string) => list.findIndex(x => x.id === fid);
    const maxParent = Math.max(-1, ...parents.map(ixOf)); const minChild = Math.min(list.length, ...kids.map(ixOf).filter(i => i >= 0));
    if (at <= maxParent || at > minChild) { s.showToast(`Cannot reorder ${f.name}: it would come ${at <= maxParent ? "before a feature it depends on" : "after a feature that depends on it"}`); return; }
    list.splice(at, 0, f); s.updateDoc(doc.id, (d: PartDoc) => ({ ...d, features: list }));
  };
  const featRow = (f: Feature, idx: number, depth: number): ReactNode => {
    const sup = isSuppressed(doc, f); const rolled = idx >= rb; const err = errors[f.id];
    const kids = absorbed.m[f.id] || [];
    const label = renaming === f.id
      ? <input className="rename" autoFocus defaultValue={f.name} onClick={e => e.stopPropagation()} onKeyDown={e => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") setRenaming(null); e.stopPropagation(); }} onBlur={e => { const v = e.target.value.trim(); if (v && v !== f.name) s.updateDoc(doc.id, (d: PartDoc) => ({ ...d, features: d.features.map(x => x.id === f.id ? { ...x, name: v } : x) })); setRenaming(null); }} />
      : <>{f.type === "sketch" ? skPrefix(f.sketch) : ""}{f.name}{f.type === "sketch" && f.params?.hidden ? " (hidden)" : ""}</>;
    return <div key={f.id} className={dropAt === idx && dragId ? "drop-before" : ""}
      onDragOver={e => { if (!dragId) return; e.preventDefault(); setDropAt(idx); }} onDrop={e => { e.preventDefault(); if (dragId === "__rollback") s.updateDoc(doc.id, (d: PartDoc) => ({ ...d, rollback: idx >= d.features.length ? null : idx }), false); else if (dragId) moveFeature(dragId, idx); setDragId(null); setDropAt(null); }}>
      <Row icon={FT_ICON[f.type] || "help"} label={label} depth={depth} selected={selKeys.has(`feature:${f.id}`)} err={err}
        cls={`${sup ? "suppressed" : ""} ${rolled ? "rolled" : ""} ${err ? "error" : ""}`}
        onClick={e => treeSelect({ kind: "feature", id: f.id }, e.ctrlKey || e.shiftKey)}
        onDbl={() => editFeature(f.id)} onCtx={e => { s.select({ kind: "feature", id: f.id }); treeContextMenu(e.clientX, e.clientY, "feature", f.id); }}
        open={!!open[f.id]} setOpen={v => setOpen({ ...open, [f.id]: v })}
        drag={{ draggable: depth === 0, onDragStart: (e: React.DragEvent) => { e.dataTransfer.setData("text/plain", f.id); setDragId(f.id); }, onDragEnd: () => { setDragId(null); setDropAt(null); } }}>
        {kids.length ? kids.map(k => { const kf = doc.features.find(x => x.id === k)!; return featRow(kf, doc.features.indexOf(kf), depth + 1); }) : undefined}
      </Row>
    </div>;
  };
  const planeRow = (key: "Front" | "Top" | "Right") => <Row key={key} icon="plane" label={`${key} Plane`} selected={selKeys.has(`plane:${key}`)} onClick={e => treeSelect({ kind: "plane", id: key, plane: PLANES[key] }, e.ctrlKey)} onCtx={e => { s.select({ kind: "plane", id: key, plane: PLANES[key] }); treeContextMenu(e.clientX, e.clientY, "plane", key); }} />;
  const top = doc.features.map((f, i) => ({ f, i })).filter(({ f }) => !absorbed.used.has(f.id));
  const rbRow = <div key="rb" className={`rollback-bar ${dragId === "__rollback" ? "dragging" : ""}`} draggable title="Rollback bar — drag to roll back features"
    onDragStart={e => { e.dataTransfer.setData("text/plain", "rb"); setDragId("__rollback"); }} onDragEnd={() => { setDragId(null); setDropAt(null); }} />;
  const rows: ReactNode[] = []; let rbPlaced = false;
  for (const { f, i } of top) { if (!rbPlaced && i >= rb) { rows.push(rbRow); rbPlaced = true; } rows.push(featRow(f, i, 0)); }
  if (!rbPlaced) rows.push(rbRow);
  return <div className="tree" onClick={e => { if (e.target === e.currentTarget) s.select(null); }}>
    <Row icon="part" label={<b>{doc.name} <span className="muted">({cfg?.name || "Default"})</span></b>} onCtx={e => treeContextMenu(e.clientX, e.clientY, "root", doc.id)} />
    <Row icon="sensor" label="Sensors" depth={1} />
    <Row icon="annotations" label="Annotations" depth={1} />
    <Row icon="material" label={doc.material || "Material <not specified>"} depth={1} onDbl={() => s.set({ dialog: { name: "material" } })} onCtx={e => treeContextMenu(e.clientX, e.clientY, "material", doc.id)} />
    <div style={{ marginLeft: 16 }}>{planeRow("Front")}{planeRow("Top")}{planeRow("Right")}
      <Row icon="origin" label="Origin" selected={selKeys.has("origin")} onClick={() => treeSelect({ kind: "origin" }, false)} /></div>
    <div className="tree-features" style={{ marginLeft: 16 }} onDragOver={e => { if (dragId) { e.preventDefault(); } }} onDrop={e => { e.preventDefault(); if (dropAt === null) { if (dragId === "__rollback") s.updateDoc(doc.id, (d: PartDoc) => ({ ...d, rollback: null }), false); else if (dragId) moveFeature(dragId, doc.features.length); } setDragId(null); setDropAt(null); }}>
      {rows}
      <div className="drop-end" onDragOver={e => { if (dragId) { e.preventDefault(); setDropAt(null); } }} />
    </div>
    {doc.features.length === 0 && <div className="tree-hint">Tip: select a plane and click <b>Sketch</b>, or press <kbd>L</kbd> to start sketching a line.</div>}
  </div>;
}

function AsmTree({ doc }: { doc: AssemblyDoc }) {
  const s = useApp(); const selKeys = new Set(s.selection.map(selKey));
  const [open, setOpen] = useState<Record<string, boolean>>({ mates: true });
  const dofOf = (cid: string) => { const c = doc.components.find(x => x.id === cid)!; if (c.fixed) return "(f) "; let removed = 0; const w: Record<string, number> = { coincident: 3, distance: 3, concentric: 4, parallel: 2, perpendicular: 1, angle: 1, tangent: 1, lock: 6 }; for (const m of doc.mates) if (!m.suppressed && (m.a.comp === cid || m.b.comp === cid)) removed += w[m.type] || 0; return removed >= 6 ? "" : "(-) "; };
  return <div className="tree">
    <Row icon="assembly" label={<b>{doc.name} <span className="muted">(Default)</span></b>} onCtx={e => treeContextMenu(e.clientX, e.clientY, "root", doc.id)} />
    <Row icon="annotations" label="Annotations" depth={1} />
    <div style={{ marginLeft: 16 }}>{(["Front", "Top", "Right"] as const).map(k => <Row key={k} icon="plane" label={`${k} Plane`} selected={selKeys.has(`plane:${k}`)} onClick={e => treeSelect({ kind: "plane", id: k, plane: PLANES[k] }, e.ctrlKey)} />)}<Row icon="origin" label="Origin" /></div>
    <div style={{ marginLeft: 16 }}>
      {doc.components.map(c => { const p = s.docs[c.partId] as PartDoc | undefined; const err = p && s.builds[c.partId] && Object.keys(s.builds[c.partId].errors).length ? "Part has rebuild errors" : undefined;
        return <Row key={c.id} icon="part" label={`${dofOf(c.id)}${c.name}<${c.instance}>${c.hidden ? " (hidden)" : ""}`} err={err} cls={c.hidden ? "suppressed" : ""} selected={selKeys.has(`comp:${c.id}`)}
          onClick={e => treeSelect({ kind: "comp", id: c.id }, e.ctrlKey || e.shiftKey)} onDbl={() => s.activate(c.partId)} onCtx={e => { s.select({ kind: "comp", id: c.id }); treeContextMenu(e.clientX, e.clientY, "comp", c.id); }}
          open={!!open[c.id]} setOpen={v => setOpen({ ...open, [c.id]: v })}>
          {p ? p.features.filter(f => f.type !== "sketch").map(f => <Row key={f.id} icon={FT_ICON[f.type]} label={f.name} depth={2} />) : undefined}
        </Row>; })}
      <Row icon="mate" label={`Mates (${doc.mates.length})`} open={open.mates} setOpen={v => setOpen({ ...open, mates: v })}>
        {doc.mates.length ? doc.mates.map(m => <Row key={m.id} icon="mate" depth={1} label={`${m.name} (${doc.components.find(c => c.id === m.a.comp)?.name},${doc.components.find(c => c.id === m.b.comp)?.name})${m.value !== undefined ? ` = ${m.value}${m.type === "angle" ? "°" : ""}` : ""}`}
          cls={`${m.suppressed ? "suppressed" : ""} ${m.status === "error" ? "error" : ""}`} err={m.status === "error" ? "Mate cannot be satisfied" : undefined} selected={selKeys.has(`mate:${m.id}`)}
          onClick={e => treeSelect({ kind: "mate", id: m.id }, e.ctrlKey)} onCtx={e => treeContextMenu(e.clientX, e.clientY, "mate", m.id)} />) : <div className="tree-hint" style={{ marginLeft: 30 }}>No mates</div>}
      </Row>
      {doc.explode.length > 0 && <Row icon="explode" label={`ExplView1 (${doc.explode.length} steps)${doc.exploded ? "" : " — collapsed"}`} onCtx={e => treeContextMenu(e.clientX, e.clientY, "explode", "x")} onDbl={() => s.updateDoc(doc.id, (a: AssemblyDoc) => ({ ...a, exploded: !a.exploded }))} />}
    </div>
    {doc.components.length === 0 && <div className="tree-hint">Click <b>Insert Components</b> to add parts. The first component is fixed at the origin.</div>}
  </div>;
}

function DrawTree({ doc }: { doc: DrawingDoc }) {
  const s = useApp(); const src = doc.sourceId ? s.docs[doc.sourceId] : null;
  return <div className="tree">
    <Row icon="drawing" label={<b>{doc.name}</b>} />
    <Row icon="annotations" label="Annotations" depth={1} />
    <Row icon="drawing" label={`Sheet1 (${doc.sheet}, 1:${fmtScale(doc.scale)})`} depth={1} open setOpen={() => { }}>
      {doc.views.map(v => <Row key={v.id} icon={v.type === "section" ? "sectionView" : v.type === "detail" ? "detailView" : v.type === "projected" ? "projView" : "modelView"} label={`${v.label}${src ? ` (${src.name})` : ""}`} depth={2} onClick={() => window.dispatchEvent(new CustomEvent("cad:drawSelect", { detail: v.id }))} />)}
    </Row>
    {!src && <div className="tree-hint">Choose a model: click <b>Model View</b> or <b>Standard 3 View</b> in the View Layout tab.</div>}
  </div>;
}
const fmtScale = (sc: number) => sc >= 1 ? `1` : String(Math.round(1 / sc));

function ConfigManager() {
  const s = useApp(); const doc = s.activeId ? s.docs[s.activeId] : null;
  if (doc?.kind !== "part") return <div className="lp-empty">Configurations are available for parts.</div>;
  const add = () => { const name = prompt("Configuration name", `Config${doc.configs.length + 1}`); if (!name) return; const id = "cfg" + Date.now().toString(36); s.updateDoc(doc.id, (d: PartDoc) => ({ ...d, configs: [...d.configs, { id, name, suppressed: { ...d.configs.find(c => c.id === d.activeConfig)!.suppressed }, overrides: { ...d.configs.find(c => c.id === d.activeConfig)!.overrides } }], activeConfig: id })); };
  return <div className="tree">
    <Row icon="part" label={<b>{doc.name} Configuration(s)</b>} />
    {doc.configs.map(c => <Row key={c.id} icon="config" depth={1} label={<>{c.name}{c.id === doc.activeConfig ? " ✓" : ""} <span className="muted">{Object.values(c.suppressed).filter(Boolean).length} suppressed, {Object.keys(c.overrides).length} overrides</span></>} selected={c.id === doc.activeConfig}
      onDbl={() => s.updateDoc(doc.id, (d: PartDoc) => ({ ...d, activeConfig: c.id }), false)} onClick={() => s.updateDoc(doc.id, (d: PartDoc) => ({ ...d, activeConfig: c.id }), false)}
      onCtx={e => s.set({ menu: { x: e.clientX, y: e.clientY, items: [{ label: "Show Configuration", action: () => s.updateDoc(doc.id, (d: PartDoc) => ({ ...d, activeConfig: c.id }), false) }, { label: "Rename", action: () => { const n = prompt("Name", c.name); if (n) s.updateDoc(doc.id, (d: PartDoc) => ({ ...d, configs: d.configs.map(x => x.id === c.id ? { ...x, name: n } : x) })); } }, { label: "Delete", disabled: doc.configs.length < 2, action: () => s.updateDoc(doc.id, (d: PartDoc) => { const configs = d.configs.filter(x => x.id !== c.id); return { ...d, configs, activeConfig: d.activeConfig === c.id ? configs[0].id : d.activeConfig }; }) }] } })} />)}
    <div className="pm-row" style={{ padding: 8 }}><button className="btn" onClick={add}>Add Configuration…</button><button className="btn" onClick={() => s.set({ dialog: { name: "designTable" } })}>Design Table…</button></div>
    <div className="tree-hint">Suppression state and dimension overrides (Design Table) are stored per configuration. Double-click to activate.</div>
  </div>;
}

function CustomProps() {
  const s = useApp(); const doc = s.activeId ? s.docs[s.activeId] : null;
  if (doc?.kind !== "part") return <div className="lp-empty">Custom properties are available for parts.</div>;
  const props = doc.props; const keys = Object.keys(props);
  const set = (k: string, v: string) => s.updateDoc(doc.id, (d: PartDoc) => ({ ...d, props: { ...d.props, [k]: v } }));
  return <div className="pm"><div className="pm-group"><div className="pm-gtitle">Custom Properties</div>
    {keys.map(k => <div key={k} className="pm-row"><label style={{ width: 90 }}>{k}</label><input value={props[k]} onChange={e => set(k, e.target.value)} /><button className="mini" onClick={() => s.updateDoc(doc.id, (d: PartDoc) => { const p = { ...d.props }; delete p[k]; return { ...d, props: p }; })}>×</button></div>)}
    <div className="pm-row"><button className="btn" onClick={() => { const k = prompt("Property name", "Vendor"); if (k) set(k, ""); }}>Add Property</button></div>
  </div></div>;
}
