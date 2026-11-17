import { useEffect, useState, type ReactNode } from "react";
import { useApp, effectiveFeatures, unitLabel, unitScale, getPath, setPath } from "../store";
import type { PartDoc, AssemblyDoc, MassProps } from "../types";
import { call, kernel } from "../kernel/client";
import { MATERIALS, APPEARANCES, DEFAULT_DENSITY } from "./materials";
import { applyMaterial, doDelete, loadBundle } from "./actions";
import { fmt, uid, applyT, qRotate, evalExpr } from "../math";
import { Icon } from "./Icons";
import { compWorld } from "../assembly/solver";

const st = () => useApp.getState();
const close = () => useApp.setState({ dialog: null });

function Dlg({ title, children, onOk, okLabel = "OK", wide, icon, noCancel }: { title: string; children: ReactNode; onOk?: () => void; okLabel?: string; wide?: boolean; icon?: string; noCancel?: boolean }) {
  const [pos, setPos] = useState<[number, number] | null>(null);
  return <div className="dlg-back" onMouseDown={e => { if (e.target === e.currentTarget) close(); }}>
    <div className={`dlg ${wide ? "wide" : ""}`} style={pos ? { position: "fixed", left: pos[0], top: pos[1] } : undefined} onKeyDown={e => { if (e.key === "Enter" && onOk && (e.target as HTMLElement).tagName !== "TEXTAREA") onOk(); e.stopPropagation(); }}>
      <div className="dlg-title" onPointerDown={e => { const r = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect(); const dx = e.clientX - r.left, dy = e.clientY - r.top; const mv = (ev: PointerEvent) => setPos([ev.clientX - dx, ev.clientY - dy]); const up = () => { window.removeEventListener("pointermove", mv); window.removeEventListener("pointerup", up); }; window.addEventListener("pointermove", mv); window.addEventListener("pointerup", up); }}>
        {icon && <Icon name={icon} size={18} />}<span>{title}</span><button onClick={close}>×</button></div>
      <div className="dlg-body">{children}</div>
      <div className="dlg-foot">{onOk && <button className="btn primary" onClick={onOk}>{okLabel}</button>}{!noCancel && <button className="btn" onClick={close}>{onOk ? "Cancel" : "Close"}</button>}</div>
    </div>
  </div>;
}

export function Dialogs() {
  const d = useApp(s => s.dialog); const kind = useApp(s => s.activeId ? s.docs[s.activeId]?.kind : null); if (!d) return null;
  const asmOnly = ["interference", "asmStats", "compPattern", "mirrorComp"];
  if (asmOnly.includes(d.name) && kind !== "assembly") return <Dlg title="Assembly command" icon="help"><p>This command needs an active assembly document.</p></Dlg>;
  if (d.name === "confirmDelete" && !d.data?.ids) return null;
  switch (d.name) {
    case "new": return <NewDlg />;
    case "confirmDelete": return <Dlg title="Confirm Delete" icon="delete" onOk={() => doDelete(d.data.ids, true, d.data.kids)} okLabel="Delete">
      <p>{d.data.text}</p>{d.data.kidText && <p className="warn-text">{d.data.kidText}<br />They will also be deleted because they reference the selected item.</p>}</Dlg>;
    case "properties": return <PropsDlg />;
    case "mass": return <MassDlg />;
    case "check": return <CheckDlg />;
    case "options": return <OptionsDlg />;
    case "equations": return <EquationsDlg />;
    case "designTable": return <DesignTableDlg />;
    case "material": return <MaterialDlg />;
    case "appearance": return <AppearanceDlg />;
    case "insertComp": return <InsertCompDlg />;
    case "interference": return <InterferenceDlg />;
    case "asmStats": return <AsmStatsDlg />;
    case "compPattern": return <CompPatternDlg />;
    case "mirrorComp": return <MirrorCompDlg />;
    case "help": return <HelpDlg />;
    case "about": return <Dlg title="About OpenWorks CAD" icon="help"><p><b>OpenWorks CAD</b> — a browser-based parametric 3D CAD modeler inspired by the SolidWorks workflow.</p><p>Geometry kernel: OpenCascade Technology (OCCT) compiled to WebAssembly via replicad. Rendering: three.js. UI: React + Zustand.</p><p className="muted">Documents are stored in your browser (File ▸ Save) or downloaded as .cpart / .casm / .cdrw JSON files (File ▸ Save As).</p></Dlg>;
    case "section": return <SectionDlg />;
    case "orientation": return <OrientationDlg />;
  }
  return null;
}

