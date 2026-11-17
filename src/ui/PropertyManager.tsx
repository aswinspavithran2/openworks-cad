import { useState, type ReactNode } from "react";
import { useApp, unitLabel, selKey, type Sel } from "../store";
import type { PartDoc, AssemblyDoc, Sketch, SkEntity, Constraint, ConstraintType, MateType } from "../types";
import { Icon } from "./Icons";
import { pmConfirm, pmCancel, updateDraft, setBox, HOLE_TABLE, holeDims, previewMate, geoOfRef } from "./pm";
import { transformSketch, sketchOffset, sketchSelected, TOOL_HINT } from "./actions";
import { evalExpr, fmt, uid, sub, len, dot, applyT } from "../math";
import { DIM_TYPES, measureDim } from "../sketch/solver";
import { allowedMates } from "../assembly/solver";
import { compWorld } from "../assembly/solver";

const st = () => useApp.getState();

// ───────── field helpers
export function Num({ label, value, onChange, unit = "mm", min, step = 1, icon, title }: { label?: string; value: number; onChange: (v: number) => void; unit?: string; min?: number; step?: number; icon?: string; title?: string }) {
  const [txt, setTxt] = useState<string | null>(null);
  const commit = (t: string) => { const v = evalExpr(t); if (v === null || !isFinite(v) || (min !== undefined && v < min)) { st().showToast(`Invalid value “${t}”`); setTxt(null); return; } onChange(v); setTxt(null); };
  return <div className="pm-row num" title={title}>
    {icon && <Icon name={icon} size={16} />}{label && <label>{label}</label>}
    <input value={txt ?? `${fmt(value, 3)}${unit ? unit === "°" ? "°" : unit : ""}`} onFocus={e => { setTxt(fmt(value, 3)); setTimeout(() => e.target.select()); }} onChange={e => setTxt(e.target.value)} onBlur={e => commit(e.target.value)} onKeyDown={e => { if (e.key === "Enter") { (e.target as HTMLInputElement).blur(); e.stopPropagation(); } if (e.key === "Escape") setTxt(null); }} />
    <span className="spin"><button tabIndex={-1} onClick={() => onChange(+(value + step).toFixed(6))}>▴</button><button tabIndex={-1} onClick={() => onChange(+(min !== undefined ? Math.max(min, value - step) : value - step).toFixed(6))}>▾</button></span>
  </div>;
}
export const Check = ({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) => <label className="pm-check"><input type="checkbox" checked={!!value} onChange={e => onChange(e.target.checked)} /> {label}</label>;
export const Select = ({ label, value, options, onChange, icon }: { label?: string; value: string; options: [string, string][]; onChange: (v: string) => void; icon?: string }) =>
  <div className="pm-row">{icon && <Icon name={icon} size={16} />}{label && <label>{label}</label>}<select value={value} onChange={e => onChange(e.target.value)}>{options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>;
export function Group({ title, children, check, onCheck, defaultOpen = true }: { title: string; children?: ReactNode; check?: boolean; onCheck?: (v: boolean) => void; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const body = check === undefined ? open : check && open;
  return <div className="pm-group">
    <div className="pm-gtitle" onClick={() => setOpen(!open)}>
      {check !== undefined && <input type="checkbox" checked={check} onClick={e => e.stopPropagation()} onChange={e => { onCheck?.(e.target.checked); setOpen(true); }} />}
      <span>{title}</span><i>{open ? "︿" : "﹀"}</i>
    </div>
    {body && <div className="pm-gbody">{children}</div>}
  </div>;
}
function SelBox({ box, items, placeholder, icon, onRemove, onClear, max }: { box: string; items: string[]; placeholder: string; icon: string; onRemove?: (i: number) => void; onClear?: () => void; max?: number }) {
  const pm = useApp(s => s.pm); const active = pm?.box === box;
  return <div className={`selbox ${active ? "active" : ""}`} onClick={() => setBox(box)}>
    <Icon name={icon} size={16} />
    <div className="sb-list">
      {items.length === 0 && <span className="sb-ph">{placeholder}</span>}
      {items.map((t, i) => <div key={i} className="sb-item"><span>{t}</span>{onRemove && <i onClick={e => { e.stopPropagation(); onRemove(i); }}>×</i>}</div>)}
      {max && items.length > 0 && <small className="muted">{items.length} selected</small>}
    </div>
    {onClear && items.length > 0 && <button className="mini" title="Clear selections" onClick={e => { e.stopPropagation(); onClear(); }}>⌫</button>}
  </div>;
}
const RevBtn = ({ on, set }: { on: boolean; set: (v: boolean) => void }) => <button className={`mini rev ${on ? "on" : ""}`} title="Reverse Direction" onClick={() => set(!on)}>⇅</button>;

// ───────── main component
export function PropertyManager() {
  const s = useApp(); const pm = s.pm;
  if (!pm && s.sketch) return <SketchPM />;
  if (!pm) return <div className="lp-empty">No active command.<br /><br />Choose a feature from the CommandManager, or double-click a feature in the tree to edit it.</div>;
  const doc = s.activeId ? s.docs[s.activeId] : null; const u = doc ? unitLabel(doc.units) : "mm";
  const err = s.preview?.errors?.[pm.draft.id];
  const icon = ({ mate: "mate", explode: "explode", measure: "measure", moveComp: "move", rotateComp: "rotate" } as any)[pm.type] || pm.type;
  return <div className="pm">
    <div className="pm-head">
      <Icon name={icon} size={22} /><span className="pm-title">{pm.draft.name}</span>
      <div className="pm-actions">
        <button className="ok" title="OK (Enter)" onClick={() => pmConfirm()}>✔</button>
        <button className="cancel" title="Cancel (Esc)" onClick={() => pmCancel()}>✖</button>
        {!pm.editId && ["mate", "explode", "fillet", "chamfer", "extrude", "cut", "hole", "plane"].includes(pm.type) && <button className="pin" title="Keep Visible (OK and repeat)" onClick={() => pmConfirm(true)}><Icon name="pin" size={14} /></button>}
      </div>
    </div>
    {err ? <div className="pm-msg error">⚠ {err}</div> : <div className="pm-msg">{s.status}</div>}
    <PMBody type={pm.type} p={pm.draft.params} u={u} />
  </div>;
}

function sketchName(id: string | null) { const d = st().docs[st().activeId!] as PartDoc; return id ? d?.features?.find(f => f.id === id)?.name || "?" : ""; }
const refLabel = (r: any) => r.kind === "edge" ? `Edge<${r.index + 1}>` : `Face<${r.index + 1}>`;

function PMBody({ type, p, u }: { type: string; p: any; u: string }) {
  const s = useApp(); const set = (k: string, v: any) => updateDraft(q => ({ ...q, [k]: v }));
  const setIn = (k: string, k2: string, v: any) => updateDraft(q => ({ ...q, [k]: { ...(q[k] || {}), [k2]: v } }));
  const sketchBox = (key = "sketchId", box = "sketch", label = "Sketch") => <SelBox box={box} icon="sketch" items={p[key] ? [sketchName(p[key])] : []} placeholder={`Select a ${label.toLowerCase()} in the tree`} onClear={() => set(key, null)} />;
  switch (type) {
    case "extrude": case "cut": {
      const ends: [string, string][] = [["blind", "Blind"], ["throughAll", "Through All"], ["midPlane", "Mid Plane"], ["throughAllBoth", "Through All - Both"]];
      return <>
        <Group title="From"><Select value={p.offset ? "offset" : "plane"} options={[["plane", "Sketch Plane"], ["offset", "Offset"]]} onChange={v => set("offset", v === "offset" ? 5 : 0)} />{!!p.offset && <Num label="Offset" value={p.offset} onChange={v => set("offset", v)} unit={u} />}</Group>
        <Group title="Direction 1">
          <div className="pm-row"><RevBtn on={p.reverse} set={v => set("reverse", v)} /><select value={p.end} onChange={e => set("end", e.target.value)}>{ends.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>
          {sketchBox()}
          {(p.end === "blind" || p.end === "midPlane") && <Num icon="dimension" label="Depth D1" value={p.depth} min={0.001} onChange={v => set("depth", v)} unit={u} />}
          <div className="pm-row"><Check label="Draft" value={!!p.draft?.angle} onChange={v => setIn("draft", "angle", v ? 5 : 0)} />{!!p.draft?.angle && <><Num value={p.draft.angle} onChange={v => setIn("draft", "angle", v)} unit="°" min={0} /><Check label="Outward" value={p.draft.outward} onChange={v => setIn("draft", "outward", v)} /></>}</div>
          {type === "cut" && <Check label="Flip side to cut" value={p.flipSide} onChange={v => set("flipSide", v)} />}
        </Group>
        <Group title="Direction 2" check={!!p.dir2?.enabled} onCheck={v => setIn("dir2", "enabled", v)}>
          <Select value={p.dir2?.end || "blind"} options={[["blind", "Blind"], ["throughAll", "Through All"]]} onChange={v => setIn("dir2", "end", v)} />
          {p.dir2?.end !== "throughAll" && <Num label="Depth D2" value={p.dir2?.depth ?? 10} min={0.001} onChange={v => setIn("dir2", "depth", v)} unit={u} />}
        </Group>
        <Group title="Thin Feature" check={!!p.thin?.enabled} onCheck={v => setIn("thin", "enabled", v)} defaultOpen={false}>
          <Select value={p.thin?.side || "fwd"} options={[["fwd", "One-Direction"], ["rev", "One-Direction (reverse)"], ["mid", "Mid-Plane"]]} onChange={v => setIn("thin", "side", v)} />
          <Num label="T1" value={p.thin?.thickness ?? 1} min={0.001} onChange={v => setIn("thin", "thickness", v)} unit={u} />
        </Group>
        {type === "extrude" && <Group title="Feature Scope" defaultOpen={false}><Check label="Merge result" value={p.merge !== false} onChange={v => set("merge", v)} /></Group>}
        <Group title="Selected Contours" defaultOpen={false}><div className="pm-note">{p.contours?.length ? `${p.contours.length} contour(s)` : "All closed contours of the sketch are used. Nested loops become holes."}</div></Group>
      </>;
    }
    case "revolve": case "revolveCut": {
      const sk = (st().docs[st().activeId!] as PartDoc).features.find(f => f.id === p.sketchId)?.sketch;
      const axName = sk?.entities.find(e => e.id === p.axis) ? `Line (${p.axis.slice(-4)})` : "";
      return <>
        <Group title="Axis of Revolution"><SelBox box="axis" icon="axis" items={axName ? [axName] : []} placeholder="Select a centerline / line in the sketch (click it in the graphics area)" />{sketchBox()}
          {sk && <Select label="Axis" value={p.axis || ""} options={[["", "— choose —"], ...sk.entities.filter(e => e.type === "line").map(e => [e.id, `${e.construction ? "Centerline" : "Line"} ${e.id.slice(-4)}`] as [string, string])]} onChange={v => set("axis", v || null)} />}</Group>
        <Group title="Direction 1">
          <div className="pm-row"><RevBtn on={p.reverse} set={v => set("reverse", v)} /><select value={p.end} onChange={e => set("end", e.target.value)}><option value="blind">Blind</option><option value="midPlane">Mid-Plane</option></select></div>
          <Num icon="dimension" label="Angle" value={p.angle} min={0.01} onChange={v => set("angle", Math.min(360, v))} unit="°" step={15} />
        </Group>
        <Group title="Direction 2" check={!!p.dir2?.enabled} onCheck={v => setIn("dir2", "enabled", v)}><Num label="Angle" value={p.dir2?.angle ?? 0} min={0} onChange={v => setIn("dir2", "angle", v)} unit="°" step={15} /></Group>
        <Group title="Thin Feature" check={!!p.thin?.enabled} onCheck={v => setIn("thin", "enabled", v)} defaultOpen={false}><Num label="T1" value={p.thin?.thickness ?? 1} min={0.001} onChange={v => setIn("thin", "thickness", v)} unit={u} /></Group>
      </>;
    }
    case "sweep": case "sweepCut": return <>
      <Group title="Profile and Path">{sketchBox("profileId", "profile", "Profile")}{sketchBox("pathId", "path", "Path")}</Group>
      <Group title="Options"><Select label="Orientation" value={p.orient} options={[["follow", "Follow Path"], ["constant", "Keep Normal Constant"]]} onChange={v => set("orient", v)} /></Group>
    </>;
    case "loft": case "loftCut": return <>
      <Group title="Profiles">
        <SelBox box="profiles" icon="sketch" items={(p.profiles || []).map(sketchName)} placeholder="Select profile sketches in order" onRemove={i => set("profiles", p.profiles.filter((_: any, j: number) => j !== i))} onClear={() => set("profiles", [])} />
        {(p.profiles || []).length > 1 && <div className="pm-row"><button className="mini" onClick={() => set("profiles", [...p.profiles].reverse())}>⇅ Reverse order</button></div>}
      </Group>
      <Group title="Options"><Check label="Ruled (straight) surfaces" value={p.ruled} onChange={v => set("ruled", v)} /><Check label="Close loft" value={p.close} onChange={v => set("close", v)} /></Group>
    </>;
    case "fillet": return <>
      <Group title="Fillet Type"><div className="seg">{[["constant", "Constant Size"], ["variable", "Variable Size"]].map(([v, l]) => <button key={v} className={p.ftype === v ? "on" : ""} onClick={() => set("ftype", v)}>{l}</button>)}</div></Group>
      <Group title="Items To Fillet">
        <SelBox box="edges" icon="fillet" items={(p.edges || []).map(refLabel)} placeholder="Select edges (or a face to fillet all its edges)" onRemove={i => set("edges", p.edges.filter((_: any, j: number) => j !== i))} onClear={() => set("edges", [])} />
      </Group>
      <Group title="Fillet Parameters">
        <Num icon="dimension" label={p.ftype === "variable" ? "R start" : "Radius"} value={p.radius} min={0.001} onChange={v => set("radius", v)} unit={u} step={0.5} />
        {p.ftype === "variable" && <Num label="R end" value={p.radius2 ?? p.radius} min={0.001} onChange={v => set("radius2", v)} unit={u} step={0.5} />}
      </Group>
    </>;
    case "chamfer": return <>
      <Group title="Chamfer Type"><div className="seg">{[["equal", "Equal Distance"], ["angle", "Angle Distance"], ["distances", "Distance Distance"]].map(([v, l]) => <button key={v} className={p.ctype === v ? "on" : ""} onClick={() => set("ctype", v)}>{l}</button>)}</div></Group>
      <Group title="Items To Chamfer"><SelBox box="edges" icon="chamfer" items={(p.edges || []).map(refLabel)} placeholder="Select edges" onRemove={i => set("edges", p.edges.filter((_: any, j: number) => j !== i))} onClear={() => set("edges", [])} /></Group>
      <Group title="Chamfer Parameters">
        <Num icon="dimension" label="Distance" value={p.distance} min={0.001} onChange={v => set("distance", v)} unit={u} step={0.5} />
        {p.ctype === "angle" && <Num label="Angle" value={p.angle} min={1} onChange={v => set("angle", v)} unit="°" />}
        {p.ctype === "distances" && <Num label="Distance 2" value={p.distance2} min={0.001} onChange={v => set("distance2", v)} unit={u} step={0.5} />}
        {p.ctype !== "equal" && <Check label="Flip direction" value={p.flip} onChange={v => set("flip", v)} />}
      </Group>
    </>;
    case "shell": return <Group title="Parameters">
      <Num icon="dimension" label="Thickness" value={p.thickness} min={0.001} onChange={v => set("thickness", v)} unit={u} step={0.5} />
      <SelBox box="faces" icon="shell" items={(p.faces || []).map(refLabel)} placeholder="Select faces to remove" onRemove={i => set("faces", p.faces.filter((_: any, j: number) => j !== i))} onClear={() => set("faces", [])} />
      <Check label="Shell outward" value={p.outward} onChange={v => set("outward", v)} />
    </Group>;
    case "draft": return <>
      <Group title="Draft Angle"><Num icon="draft" value={p.angle} min={0.01} onChange={v => set("angle", v)} unit="°" /><Check label="Reverse direction" value={p.reverse} onChange={v => set("reverse", v)} /></Group>
      <Group title="Neutral Plane"><SelBox box="neutral" icon="plane" items={p.neutralLabel ? [p.neutralLabel] : []} placeholder="Select a plane or planar face" /></Group>
      <Group title="Faces to Draft"><SelBox box="faces" icon="draft" items={(p.faces || []).map(refLabel)} placeholder="Select faces" onRemove={i => set("faces", p.faces.filter((_: any, j: number) => j !== i))} onClear={() => set("faces", [])} /></Group>
    </>;
    case "hole": return <HolePM p={p} u={u} />;
    case "linearPattern": return <>
      <Group title="Direction 1"><div className="pm-row"><RevBtn on={p.reverse} set={v => set("reverse", v)} /><SelBox box="dir" icon="axis" items={p.dirLabel ? [p.dirLabel] : []} placeholder="Select a linear edge / axis" /></div>
        <Num icon="dimension" label="Spacing" value={p.spacing} min={0.001} onChange={v => set("spacing", v)} unit={u} /><Num label="Instances" value={p.count} min={1} step={1} unit="" onChange={v => set("count", Math.max(1, Math.round(v)))} /></Group>
      <Group title="Direction 2" check={!!p.dir2?.enabled} onCheck={v => setIn("dir2", "enabled", v)}><div className="pm-row"><RevBtn on={p.dir2?.reverse} set={v => setIn("dir2", "reverse", v)} /><SelBox box="dir2" icon="axis" items={p.dir2?.dirLabel ? [p.dir2.dirLabel] : []} placeholder="Select a second direction" /></div>
        <Num label="Spacing" value={p.dir2?.spacing ?? 20} min={0.001} onChange={v => setIn("dir2", "spacing", v)} unit={u} /><Num label="Instances" value={p.dir2?.count ?? 2} min={1} unit="" onChange={v => setIn("dir2", "count", Math.max(1, Math.round(v)))} /></Group>
      <Group title="Features to Pattern"><SelBox box="features" icon="linearPattern" items={(p.features || []).map(sketchName)} placeholder="Select features in the tree" onRemove={i => set("features", p.features.filter((_: any, j: number) => j !== i))} /></Group>
      <Group title="Instances to Skip" defaultOpen={false}><div className="pm-row"><input placeholder="e.g. 2, 4" defaultValue={(p.skip || []).join(", ")} onBlur={e => set("skip", e.target.value.split(/[ ,;]+/).map(Number).filter(n => n > 1))} /></div></Group>
    </>;
    case "circularPattern": return <>
      <Group title="Parameters"><div className="pm-row"><RevBtn on={p.reverse} set={v => set("reverse", v)} /><SelBox box="axis" icon="axis" items={p.axisLabel ? [p.axisLabel] : []} placeholder="Select an axis, circular edge or cylindrical face" /></div>
        <div className="pm-row"><button className="mini" onClick={() => updateDraft(q => ({ ...q, axis: { o: [0, 0, 0], d: [1, 0, 0] }, axisLabel: "X axis" }))}>X</button><button className="mini" onClick={() => updateDraft(q => ({ ...q, axis: { o: [0, 0, 0], d: [0, 1, 0] }, axisLabel: "Y axis" }))}>Y</button><button className="mini" onClick={() => updateDraft(q => ({ ...q, axis: { o: [0, 0, 0], d: [0, 0, 1] }, axisLabel: "Z axis" }))}>Z</button><small className="muted">origin axes</small></div>
        <Num icon="dimension" label="Angle" value={p.angle} min={0.01} onChange={v => set("angle", v)} unit="°" step={15} /><Num label="Instances" value={p.count} min={1} unit="" onChange={v => set("count", Math.max(1, Math.round(v)))} /><Check label="Equal spacing" value={p.equal} onChange={v => set("equal", v)} /></Group>
      <Group title="Features to Pattern"><SelBox box="features" icon="circularPattern" items={(p.features || []).map(sketchName)} placeholder="Select features in the tree" onRemove={i => set("features", p.features.filter((_: any, j: number) => j !== i))} /></Group>
    </>;
    case "mirror": return <>
      <Group title="Mirror Face/Plane"><SelBox box="plane" icon="plane" items={p.planeLabel ? [p.planeLabel] : []} placeholder="Select a plane or planar face" /></Group>
      <Group title="Features to Mirror"><SelBox box="features" icon="mirror" items={(p.features || []).map(sketchName)} placeholder="Select features (empty = mirror the whole body)" onRemove={i => set("features", p.features.filter((_: any, j: number) => j !== i))} /></Group>
    </>;
    case "plane": return <>
      <Group title="First Reference"><SelBox box="base" icon="plane" items={p.baseLabel ? [p.baseLabel] : []} placeholder="Select a plane or planar face" />
        <div className="pm-row">{["Front", "Top", "Right"].map(k => <button key={k} className="mini" onClick={() => import("../math").then(m => updateDraft(q => ({ ...q, base: m.PLANES[k], baseLabel: `${k} Plane`, refPlane: undefined })))}>{k}</button>)}</div>
        <Num icon="dimension" label="Offset" value={p.offset} onChange={v => set("offset", v)} unit={u} /><Check label="Flip offset" value={p.flip} onChange={v => set("flip", v)} />
      </Group>
      <Group title="Rotate About Edge (optional)" defaultOpen={!!p.rotAxis}><div className="pm-note">{p.rotAxis ? `Axis: ${p.rotAxisLabel}` : "Select a linear edge to create an angled plane."}</div>{p.rotAxis && <><Num label="Angle" value={p.angle} onChange={v => set("angle", v)} unit="°" step={15} /><button className="mini" onClick={() => updateDraft(q => ({ ...q, rotAxis: null, angle: 0 }))}>Remove axis</button></>}</Group>
    </>;
    case "axis": return <Group title="Selections">
      <SelBox box="axisRef" icon="axis" items={p.label ? [p.label] : []} placeholder="Select an edge, cylindrical face or plane" />
      <div className="pm-row">{[["X", [1, 0, 0]], ["Y", [0, 1, 0]], ["Z", [0, 0, 1]]].map(([n, d]) => <button key={n as string} className="mini" onClick={() => updateDraft(q => ({ ...q, o: [0, 0, 0], d, label: `${n} axis` }))}>{n as string} axis</button>)}</div>
      <div className="pm-note">Origin ({p.o.map((v: number) => fmt(v)).join(", ")}) · Direction ({p.d.map((v: number) => fmt(v, 3)).join(", ")})</div>
    </Group>;
    case "mate": return <MatePM p={p} u={u} />;
    case "explode": return <ExplodePM p={p} u={u} />;
    case "measure": return <MeasurePM p={p} u={u} />;
    case "moveComp": case "rotateComp": return <MoveCompPM type={type} p={p} u={u} />;
  }
  void s; return <div className="pm-note">No options.</div>;
}

function HolePM({ p, u }: { p: any; u: string }) {
  const set = (patch: any) => updateDraft(q => { const n = { ...q, ...patch }; return ["size", "fit", "htype"].some(k => k in patch) ? { ...n, ...holeDims(n) } : n; });
  const [tab, setTab] = useState<"type" | "pos">(p.plane ? "pos" : "type");
  return <>
    <div className="seg tabs"><button className={tab === "type" ? "on" : ""} onClick={() => setTab("type")}>Type</button><button className={tab === "pos" ? "on" : ""} onClick={() => { setTab("pos"); setBox(p.plane ? "points" : "face"); }}>Positions</button></div>
    {tab === "type" ? <>
      <Group title="Hole Type"><div className="seg">{[["cbore", "Counterbore"], ["csink", "Countersink"], ["simple", "Hole"], ["tap", "Straight Tap"]].map(([v, l]) => <button key={v} className={p.htype === v ? "on" : ""} onClick={() => set({ htype: v })}>{l}</button>)}</div>
        <Select label="Standard" value="ISO" options={[["ISO", "ISO"]]} onChange={() => { }} />
        <Select label="Size" value={p.size} options={Object.keys(HOLE_TABLE).map(k => [k, k])} onChange={v => set({ size: v })} />
        {p.htype !== "tap" && <Select label="Fit" value={p.fit} options={[["close", "Close"], ["normal", "Normal"], ["loose", "Loose"]]} onChange={v => set({ fit: v })} />}</Group>
      <Group title="End Condition"><Select value={p.end} options={[["throughAll", "Through All"], ["blind", "Blind"]]} onChange={v => set({ end: v })} />{p.end === "blind" && <Num label="Depth" value={p.depth} min={0.01} onChange={v => set({ depth: v })} unit={u} />}</Group>
      <Group title="Specification">
        <Num label="⌀ Hole" value={p.dia} min={0.01} onChange={v => updateDraft(q => ({ ...q, dia: v }))} unit={u} step={0.1} />
        {p.htype === "cbore" && <><Num label="⌀ C'bore" value={p.cbDia} min={0.01} onChange={v => updateDraft(q => ({ ...q, cbDia: v }))} unit={u} step={0.1} /><Num label="C'bore depth" value={p.cbDepth} min={0.01} onChange={v => updateDraft(q => ({ ...q, cbDepth: v }))} unit={u} step={0.1} /></>}
        {p.htype === "csink" && <><Num label="⌀ C'sink" value={p.csDia} min={0.01} onChange={v => updateDraft(q => ({ ...q, csDia: v }))} unit={u} step={0.1} /><Num label="Angle" value={p.csAngle ?? 90} min={1} onChange={v => updateDraft(q => ({ ...q, csAngle: v }))} unit="°" /></>}
      </Group>
    </> : <>
      <Group title="Placement Face"><SelBox box="face" icon="hole" items={p.faceLabel ? [p.faceLabel] : []} placeholder="Select a planar face" /></Group>
      <Group title={`Hole Positions (${p.points.length})`}>
        {p.points.length === 0 && <div className="pm-note">{p.plane ? "Click on the face in the graphics area to place hole centers." : "First select a planar face."}</div>}
        {p.points.map((pt: number[], i: number) => <div key={i} className="pm-row pts"><b>#{i + 1}</b>
          <Num label="X" value={pt[0]} onChange={v => updateDraft(q => ({ ...q, points: q.points.map((x: number[], j: number) => j === i ? [v, x[1]] : x) }))} unit="" />
          <Num label="Y" value={pt[1]} onChange={v => updateDraft(q => ({ ...q, points: q.points.map((x: number[], j: number) => j === i ? [x[0], v] : x) }))} unit="" />
          <button className="mini" onClick={() => updateDraft(q => ({ ...q, points: q.points.filter((_: any, j: number) => j !== i) }))}>×</button></div>)}
        {p.plane && <div className="pm-row"><button className="mini" onClick={() => updateDraft(q => ({ ...q, points: [...q.points, [0, 0]] }))}>+ Add at (0,0)</button></div>}
      </Group>
    </>}
  </>;
}

const MATE_LABEL: Record<MateType, string> = { coincident: "Coincident", parallel: "Parallel", perpendicular: "Perpendicular", tangent: "Tangent", concentric: "Concentric", lock: "Lock", distance: "Distance", angle: "Angle" };
function MatePM({ p, u }: { p: any; u: string }) {
  const s = useApp(); const asm = s.docs[s.activeId!] as AssemblyDoc;
  const lab = (r: any) => { const c = asm.components.find(x => x.id === r.comp); const g = geoOfRef(asm, r); return `${r.kind === "edge" ? "Edge" : "Face"}<${r.face + 1}>@${c?.name}<${c?.instance}> ${g ? `(${g.kind})` : ""}`; };
  const allowed: MateType[] = p.allowed || (p.a && p.b ? allowedMates(geoOfRef(asm, p.a), geoOfRef(asm, p.b)) : ["coincident", "parallel", "perpendicular", "tangent", "concentric", "lock", "distance", "angle"]);
  const pick = (t: MateType) => { updateDraft(q => ({ ...q, mtype: t, userPicked: true, value: t === "angle" ? (q.mtype === "angle" ? q.value : 90) : t === "distance" ? (q.mtype === "distance" ? q.value : 10) : q.value })); setTimeout(previewMate); };
  return <>
    <Group title="Mate Selections">
      <SelBox box="mateA" icon="mate" items={p.a ? [lab(p.a)] : []} placeholder="Select a face/edge on the first component" onClear={() => updateDraft(q => ({ ...q, a: null }))} />
      <SelBox box="mateB" icon="mate" items={p.b ? [lab(p.b)] : []} placeholder="Select a face/edge on the second component" onClear={() => updateDraft(q => ({ ...q, b: null }))} />
    </Group>
    <Group title="Standard Mates">
      <div className="mate-grid">{(["coincident", "parallel", "perpendicular", "tangent", "concentric", "lock"] as MateType[]).map(t => <button key={t} disabled={!allowed.includes(t)} className={p.mtype === t ? "on" : ""} onClick={() => pick(t)}>{MATE_LABEL[t]}</button>)}</div>
      <div className="mate-grid">{(["distance", "angle"] as MateType[]).map(t => <button key={t} disabled={!allowed.includes(t)} className={p.mtype === t ? "on" : ""} onClick={() => pick(t)}>{MATE_LABEL[t]}</button>)}</div>
      {(p.mtype === "distance" || p.mtype === "angle") && <Num label={p.mtype === "distance" ? "Distance" : "Angle"} value={p.value} onChange={v => { updateDraft(q => ({ ...q, value: v })); setTimeout(previewMate); }} unit={p.mtype === "angle" ? "°" : u} min={0} />}
      <div className="pm-row"><span className="muted">Mate alignment:</span><div className="seg"><button className={!p.flip ? "on" : ""} onClick={() => { updateDraft(q => ({ ...q, flip: false })); setTimeout(previewMate); }}>Aligned</button><button className={p.flip ? "on" : ""} onClick={() => { updateDraft(q => ({ ...q, flip: true })); setTimeout(previewMate); }}>Anti-Aligned</button></div></div>
    </Group>
    <Group title="Mates" defaultOpen={false}>{asm.mates.map(m => <div key={m.id} className={`pm-note ${m.status === "error" ? "error" : ""}`}>{m.name}</div>)}</Group>
  </>;
}
function ExplodePM({ p, u }: { p: any; u: string }) {
  const s = useApp(); const asm = s.docs[s.activeId!] as AssemblyDoc; const set = (k: string, v: any) => updateDraft(q => ({ ...q, [k]: v }));
  const dirs: [string, number[]][] = [["+X", [1, 0, 0]], ["-X", [-1, 0, 0]], ["+Y", [0, 1, 0]], ["-Y", [0, -1, 0]], ["+Z", [0, 0, 1]], ["-Z", [0, 0, -1]]];
  return <>
    <Group title="Explode Steps">{asm.explode.length ? asm.explode.map((e, i) => <div key={e.id} className="pm-row"><span>Explode Step{i + 1}: {e.comps.length} comp · {fmt(e.dist)}{u}</span><button className="mini" onClick={() => s.updateDoc(asm.id, (a: AssemblyDoc) => ({ ...a, explode: a.explode.filter(x => x.id !== e.id) }))}>×</button></div>) : <div className="pm-note">No steps yet.</div>}</Group>
    <Group title="Settings">
      <SelBox box="comps" icon="part" items={(p.comps || []).map((id: string) => { const c = asm.components.find(x => x.id === id); return `${c?.name}<${c?.instance}>`; })} placeholder="Select components to move" onClear={() => set("comps", [])} />
      <div className="seg">{dirs.map(([l, d]) => <button key={l} className={JSON.stringify(p.dir) === JSON.stringify(d) ? "on" : ""} onClick={() => set("dir", d)}>{l}</button>)}</div>
      <Num label="Distance" value={p.dist} onChange={v => set("dist", v)} unit={u} step={5} />
      <div className="pm-row"><button className="btn" onClick={() => pmConfirm(true)}>Apply step</button><button className="btn" onClick={() => s.updateDoc(asm.id, (a: AssemblyDoc) => ({ ...a, exploded: !a.exploded }))}>{asm.exploded ? "Collapse" : "Explode"}</button></div>
    </Group>
  </>;
}
function MoveCompPM({ type, p, u }: { type: string; p: any; u: string }) {
  const s = useApp(); const asm = s.docs[s.activeId!] as AssemblyDoc; const sel = s.selection.find(x => x.kind === "comp" || (x as any).comp) as any; const cid = sel ? (sel.kind === "comp" ? sel.id : sel.comp) : null; const c = asm.components.find(x => x.id === cid);
  const apply = () => { if (!c) return s.showToast("Select a component first"); if (c.fixed) return s.showToast(`${c.name} is fixed — float it first`);
    import("../math").then(m => s.updateDoc(asm.id, (a: AssemblyDoc) => ({ ...a, components: a.components.map(x => { if (x.id !== c.id) return x; if (type === "moveComp") return { ...x, t: { p: m.add(x.t.p, [p.dx, p.dy, p.dz]), q: x.t.q } }; let q = x.t.q as any; if (p.rx) q = m.qMul(m.qFromAxisAngle([1, 0, 0], p.rx * Math.PI / 180), q); if (p.ry) q = m.qMul(m.qFromAxisAngle([0, 1, 0], p.ry * Math.PI / 180), q); if (p.rz) q = m.qMul(m.qFromAxisAngle([0, 0, 1], p.rz * Math.PI / 180), q); return { ...x, t: { p: x.t.p, q } }; }) }))); };
  const set = (k: string, v: number) => updateDraft(q => ({ ...q, [k]: v }));
  return <>
    <Group title="Move"><div className="pm-note">Drag a free (non-fixed) component in the graphics area{type === "rotateComp" ? " to rotate it" : ""}. Mates are respected while dragging.</div></Group>
    <Group title={type === "moveComp" ? "By Delta XYZ" : "By Angle (°)"}>
      <div className="pm-note">{c ? `Component: ${c.name}<${c.instance}> ${c.fixed ? "(fixed)" : ""}` : "Select a component"}</div>
      {type === "moveComp" ? <><Num label="ΔX" value={p.dx} onChange={v => set("dx", v)} unit={u} /><Num label="ΔY" value={p.dy} onChange={v => set("dy", v)} unit={u} /><Num label="ΔZ" value={p.dz} onChange={v => set("dz", v)} unit={u} /></>
        : <><Num label="X" value={p.rx} onChange={v => set("rx", v)} unit="°" step={15} /><Num label="Y" value={p.ry} onChange={v => set("ry", v)} unit="°" step={15} /><Num label="Z" value={p.rz} onChange={v => set("rz", v)} unit="°" step={15} /></>}
      <div className="pm-row"><button className="btn" onClick={apply}>Apply</button></div>
    </Group>
  </>;
}

function MeasurePM({ p, u }: { p: any; u: string }) {
  const s = useApp(); const items: Sel[] = p.items || []; const doc = s.docs[s.activeId!];
  const lines = measureLines(items, doc, s.builds as any);
  return <>
    <Group title="Selections"><div className="sb-list">{items.length ? items.map((x, i) => <div key={i} className="sb-item"><span>{selLabel(x)}</span></div>) : <span className="sb-ph">Select faces, edges or vertices (up to 2)</span>}</div>
      <div className="pm-row"><button className="mini" onClick={() => updateDraft(q => ({ ...q, items: [] }))}>Clear</button></div></Group>
    <Group title="Results">{lines.length ? lines.map((l, i) => <div key={i} className="measure-line"><span>{l[0]}</span><b>{l[1]}</b></div>) : <div className="pm-note">—</div>}</Group>
    <div className="pm-note">Units: {u}</div>
  </>;
}
const selLabel = (x: Sel) => x.kind === "face" ? `Face<${x.index + 1}>` : x.kind === "edge" ? `Edge<${x.index + 1}>` : x.kind === "vertex" ? `Vertex (${x.point.map(v => fmt(v)).join(", ")})` : x.kind === "plane" ? x.plane.name || x.id : x.kind;
function geoInfo(x: Sel, doc: any, builds: any) {
  const comp = (x as any).comp; let b: any, t: any = null;
  if (doc.kind === "assembly" && comp) { const c = doc.components.find((q: any) => q.id === comp); b = builds[c?.partId]?.main; t = compWorld(doc, comp); } else b = builds[doc.id]?.main;
  return { b, t };
}
function measureLines(items: Sel[], doc: any, builds: any): [string, string][] {
  const out: [string, string][] = []; if (!doc) return out;
  const W = (t: any, v: any) => t ? applyT(t, v) : v;
  const desc = items.map(x => { const { b, t } = geoInfo(x, doc, builds);
    if (x.kind === "face") { const f = b?.faces[x.index]; if (!f) return null; return { k: "face", f, c: W(t, f.center), n: f.normal, area: f.area, axis: f.axis }; }
    if (x.kind === "edge") { const e = b?.edges[x.index]; if (!e) return null; return { k: "edge", e, a: e.a && W(t, e.a), b: e.b && W(t, e.b), c: W(t, e.mid), L: e.length, circle: e.circle }; }
    if (x.kind === "vertex") return { k: "vertex", c: x.point };
    return null; });
  const one = desc[0], two = desc[1];
  for (const d of desc) { if (!d) continue;
    if (d.k === "face") { out.push([`Face area`, `${fmt(d.area, 3)} mm²`]); if (d.axis) out.push(["Diameter", `${fmt(d.axis.r * 2, 3)} mm`]); }
    if (d.k === "edge") { out.push(["Length", `${fmt(d.L, 3)} mm`]); if (d.circle) out.push(["Diameter", `${fmt(d.circle.r * 2, 3)} mm`], ["Center", d.circle.c.map((v: number) => fmt(v)).join(", ")]); }
    if (d.k === "vertex") out.push(["X, Y, Z", d.c.map((v: number) => fmt(v, 3)).join(", ")]);
  }
  if (one && two) {
    const c1 = one.c, c2 = two.c; const dv = sub(c2, c1); out.push(["Center distance", `${fmt(len(dv), 3)} mm`], ["dX / dY / dZ", dv.map(v => fmt(v, 3)).join(" / ")]);
    if (one.k === "face" && two.k === "face" && one.n && two.n) {
      const cosA = Math.abs(dot(one.n, two.n)); const ang = Math.acos(Math.min(1, cosA)) * 180 / Math.PI; out.push(["Angle", `${fmt(ang, 2)}°`]);
      if (cosA > 0.9999) out.push(["Normal distance", `${fmt(Math.abs(dot(dv, one.n)), 3)} mm`]);
    }
  }
  return out;
}

// ───────── sketch PropertyManager (tool options, entity properties, relations, sketch edit ops)
const REL_LABEL: Partial<Record<ConstraintType, string>> = { horizontal: "Horizontal", vertical: "Vertical", coincident: "Coincident", parallel: "Parallel", perpendicular: "Perpendicular", equal: "Equal", tangent: "Tangent", concentric: "Concentric", midpoint: "Midpoint", fix: "Fix", pointOnLine: "Coincident", pointOnCircle: "Coincident", collinear: "Collinear", symmetric: "Symmetric", hpoints: "Horizontal", vpoints: "Vertical", coradial: "Coradial" };
function availableRelations(sk: Sketch, ids: string[]): { t: ConstraintType; refs: string[]; label: string }[] {
  const ents = ids.map(id => sk.entities.find(e => e.id === id)).filter(Boolean) as SkEntity[]; const pts = ids.filter(id => sk.points[id]);
  const out: { t: ConstraintType; refs: string[]; label: string }[] = [];
  const lines = ents.filter(e => e.type === "line"); const circs = ents.filter(e => e.type === "circle" || e.type === "arc");
  const add = (t: ConstraintType, refs: string[], label = REL_LABEL[t] || t) => out.push({ t, refs, label });
  if (ids.length === 1) { if (lines.length === 1) { add("horizontal", [lines[0].id]); add("vertical", [lines[0].id]); } add("fix", ids); }
  if (lines.length === 2 && ids.length === 2) { add("parallel", [lines[0].id, lines[1].id]); add("perpendicular", [lines[0].id, lines[1].id]); add("equal", [lines[0].id, lines[1].id]); add("collinear", [lines[0].id, lines[1].id]); }
  if (lines.length === 1 && circs.length === 1 && ids.length === 2) add("tangent", [lines[0].id, circs[0].id]);
  if (circs.length === 2 && ids.length === 2) { add("equal", [circs[0].id, circs[1].id]); add("concentric", [circs[0].id, circs[1].id]); add("tangent", [circs[0].id, circs[1].id]); }
  if (pts.length === 2 && ids.length === 2) { add("coincident", pts); add("hpoints", pts, "Horizontal"); add("vpoints", pts, "Vertical"); }
  if (pts.length === 1 && lines.length === 1 && ids.length === 2) { add("pointOnLine", [pts[0], lines[0].id], "Coincident"); add("midpoint", [pts[0], lines[0].id]); }
  if (pts.length === 1 && circs.length === 1 && ids.length === 2) add("pointOnCircle", [pts[0], circs[0].id], "Coincident");
  if (pts.length === 2 && lines.length === 1 && ids.length === 3) add("symmetric", [pts[0], pts[1], lines[0].id]);
  if (lines.length === 3 && ids.length === 3) { const cl = lines.find(l => l.construction) || lines[2]; const o = lines.filter(l => l !== cl); add("symmetric", [o[0].id, o[1].id, cl.id]); }
  return out;
}
function SketchPM() {
  const s = useApp(); const ss = s.sketch!; const sk = ss.sk; const u = unitLabel(s.docs[s.activeId!]?.units || "MMGS");
  const selIds = s.selection.filter(x => x.kind === "sk").map((x: any) => x.id);
  const selCons = s.selection.filter(x => x.kind === "skc").map((x: any) => x.id);
  const solve = ss.solve; const status = solve?.status === "over" ? "Over Defined" : solve?.status === "full" ? "Fully Defined" : `Under Defined (${solve?.dof ?? "?"} DOF)`;
  const setOpt = (k: string, v: any) => useApp.setState({ sketch: { ...ss, toolOpts: { ...ss.toolOpts, [k]: v } } });
  const addRel = (t: ConstraintType, refs: string[]) => { const c: Constraint = { id: uid("c"), type: t, refs }; const ok = s.skSet({ ...sk, constraints: [...sk.constraints, c] }); if (!ok) { s.showToast(`${REL_LABEL[t] || t} would over-define the sketch`); s.skSet({ ...sk, constraints: [...sk.constraints, c] }, { force: true }); } };
  const delCons = (ids: string[]) => { s.skSet({ ...sk, constraints: sk.constraints.filter(c => !ids.includes(c.id)) }, { force: true }); useApp.setState({ selection: s.selection.filter(x => !(x.kind === "skc" && ids.includes((x as any).id))) }); };
  const op = ss.tool === "select" ? ss.mode : "";
  const related = sk.constraints.filter(c => !DIM_TYPES.has(c.type) && c.refs.some(r => selIds.includes(r)));
  const one = selIds.length === 1 ? (sk.entities.find(e => e.id === selIds[0]) || null) : null; const onePt = selIds.length === 1 && sk.points[selIds[0]] ? sk.points[selIds[0]] : null;
  const head = (title: string, icon: string, onOk?: () => void) => <div className="pm-head"><Icon name={icon} size={22} /><span className="pm-title">{title}</span><div className="pm-actions"><button className="ok" title="OK" onClick={() => { onOk?.(); s.setTool("select"); }}>✔</button><button className="cancel" title="Close" onClick={() => s.setTool("select")}>✖</button></div></div>;
  // sketch edit operations
  if (op && ["offset", "sketchMirror", "move", "copyEnt", "rotate", "scale", "sketchLinear", "sketchCircular", "relations"].includes(op)) {
    return <div className="pm"><OpPM op={op} ss={ss} selIds={selIds} u={u} setOpt={setOpt} head={head} addRel={addRel} delCons={delCons} /></div>;
  }
  const toolTitle: Record<string, string> = { line: "Insert Line", centerline: "Insert Centerline", circle: "Circle", rect: "Rectangle", arc: "Arc", polygon: "Polygon", spline: "Spline", slot: "Slot", ellipse: "Ellipse", point: "Point", trim: "Trim", extend: "Extend", dimension: "Smart Dimension" };
  if (ss.tool !== "select") return <div className="pm">
    {head(toolTitle[ss.tool] || ss.tool, ss.tool === "dimension" ? "dimension" : ss.tool)}
    <div className="pm-msg">{TOOL_HINT[ss.tool] || ""}</div>
    <Group title="Options">
      <Check label="For construction" value={ss.toolOpts.construction} onChange={v => setOpt("construction", v)} />
      {ss.tool === "polygon" && <><Num label="Sides" value={ss.toolOpts.sides} min={3} unit="" onChange={v => setOpt("sides", Math.max(3, Math.round(v)))} /><Check label="Inscribed circle" value={ss.toolOpts.inscribed} onChange={v => setOpt("inscribed", v)} /></>}
      <Check label="Automatic relations" value={s.options.autoRelations} onChange={v => useApp.setState({ options: { ...s.options, autoRelations: v } })} />
      <Check label="Enter dimension value on create" value={s.options.inputDim} onChange={v => useApp.setState({ options: { ...s.options, inputDim: v } })} />
      <Check label="Snap to grid" value={s.options.snapGrid} onChange={v => useApp.setState({ options: { ...s.options, snapGrid: v } })} />
    </Group>
    {["rect", "arc", "circle", "slot"].includes(ss.tool) && <Group title="Type"><div className="seg">{({ rect: [["corner", "Corner"], ["center", "Center"], ["3corner", "3 Pt Corner"], ["3center", "3 Pt Center"], ["parallelogram", "Parallelogram"]], arc: [["center", "Centerpoint"], ["tangent", "Tangent"], ["3point", "3 Point"]], circle: [["center", "Circle"], ["perimeter", "Perimeter"]], slot: [["straight", "Straight"], ["center", "Centerpoint"]] } as any)[ss.tool].map(([v, l]: string[]) => <button key={v} className={ss.mode === v ? "on" : ""} onClick={() => s.setTool(ss.tool, v)}>{l}</button>)}</div></Group>}
    <SketchStatus status={status} solve={solve} />
  </div>;
  return <div className="pm">
    <div className="pm-head"><Icon name="sketch" size={22} /><span className="pm-title">{ss.name}</span><div className="pm-actions"><button className="ok" title="Exit Sketch" onClick={() => s.exitSketch(true)}>✔</button><button className="cancel" title="Discard changes" onClick={() => s.exitSketch(false)}>✖</button></div></div>
    <SketchStatus status={status} solve={solve} />
    {selCons.length > 0 && <Group title="Selected relations / dimensions">{selCons.map(id => { const c = sk.constraints.find(x => x.id === id); return c ? <div key={id} className="pm-row"><span>{REL_LABEL[c.type] || c.type}{c.value !== undefined ? ` = ${fmt(c.value, 3)}` : ""}</span><button className="mini" onClick={() => delCons([id])}>Delete</button></div> : null; })}</Group>}
    {selIds.length > 0 ? <>
      <Group title="Existing Relations">{related.length ? related.map(c => <div key={c.id} className={`pm-row rel ${solve?.bad.has(c.id) ? "error" : ""}`}><span>{REL_LABEL[c.type] || c.type}</span><button className="mini" onClick={() => delCons([c.id])} title="Delete relation">×</button></div>) : <div className="pm-note">None</div>}</Group>
      <Group title="Add Relations">{availableRelations(sk, selIds).map((r, i) => <button key={i} className="rel-btn" onClick={() => addRel(r.t, r.refs)}>{r.label}</button>)}{!availableRelations(sk, selIds).length && <div className="pm-note">Select entities to see available relations.</div>}</Group>
      {one && <EntityProps sk={sk} e={one} u={u} />}
      {onePt && <PointProps sk={sk} id={onePt.id} />}
      <Group title="Options"><Check label="For construction" value={selIds.every(id => sk.entities.find(e => e.id === id)?.construction)} onChange={v => s.skSet({ ...sk, entities: sk.entities.map(e => selIds.includes(e.id) ? { ...e, construction: v } as SkEntity : e) }, { force: true })} /></Group>
    </> : <Group title="Sketch">
      <div className="pm-note">Plane: {sk.planeLabel}<br />Entities: {sk.entities.length} · Relations: {sk.constraints.filter(c => !DIM_TYPES.has(c.type)).length} · Dimensions: {sk.constraints.filter(c => DIM_TYPES.has(c.type)).length}</div>
      <div className="pm-note">Pick a sketch tool (L line, C circle, R rectangle, A arc, D smart dimension). Drag under-defined (blue) geometry to move it. Double-click a dimension to change its value.</div>
    </Group>}
  </div>;
}
function SketchStatus({ status, solve }: { status: string; solve: any }) {
  return <div className={`pm-msg sk-status ${solve?.status}`}>{status}{solve?.status === "over" && solve.bad.size ? ` — ${solve.bad.size} conflicting relation(s) shown in red` : ""}</div>;
}
function EntityProps({ sk, e, u }: { sk: Sketch; e: SkEntity; u: string }) {
  const s = useApp(); const P = (id: string) => sk.points[id];
  const setPts = (patch: Record<string, [number, number]>) => { const ok = s.skSet(sk, { drag: patch }); if (!ok) s.showToast("Cannot move: the geometry is constrained"); };
  if (e.type === "line") { const a = P(e.p1), b = P(e.p2); const L = Math.hypot(b.x - a.x, b.y - a.y); const ang = Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI;
    return <Group title="Parameters"><Num label="Length" value={L} min={0.001} unit={u} onChange={v => { const k = v / (L || 1); setPts({ [e.p2]: [a.x + (b.x - a.x) * k, a.y + (b.y - a.y) * k] }); }} /><Num label="Angle" value={ang} unit="°" onChange={v => { const r = v * Math.PI / 180; setPts({ [e.p2]: [a.x + L * Math.cos(r), a.y + L * Math.sin(r)] }); }} />
      <div className="pm-note">Start ({fmt(a.x)}, {fmt(a.y)}) · End ({fmt(b.x)}, {fmt(b.y)})</div></Group>; }
  if (e.type === "circle") { const c = P(e.c); return <Group title="Parameters"><div className="pm-note">Center ({fmt(c.x)}, {fmt(c.y)})</div><Num label="Radius" value={e.r} min={0.001} unit={u} onChange={v => { const n = { ...sk, entities: sk.entities.map(x => x.id === e.id ? { ...x, r: v } as SkEntity : x) }; if (!s.skSet(n)) s.showToast("Radius is constrained — edit its dimension instead"); }} /></Group>; }
  if (e.type === "arc") { const c = P(e.c), a = P(e.p1); return <Group title="Parameters"><div className="pm-note">Center ({fmt(c.x)}, {fmt(c.y)}) · Radius {fmt(Math.hypot(a.x - c.x, a.y - c.y), 3)}</div></Group>; }
  return null;
}
function PointProps({ sk, id }: { sk: Sketch; id: string }) {
  const s = useApp(); const p = sk.points[id];
  const mv = (x: number, y: number) => { if (!s.skSet(sk, { drag: { [id]: [x, y] } })) s.showToast("Point is constrained"); };
  return <Group title="Point"><Num label="X" value={p.x} onChange={v => mv(v, p.y)} unit="" /><Num label="Y" value={p.y} onChange={v => mv(p.x, v)} unit="" /></Group>;
}

function OpPM({ op, ss, selIds, u, setOpt, head, addRel, delCons }: any) {
  const s = useApp(); const [v, setV] = useState<any>({ dx: 20, dy: 0, angle: 90, cx: 0, cy: 0, factor: 2, copy: false, count: 3, cangle: 360, axis: "" });
  const sel = selIds.map((id: string) => { const e = ss.sk.entities.find((x: SkEntity) => x.id === id); return e ? `${e.construction ? "Centerline" : e.type[0].toUpperCase() + e.type.slice(1)} ${id.slice(-4)}` : `Point ${id.slice(-4)}`; });
  const ents = <Group title="Entities"><div className="sb-list">{sel.length ? sel.map((t: string, i: number) => <div key={i} className="sb-item"><span>{t}</span></div>) : <span className="sb-ph">Select sketch entities in the graphics area</span>}</div></Group>;
  const N = (k: string, label: string, unit = u, step = 1) => <Num label={label} value={v[k]} onChange={x => setV({ ...v, [k]: x })} unit={unit} step={step} />;
  switch (op) {
    case "offset": return <>{head("Offset Entities", "offset", () => sketchOffset())}<Group title="Parameters"><Num label="Distance" value={ss.toolOpts.offset} min={0.001} unit={u} onChange={x => setOpt("offset", x)} /><Check label="Reverse" value={!!ss.toolOpts.reverse} onChange={x => setOpt("reverse", x)} /><Check label="Bi-directional" value={!!ss.toolOpts.bidirectional} onChange={x => setOpt("bidirectional", x)} /><Check label="Construction offset" value={ss.toolOpts.construction} onChange={x => setOpt("construction", x)} /><div className="pm-note">Selecting one entity offsets its whole connected chain.</div><button className="btn" onClick={() => sketchOffset()}>Apply</button></Group>{ents}</>;
    case "sketchMirror": { const lines = ss.sk.entities.filter((e: SkEntity) => e.type === "line"); return <>{head("Mirror Entities", "sketchMirror")}{ents}<Group title="Mirror about"><select value={v.axis} onChange={e => setV({ ...v, axis: e.target.value })}><option value="">— last selected line —</option>{lines.map((l: SkEntity) => <option key={l.id} value={l.id}>{l.construction ? "Centerline" : "Line"} {l.id.slice(-4)}</option>)}</select><button className="btn" onClick={() => transformSketch("mirror", { axis: v.axis || selIds[selIds.length - 1] })}>Apply</button><div className="pm-note">Mirrored copies get Symmetric relations about the line.</div></Group></>; }
    case "move": case "copyEnt": return <>{head(op === "move" ? "Move" : "Copy", "move")}{ents}<Group title="Translate">{N("dx", "ΔX")}{N("dy", "ΔY")}<button className="btn" onClick={() => transformSketch(op === "move" ? "move" : "copy", { dx: v.dx, dy: v.dy })}>Apply</button></Group></>;
    case "rotate": return <>{head("Rotate", "rotate")}{ents}<Group title="Rotate">{N("cx", "Center X")}{N("cy", "Center Y")}{N("angle", "Angle", "°", 15)}<Check label="Keep original (copy)" value={v.copy} onChange={x => setV({ ...v, copy: x })} /><button className="btn" onClick={() => transformSketch("rotate", { angle: v.angle, cx: v.cx, cy: v.cy, copy: v.copy })}>Apply</button></Group></>;
    case "scale": return <>{head("Scale", "scale")}{ents}<Group title="Scale">{N("cx", "Base X")}{N("cy", "Base Y")}{N("factor", "Factor", "", 0.1)}<Check label="Copy" value={v.copy} onChange={x => setV({ ...v, copy: x })} /><button className="btn" onClick={() => transformSketch("scale", v)}>Apply</button></Group></>;
    case "sketchLinear": return <>{head("Linear Sketch Pattern", "linearPattern")}{ents}<Group title="Direction">{N("dx", "Spacing X")}{N("dy", "Spacing Y")}<Num label="Instances" value={v.count} min={2} unit="" onChange={x => setV({ ...v, count: Math.round(x) })} /><button className="btn" onClick={() => transformSketch("linear", v)}>Apply</button></Group></>;
    case "sketchCircular": return <>{head("Circular Sketch Pattern", "circularPattern")}{ents}<Group title="Parameters">{N("cx", "Center X")}{N("cy", "Center Y")}<Num label="Angle" value={v.cangle} unit="°" onChange={x => setV({ ...v, cangle: x })} /><Num label="Instances" value={v.count} min={2} unit="" onChange={x => setV({ ...v, count: Math.round(x) })} /><button className="btn" onClick={() => transformSketch("circular", { ...v, angle: v.cangle })}>Apply</button></Group></>;
    case "relations": { const all = ss.sk.constraints.filter((c: Constraint) => !DIM_TYPES.has(c.type)); const dims = ss.sk.constraints.filter((c: Constraint) => DIM_TYPES.has(c.type));
      return <>{head("Display/Delete Relations", "relations")}
        <Group title={`Relations (${all.length})`}>{all.map((c: Constraint) => <div key={c.id} className={`pm-row rel ${ss.solve?.bad.has(c.id) ? "error" : ""}`} onMouseEnter={() => useApp.setState({ selection: c.refs.map(r => ({ kind: "sk", id: r } as Sel)) })}><span>{REL_LABEL[c.type] || c.type}</span><small className="muted">{ss.solve?.bad.has(c.id) ? "Conflicting" : "Satisfied"}</small><button className="mini" onClick={() => delCons([c.id])}>×</button></div>)}
          <div className="pm-row"><button className="btn" onClick={() => delCons(all.map((c: Constraint) => c.id))}>Delete All</button><button className="btn" onClick={() => delCons(all.filter((c: Constraint) => ss.solve?.bad.has(c.id)).map((c: Constraint) => c.id))}>Delete Conflicting</button></div></Group>
        <Group title={`Dimensions (${dims.length})`}>{dims.map((c: Constraint) => <div key={c.id} className={`pm-row rel ${ss.solve?.bad.has(c.id) ? "error" : ""}`}><span>{c.name || "D"} ({c.type})</span><b>{fmt(c.value ?? measureDim(ss.sk, c), 3)}</b><button className="mini" onClick={() => delCons([c.id])}>×</button></div>)}</Group>
        {selIds.length > 0 && <Group title="Add Relations">{availableRelations(ss.sk, selIds).map((r, i) => <button key={i} className="rel-btn" onClick={() => addRel(r.t, r.refs)}>{r.label}</button>)}</Group>}
      </>; }
  }
  void s; void sketchSelected; void selKey; return null;
}