function NewDlg() {
  const s = useApp(); const [k, setK] = useState<"part" | "assembly" | "drawing">("part");
  return <Dlg title="New OpenWorks Document" icon="new" onOk={() => { close(); if (k === "drawing") { import("./actions").then(m => m.runCommand("newDrawing")); } else s.newDoc(k); }}>
    <div className="new-grid">{([["part", "Part", "a 3D representation of a single design component"], ["assembly", "Assembly", "a 3D arrangement of parts and/or other assemblies"], ["drawing", "Drawing", "a 2D engineering drawing, typically of a part or assembly"]] as const).map(([v, l, t]) =>
      <button key={v} className={k === v ? "on" : ""} onClick={() => setK(v)} onDoubleClick={() => { close(); if (v === "drawing") import("./actions").then(m => m.runCommand("newDrawing")); else s.newDoc(v); }}><Icon name={v} size={48} /><b>{l}</b><small>{t}</small></button>)}</div>
    <div className="pm-row" style={{ marginTop: 10 }}><button className="btn" onClick={() => { close(); import("./actions").then(m => m.openFile()); }}>Open file…</button><button className="btn" onClick={() => { close(); window.dispatchEvent(new CustomEvent("cad:sample")); }}>Sample bracket</button></div>
  </Dlg>;
}

function PropsDlg() {
  const s = useApp(); const d = s.docs[s.activeId!]; const [name, setName] = useState(d.name);
  return <Dlg title="Document Properties" icon="config" onOk={() => { s.updateDoc(d.id, x => ({ ...x, name })); close(); }}>
    <div className="pm-row"><label style={{ width: 110 }}>Name</label><input value={name} onChange={e => setName(e.target.value)} /></div>
    <div className="pm-row"><label style={{ width: 110 }}>Type</label><span>{d.kind}</span></div>
    <div className="pm-row"><label style={{ width: 110 }}>Units</label><select value={d.units} onChange={e => s.updateDoc(d.id, x => ({ ...x, units: e.target.value }))}><option value="MMGS">MMGS (millimeter, gram, second)</option><option value="CGS">CGS (centimeter, gram, second)</option><option value="MKS">MKS (meter, kilogram, second)</option><option value="IPS">IPS (inch, pound, second)</option></select></div>
    {d.kind === "part" && <div className="pm-row"><label style={{ width: 110 }}>Features</label><span>{d.features.length}</span></div>}
    {d.kind === "drawing" && <><div className="pm-row"><label style={{ width: 110 }}>Sheet</label><select value={d.sheet} onChange={e => s.updateDoc(d.id, x => ({ ...x, sheet: e.target.value }))}>{["A4", "A3", "A2", "A1", "A0", "Letter"].map(x => <option key={x}>{x}</option>)}</select></div>
      <div className="pm-row"><label style={{ width: 110 }}>Projection</label><select value={d.projection} onChange={e => s.updateDoc(d.id, x => ({ ...x, projection: e.target.value }))}><option value="third">Third angle</option><option value="first">First angle</option></select></div></>}
  </Dlg>;
}

async function massOfPart(p: PartDoc): Promise<MassProps | null> { return call<MassProps | null>("mass", { features: effectiveFeatures(p) }); }
const density = (p: PartDoc) => (MATERIALS.find(m => m.name === p.material)?.density ?? DEFAULT_DENSITY);
function MassDlg() {
  const s = useApp(); const d = s.docs[s.activeId!]; const [res, setRes] = useState<any>(null); const [err, setErr] = useState("");
  useEffect(() => { (async () => {
    try {
      if (d.kind === "part") { const m = await massOfPart(d); if (!m) return setErr("No solid body."); const rho = density(d); const mass = m.volume * 1e-9 * rho; setRes({ ...m, mass, rho, name: d.material || "Default (1000 kg/m³)" }); }
      else if (d.kind === "assembly") { let V = 0, A = 0, M = 0; const c: number[] = [0, 0, 0];
        for (const comp of d.components) { if (comp.hidden) continue; const p = s.docs[comp.partId] as PartDoc; const m = await massOfPart(p); if (!m) continue; const rho = density(p); const mm = m.volume * 1e-9 * rho; const t = compWorld(d, comp.id); const w = applyT(t as any, m.com); V += m.volume; A += m.area; M += mm; c[0] += w[0] * mm; c[1] += w[1] * mm; c[2] += w[2] * mm; }
        if (!M) return setErr("No bodies."); setRes({ volume: V, area: A, mass: M, com: c.map(x => x / M), name: "Per component" }); }
      else setErr("Mass properties are available for parts and assemblies.");
    } catch (e) { setErr((e as Error).message); }
  })(); }, []);
  const u = unitLabel(d.units), k = unitScale(d.units);
  const rows: [string, string][] = res ? [["Material", res.name], ["Density", res.rho ? `${res.rho} kg/m³` : "—"], ["Mass", res.mass >= 1 ? `${fmt(res.mass, 4)} kg` : `${fmt(res.mass * 1000, 3)} g`], ["Volume", `${fmt(res.volume * k ** 3, 3)} ${u}³`], ["Surface area", `${fmt(res.area * k ** 2, 3)} ${u}²`], ["Center of mass", `X ${fmt(res.com[0] * k, 3)}, Y ${fmt(res.com[1] * k, 3)}, Z ${fmt(res.com[2] * k, 3)} ${u}`]] : [];
  return <Dlg title={`Mass Properties — ${d.name}`} icon="massProps" wide>
    {err ? <p className="warn-text">{err}</p> : !res ? <p>Calculating…</p> : <table className="kv"><tbody>{rows.map(([a, b]) => <tr key={a}><td>{a}</td><td><b>{b}</b></td></tr>)}
      {res.inertia && <tr><td>Moments of inertia (taken at the center of mass, per unit density, {u}⁵ ×1)</td><td><pre>{[0, 1, 2].map(r => res.inertia.slice(r * 3, r * 3 + 3).map((v: number) => fmt(v, 1).padStart(14)).join(" ")).join("\n")}</pre></td></tr>}</tbody></table>}
    <div className="pm-row"><button className="btn" onClick={() => { if (!res) return; navigator.clipboard?.writeText(rows.map(r => r.join(": ")).join("\n")); st().showToast("Copied"); }}>Copy</button></div>
  </Dlg>;
}
function CheckDlg() {
  const s = useApp(); const d = s.docs[s.activeId!]; const b = s.builds[d.id];
  const errs = Object.entries(b?.errors || {}); const m = b?.main;
  return <Dlg title="Check Entity" icon="check"><table className="kv"><tbody>
    <tr><td>Solid bodies</td><td>{m ? 1 : 0}</td></tr><tr><td>Faces</td><td>{m?.faces.length ?? 0}</td></tr><tr><td>Edges</td><td>{m?.edges.length ?? 0}</td></tr><tr><td>Triangles</td><td>{m ? m.triangles.length / 3 : 0}</td></tr>
    <tr><td>Rebuild errors</td><td>{errs.length ? errs.map(([id, e]) => <div key={id} className="warn-text">{(d as PartDoc).features?.find(f => f.id === id)?.name}: {e}</div>) : "None — model is valid"}</td></tr>
  </tbody></table></Dlg>;
}
function OptionsDlg() {
  const s = useApp(); const [o, setO] = useState({ ...s.options }); const [tab, setTab] = useState("system");
  const C = (k: keyof typeof o, l: string) => <label className="pm-check"><input type="checkbox" checked={!!o[k]} onChange={e => setO({ ...o, [k]: e.target.checked })} /> {l}</label>;
  return <Dlg title="System Options" icon="options" wide onOk={() => { useApp.setState({ options: o }); localStorage.setItem("openworks.options", JSON.stringify(o)); close(); }}>
    <div className="opt-wrap"><div className="opt-tabs">{[["system", "General"], ["sketch", "Sketch / Relations"], ["display", "Display"], ["files", "Backup / Files"]].map(([k, l]) => <div key={k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>{l}</div>)}</div>
      <div className="opt-body">
        {tab === "system" && <>{C("singleCommand", "Single command per pick (sketch tools end after one entity)")}<div className="pm-row"><label>User name</label><input value={o.userName} onChange={e => setO({ ...o, userName: e.target.value })} /></div></>}
        {tab === "sketch" && <>{C("autoRelations", "Automatic relations")}{C("snapPoints", "Sketch snaps (endpoints, midpoints, intersections…)")}{C("snapGrid", "Snap to grid")}{C("inputDim", "Enter dimension value on creation")}{C("showRelations", "Display sketch relations")}<div className="pm-row"><label>Grid spacing</label><input type="number" value={o.gridSpacing} onChange={e => setO({ ...o, gridSpacing: Math.max(0.1, +e.target.value) })} /></div></>}
        {tab === "display" && <><div className="pm-row"><label>Image quality</label><select value={o.edgeQuality} onChange={e => setO({ ...o, edgeQuality: e.target.value as any })}><option value="draft">Draft</option><option value="normal">Normal</option><option value="high">High</option></select></div>{C("antialias", "Anti-aliasing")}<div className="pm-row"><label>Selection color</label><input type="color" value={o.selColor} onChange={e => setO({ ...o, selColor: e.target.value })} /></div></>}
        {tab === "files" && <><div className="pm-row"><label>Auto-recover every (min, 0 = off)</label><input type="number" value={o.autosaveMin} onChange={e => setO({ ...o, autosaveMin: Math.max(0, +e.target.value) })} /></div>
          <div className="pm-row"><button className="btn" onClick={() => { const a = JSON.parse(localStorage.getItem("openworks.autosave") || "{}"); const docs = Object.values(a) as any[]; if (!docs.length) return st().showToast("No auto-recovered documents"); docs.forEach(d => loadBundle({ doc: d, deps: [] })); close(); }}>Recover auto-saved documents</button></div></>}
      </div></div>
  </Dlg>;
}

/** Equations: global variables + dimension links ("featureId.param" = expression) */
function EquationsDlg() {
  const s = useApp(); const d = s.docs[s.activeId!] as PartDoc;
  const eq: { name: string; expr: string }[] = (d.props.__equations ? JSON.parse(d.props.__equations) : []);
  const [rows, setRows] = useState(eq.length ? eq : [{ name: "", expr: "" }]);
  const params: [string, string][] = []; d.features.forEach(f => { const walk = (o: any, pre: string) => { for (const k in o) { const v = o[k]; if (typeof v === "number" && !["count"].includes(k) || (k === "count")) params.push([`${f.id}.${pre}${k}`, `${f.name}.${pre}${k}`]); else if (v && typeof v === "object" && !Array.isArray(v) && pre.split(".").length < 2) walk(v, `${pre}${k}.`); } }; walk(f.params || {}, ""); });
  const evalAll = () => { const vars: Record<string, number> = {}; const out: Record<string, number> = {}; for (const r of rows) { if (!r.name || !r.expr) continue; const v = evalExpr(r.expr, vars); if (v === null) throw new Error(`Cannot evaluate “${r.expr}”`); if (r.name.startsWith('"') || !r.name.includes(".")) vars[r.name.replace(/"/g, "")] = v; else out[r.name] = v; } return out; };
  const apply = () => { try { const out = evalAll(); s.updateDoc(d.id, (x: PartDoc) => { const features = x.features.map(f => { const keys = Object.keys(out).filter(k => k.startsWith(f.id + ".")); if (!keys.length) return f; const params = JSON.parse(JSON.stringify(f.params)); keys.forEach(k => setPath(params, k.slice(f.id.length + 1), out[k])); return { ...f, params }; }); return { ...x, features, props: { ...x.props, __equations: JSON.stringify(rows.filter(r => r.name)) } }; }); close(); } catch (e) { st().showToast((e as Error).message); } };
  return <Dlg title="Equations, Global Variables, and Dimensions" icon="equations" wide onOk={apply}>
    <table className="grid"><thead><tr><th>Name (variable or dimension)</th><th>Value / Equation</th><th>Evaluates to</th><th /></tr></thead><tbody>
      {rows.map((r, i) => { let ev = ""; try { const vars: Record<string, number> = {}; for (const q of rows.slice(0, i)) { const v = evalExpr(q.expr, vars); if (v !== null && q.name && !q.name.includes(".")) vars[q.name] = v; } const v = evalExpr(r.expr, vars); ev = v === null ? "?" : fmt(v, 4); } catch { ev = "?"; }
        return <tr key={i}><td><input list="eq-params" value={r.name} onChange={e => setRows(rows.map((x, j) => j === i ? { ...x, name: e.target.value } : x))} placeholder="e.g. width   or pick a dimension" /></td><td><input value={r.expr} onChange={e => setRows(rows.map((x, j) => j === i ? { ...x, expr: e.target.value } : x))} placeholder="e.g. 100   or width/2" /></td><td>{ev}{r.name.includes(".") && <small className="muted"> (now {String(getPath(d.features.find(f => r.name.startsWith(f.id))?.params || {}, r.name.split(".").slice(1).join(".")) ?? "")})</small>}</td><td><button className="mini" onClick={() => setRows(rows.filter((_, j) => j !== i))}>×</button></td></tr>; })}
    </tbody></table>
    <datalist id="eq-params">{params.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</datalist>
    <div className="pm-row"><button className="btn" onClick={() => setRows([...rows, { name: "", expr: "" }])}>Add row</button></div>
    <p className="muted">Global variables (no dot) can be referenced in later equations. Dimension rows use “featureId.param” names (pick from the list) and drive the feature parameters. Supports + − × ÷ ^, parentheses, sin/cos/tan/sqrt/pi.</p>
  </Dlg>;
}
/** Design table: configurations × parameters grid (writes per-config overrides) */
function DesignTableDlg() {
  const s = useApp(); const d = s.docs[s.activeId!] as PartDoc;
  const cols: { key: string; label: string }[] = [];
  d.features.forEach(f => { const p = f.params || {}; for (const k of ["depth", "radius", "distance", "thickness", "angle", "count", "spacing", "offset"]) if (typeof p[k] === "number") cols.push({ key: `${f.id}.${k}`, label: `${f.name}.${k}` }); });
  const [grid, setGrid] = useState<Record<string, Record<string, string>>>(() => Object.fromEntries(d.configs.map(c => [c.id, Object.fromEntries(Object.entries(c.overrides).map(([k, v]) => [k, String(v)]))])));
  const [sup, setSup] = useState<Record<string, Record<string, boolean>>>(() => Object.fromEntries(d.configs.map(c => [c.id, { ...c.suppressed }])));
  const apply = () => { s.updateDoc(d.id, (x: PartDoc) => ({ ...x, configs: x.configs.map(c => ({ ...c, overrides: Object.fromEntries(Object.entries(grid[c.id] || {}).filter(([, v]) => v !== "" && !isNaN(+v)).map(([k, v]) => [k, +v])), suppressed: sup[c.id] || {} })) })); close(); };
  const feats = d.features.filter(f => f.type !== "sketch");
  return <Dlg title="Design Table" icon="designTable" wide onOk={apply}>
    {cols.length === 0 ? <p>No numeric feature parameters yet.</p> : <div className="dt-scroll"><table className="grid dt"><thead><tr><th>Configuration</th>{cols.map(c => <th key={c.key}>{c.label}</th>)}{feats.map(f => <th key={f.id}>$STATE@{f.name}</th>)}</tr></thead><tbody>
      {d.configs.map(c => <tr key={c.id}><td><b>{c.name}</b></td>{cols.map(col => { const f = d.features.find(x => col.key.startsWith(x.id))!; const base = f.params[col.key.split(".")[1]]; return <td key={col.key}><input placeholder={String(base)} value={grid[c.id]?.[col.key] ?? ""} onChange={e => setGrid({ ...grid, [c.id]: { ...(grid[c.id] || {}), [col.key]: e.target.value } })} /></td>; })}
        {feats.map(f => <td key={f.id}><select value={sup[c.id]?.[f.id] ? "S" : "U"} onChange={e => setSup({ ...sup, [c.id]: { ...(sup[c.id] || {}), [f.id]: e.target.value === "S" } })}><option value="U">Unsuppressed</option><option value="S">Suppressed</option></select></td>)}</tr>)}
    </tbody></table></div>}
    <div className="pm-row"><button className="btn" onClick={() => { const name = prompt("New configuration name", `Config${d.configs.length + 1}`); if (!name) return; const id = uid("cfg"); s.updateDoc(d.id, (x: PartDoc) => ({ ...x, configs: [...x.configs, { id, name, suppressed: {}, overrides: {} }] })); setGrid({ ...grid, [id]: {} }); }}>Add configuration</button></div>
    <p className="muted">Empty cells use the base value (shown greyed). Switch configurations in the ConfigurationManager tab.</p>
  </Dlg>;
}
function MaterialDlg() {
  const s = useApp(); const d = s.docs[s.activeId!] as PartDoc; const [sel, setSel] = useState<string | null>(d.material);
  const cats = [...new Set(MATERIALS.map(m => m.category))]; const m = MATERIALS.find(x => x.name === sel);
  return <Dlg title="Material" icon="material" wide onOk={() => { applyMaterial(sel); close(); }} okLabel="Apply">
    <div className="mat-wrap"><div className="mat-tree">{cats.map(c => <div key={c}><div className="mat-cat">📁 {c}</div>{MATERIALS.filter(x => x.category === c).map(x => <div key={x.name} className={`mat-item ${sel === x.name ? "on" : ""}`} onClick={() => setSel(x.name)} onDoubleClick={() => { applyMaterial(x.name); close(); }}><span className="chip" style={{ background: x.color }} />{x.name}</div>)}</div>)}</div>
      <div className="mat-props">{m ? <table className="kv"><tbody><tr><td>Name</td><td><b>{m.name}</b></td></tr><tr><td>Category</td><td>{m.category}</td></tr><tr><td>Mass density</td><td>{m.density} kg/m³</td></tr><tr><td>Elastic modulus</td><td>{m.E} GPa</td></tr><tr><td>Yield strength</td><td>{m.yield} MPa</td></tr></tbody></table> : <p className="muted">Select a material.</p>}
        <button className="btn" onClick={() => { applyMaterial(null); close(); }}>Remove material</button></div></div>
  </Dlg>;
}
function AppearanceDlg() {
  const s = useApp(); const d = s.docs[s.activeId!];
  if (d?.kind !== "part") return <Dlg title="Appearance"><p>Open a part document.</p></Dlg>;
  const a = d.appearance; const set = (patch: any) => s.updateDoc(d.id, (x: PartDoc) => ({ ...x, appearance: { ...x.appearance, ...patch } }), false);
  return <Dlg title="Appearance" icon="appearance" onOk={() => { s.updateDoc(d.id, x => ({ ...x }), true); close(); }}>
    <div className="pm-row"><label style={{ width: 90 }}>Color</label><input type="color" value={a.color} onChange={e => set({ color: e.target.value })} /></div>
    <div className="pm-row"><label style={{ width: 90 }}>Metalness</label><input type="range" min={0} max={1} step={0.01} value={a.metalness} onChange={e => set({ metalness: +e.target.value })} /><span>{fmt(a.metalness)}</span></div>
    <div className="pm-row"><label style={{ width: 90 }}>Roughness</label><input type="range" min={0} max={1} step={0.01} value={a.roughness} onChange={e => set({ roughness: +e.target.value })} /><span>{fmt(a.roughness)}</span></div>
    <div className="pm-row"><label style={{ width: 90 }}>Transparency</label><input type="range" min={0} max={0.9} step={0.01} value={1 - a.opacity} onChange={e => set({ opacity: 1 - +e.target.value })} /><span>{fmt((1 - a.opacity) * 100, 0)}%</span></div>
    <div className="swatches small">{APPEARANCES.map(x => <button key={x.name} title={x.name} onClick={() => set({ color: x.color, metalness: x.metalness, roughness: x.roughness })}><span style={{ background: x.color }} /></button>)}</div>
  </Dlg>;
}
function InsertCompDlg() {
  const s = useApp(); const asm = s.docs[s.activeId!] as AssemblyDoc;
  const parts = [...new Map([...Object.values(s.docs), ...Object.values(s.library)].filter(d => d.kind === "part").map(d => [d.id, d])).values()] as PartDoc[];
  const [sel, setSel] = useState<string | null>(parts[0]?.id || null); const [n, setN] = useState(1);
  const insert = () => { const p = parts.find(x => x.id === sel); if (!p) return; if (!s.docs[p.id]) s.addDoc(p, false);
    s.updateDoc(asm.id, (a: AssemblyDoc) => { const comps = [...a.components]; for (let i = 0; i < n; i++) { const inst = comps.filter(c => c.partId === p.id).length + 1; const k = comps.length; comps.push({ id: uid("c"), partId: p.id, name: p.name, instance: inst, t: { p: k === 0 ? [0, 0, 0] : [k * 30 + 40, 0, k * 10], q: [0, 0, 0, 1] }, fixed: k === 0 }); } return { ...a, components: comps }; });
    close(); s.setStatus(`Inserted ${n} × ${p.name}. ${asm.components.length === 0 ? "The first component is fixed at the origin." : "Use Mate to position it."}`); setTimeout(() => s.cmd("fit"), 800); };
  return <Dlg title="Insert Component" icon="insertComp" onOk={insert} okLabel="Insert">
    <p className="muted">Part/Assembly to insert (open documents and the browser library):</p>
    <div className="list-box">{parts.length === 0 && <div className="pm-note">No parts available. Create a part first (File ▸ New ▸ Part) or load a sample from the Design Library.</div>}
      {parts.map(p => <div key={p.id} className={`tp-file ${sel === p.id ? "sel" : ""}`} onClick={() => setSel(p.id)} onDoubleClick={() => { setSel(p.id); setTimeout(insert); }}><Icon name="part" size={18} /><span>{p.name}</span><small className="muted">{p.features.length} features{s.docs[p.id] ? "" : " · library"}</small></div>)}</div>
    <div className="pm-row"><label>Instances</label><input type="number" min={1} max={20} value={n} onChange={e => setN(Math.max(1, Math.min(20, +e.target.value)))} /></div>
    <div className="pm-row"><button className="btn" onClick={() => { close(); import("./actions").then(m => m.openFile()); }}>Browse… (.cpart)</button></div>
  </Dlg>;
}
function InterferenceDlg() {
  const s = useApp(); const asm = s.docs[s.activeId!] as AssemblyDoc; const [busy, setBusy] = useState(false); const res = s.interference;
  const run = async () => { setBusy(true); try { const comps = asm.components.filter(c => !c.hidden).map(c => ({ id: c.id, features: effectiveFeatures(s.docs[c.partId] as PartDoc), t: compWorld(asm, c.id) })); const r = await kernel.interference(comps); useApp.setState({ interference: r.map(x => ({ ...x, show: true })) }); } catch (e) { s.showToast("Interference check failed: " + (e as Error).message); } setBusy(false); };
  const name = (id: string) => { const c = asm.components.find(x => x.id === id); return `${c?.name}<${c?.instance}>`; };
  return <div className="dlg-back"><div className="dlg">
    <div className="dlg-title"><Icon name="interference" size={18} /><span>Interference Detection</span><button onClick={() => { useApp.setState({ dialog: null, interference: null }); }}>×</button></div>
    <div className="dlg-body">
      <p>Selected components: entire assembly ({asm.components.filter(c => !c.hidden).length} visible components)</p>
      <button className="btn primary" disabled={busy} onClick={run}>{busy ? "Calculating…" : "Calculate"}</button>
      {res && <div className="list-box" style={{ marginTop: 8 }}>{res.length === 0 ? <div className="pm-note ok-text">No interferences detected.</div> : res.map((r: any, i: number) => <div key={i} className="tp-file"><input type="checkbox" checked={r.show} onChange={e => useApp.setState({ interference: res.map((x: any, j: number) => j === i ? { ...x, show: e.target.checked } : x) })} /><span>Interference{i + 1}: {name(r.a)} ↔ {name(r.b)}</span><b>{fmt(r.volume, 2)} mm³</b></div>)}</div>}
    </div>
    <div className="dlg-foot"><button className="btn" onClick={() => useApp.setState({ dialog: null })}>Close (keep highlights)</button><button className="btn" onClick={() => useApp.setState({ dialog: null, interference: null })}>Close</button></div>
  </div></div>;
}
function AsmStatsDlg() {
  const s = useApp(); const asm = s.docs[s.activeId!] as AssemblyDoc; const uniq = new Set(asm.components.map(c => c.partId));
  return <Dlg title="Assembly Statistics" icon="stats"><table className="kv"><tbody>
    <tr><td>Total components</td><td>{asm.components.length}</td></tr><tr><td>Unique parts</td><td>{uniq.size}</td></tr><tr><td>Fixed components</td><td>{asm.components.filter(c => c.fixed).length}</td></tr><tr><td>Hidden components</td><td>{asm.components.filter(c => c.hidden).length}</td></tr>
    <tr><td>Mates</td><td>{asm.mates.length} ({asm.mates.filter(m => m.status === "error").length} with errors)</td></tr><tr><td>Explode steps</td><td>{asm.explode.length}</td></tr>
  </tbody></table>
    <table className="grid" style={{ marginTop: 10 }}><thead><tr><th>Item</th><th>Part</th><th>Qty</th></tr></thead><tbody>{[...uniq].map((id, i) => <tr key={id}><td>{i + 1}</td><td>{(s.docs[id] as PartDoc)?.name}</td><td>{asm.components.filter(c => c.partId === id).length}</td></tr>)}</tbody></table>
  </Dlg>;
}
function CompPatternDlg() {
  const s = useApp(); const asm = s.docs[s.activeId!] as AssemblyDoc; const [comp, setComp] = useState(asm.components.find(c => !c.fixed)?.id || asm.components[0]?.id); const [dir, setDir] = useState("x"); const [n, setN] = useState(3); const [sp, setSp] = useState(30);
  const apply = () => { const c = asm.components.find(x => x.id === comp); if (!c) return; const d = dir === "x" ? [1, 0, 0] : dir === "y" ? [0, 1, 0] : [0, 0, 1];
    s.updateDoc(asm.id, (a: AssemblyDoc) => { const comps = [...a.components]; for (let i = 1; i < n; i++) { const inst = comps.filter(x => x.partId === c.partId).length + 1; comps.push({ ...c, id: uid("c"), instance: inst, fixed: true, t: { p: [c.t.p[0] + d[0] * sp * i, c.t.p[1] + d[1] * sp * i, c.t.p[2] + d[2] * sp * i], q: c.t.q } }); } return { ...a, components: comps }; }); close(); };
  return <Dlg title="Linear Component Pattern" icon="linearPattern" onOk={apply}>
    <div className="pm-row"><label>Component</label><select value={comp} onChange={e => setComp(e.target.value)}>{asm.components.map(c => <option key={c.id} value={c.id}>{c.name}&lt;{c.instance}&gt;</option>)}</select></div>
    <div className="pm-row"><label>Direction</label><select value={dir} onChange={e => setDir(e.target.value)}><option value="x">X</option><option value="y">Y</option><option value="z">Z</option></select></div>
    <div className="pm-row"><label>Spacing</label><input type="number" value={sp} onChange={e => setSp(+e.target.value)} /></div>
    <div className="pm-row"><label>Instances</label><input type="number" min={2} value={n} onChange={e => setN(Math.max(2, +e.target.value))} /></div>
    <p className="muted">Pattern instances are fixed in place relative to the seed position.</p>
  </Dlg>;
}
function MirrorCompDlg() {
  const s = useApp(); const asm = s.docs[s.activeId!] as AssemblyDoc; const [comp, setComp] = useState(asm.components[0]?.id); const [pl, setPl] = useState("Right");
  const apply = () => { const c = asm.components.find(x => x.id === comp); if (!c) return; const ax = pl === "Right" ? 0 : pl === "Top" ? 1 : 2; const p = [...c.t.p] as [number, number, number]; p[ax] = -p[ax];
    // reflect orientation: rotate 180° about the plane normal composed with original (proper rotation approximation for symmetric parts)
    const q = c.t.q; const nq: [number, number, number, number] = ax === 0 ? [q[0], -q[1], -q[2], q[3]] : ax === 1 ? [-q[0], q[1], -q[2], q[3]] : [-q[0], -q[1], q[2], q[3]];
    s.updateDoc(asm.id, (a: AssemblyDoc) => ({ ...a, components: [...a.components, { ...c, id: uid("c"), instance: a.components.filter(x => x.partId === c.partId).length + 1, fixed: true, t: { p, q: nq } }] })); close(); };
  void qRotate;
  return <Dlg title="Mirror Components" icon="mirror" onOk={apply}>
    <div className="pm-row"><label>Component</label><select value={comp} onChange={e => setComp(e.target.value)}>{asm.components.map(c => <option key={c.id} value={c.id}>{c.name}&lt;{c.instance}&gt;</option>)}</select></div>
    <div className="pm-row"><label>Mirror plane</label><select value={pl} onChange={e => setPl(e.target.value)}><option>Right</option><option>Top</option><option>Front</option></select></div>
    <p className="muted">Creates a mirrored-position copy (orientation reflected for symmetric parts).</p>
  </Dlg>;
}
function SectionDlg() {
  const s = useApp(); const sec = s.display.section; const set = (p: any) => useApp.setState({ display: { ...s.display, section: { ...sec, ...p } } });
  return <div className="float-panel" onPointerDown={e => e.stopPropagation()}>
    <div className="dlg-title"><Icon name="section" size={18} /><span>Section View</span><button onClick={() => useApp.setState({ dialog: null })}>×</button></div>
    <div className="dlg-body">
      <div className="seg">{(["Front", "Top", "Right"] as const).map(p => <button key={p} className={sec.plane === p ? "on" : ""} onClick={() => set({ plane: p })}>{p}</button>)}</div>
      <div className="pm-row"><label>Offset</label><input type="range" min={-200} max={200} step={0.5} value={sec.offset} onChange={e => set({ offset: +e.target.value })} /><input style={{ width: 60 }} type="number" value={sec.offset} onChange={e => set({ offset: +e.target.value })} /></div>
      <label className="pm-check"><input type="checkbox" checked={sec.flip} onChange={e => set({ flip: e.target.checked })} /> Flip side</label>
      <div className="pm-row"><button className="btn" onClick={() => { useApp.setState({ display: { ...s.display, section: { ...sec, on: false } }, dialog: null }); }}>Turn off</button><button className="btn primary" onClick={() => useApp.setState({ dialog: null })}>OK</button></div>
    </div>
  </div>;
}
function OrientationDlg() {
  const s = useApp(); const go = (v: string) => { s.cmd(v); close(); };
  return <div className="float-panel orient" onPointerDown={e => e.stopPropagation()}>
    <div className="dlg-title"><Icon name="viewOrient" size={18} /><span>Orientation</span><button onClick={close}>×</button></div>
    <div className="orient-grid">{[["Front", "front", "1"], ["Back", "back", "2"], ["Left", "left", "3"], ["Right", "right", "4"], ["Top", "top", "5"], ["Bottom", "bottom", "6"], ["Isometric", "iso", "7"], ["Trimetric", "trimetric", ""], ["Dimetric", "dimetric", ""]].map(([l, v, k]) => <button key={v} onClick={() => go(v)}>{l}<small>{k && `Ctrl+${k}`}</small></button>)}
      <button onClick={() => { import("./actions").then(m => m.runCommand("normalTo")); close(); }}>Normal To<small>Ctrl+8</small></button></div>
  </div>;
}
function HelpDlg() {
  const rows: [string, string][] = [["Middle-drag / right-drag", "Rotate view"], ["Ctrl + middle-drag", "Pan"], ["Shift + middle-drag / wheel", "Zoom (to cursor)"], ["F", "Zoom to fit"], ["Ctrl+1…7", "Front, Back, Left, Right, Top, Bottom, Isometric"], ["Ctrl+8", "Normal To"], ["Space", "Orientation dialog"], ["S", "Shortcut bar"], ["L / C / R / A", "Line / Circle / Rectangle / Arc"], ["D", "Smart Dimension"], ["T", "Trim"], ["Esc", "Cancel tool / close PropertyManager / clear selection"], ["Enter", "OK in PropertyManager · repeat typed value"], ["Delete", "Delete selection"], ["Ctrl+Z / Ctrl+Y", "Undo / Redo"], ["Ctrl+S", "Save to browser library"], ["Ctrl+Shift+S", "Save As (download .cpart/.casm/.cdrw)"], ["Ctrl+B / Ctrl+Q", "Rebuild / Force rebuild"], ["Ctrl+C / Ctrl+V", "Copy / paste sketch entities"], ["Double-click feature", "Edit feature"], ["Double-click dimension", "Modify value"]];
  return <Dlg title="Quick Reference" icon="help" wide><table className="kv"><tbody>{rows.map(([a, b]) => <tr key={a}><td><kbd>{a}</kbd></td><td>{b}</td></tr>)}</tbody></table>
    <h4>Bracket workflow</h4><ol className="muted"><li>Select <b>Top Plane</b> → <b>Sketch</b>. Press <kbd>R</kbd>, click two corners (or type 100 Tab 60 Enter).</li><li>Press <kbd>D</kbd> and dimension the edges if needed. Exit the sketch (✔ corner).</li><li><b>Extruded Boss/Base</b>, depth 20 → ✔.</li><li><b>Fillet</b>, pick the 4 vertical edges, radius 5 → ✔.</li><li>Click the top face → Sketch, draw a circle, dimension ⌀15 → <b>Extruded Cut</b> Through All.</li><li><kbd>Ctrl+S</kbd> to save, File ▸ Export ▸ STL.</li></ol>
  </Dlg>;
}
