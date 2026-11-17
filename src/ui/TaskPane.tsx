import { useApp, newPart } from "../store";
import type { PartDoc, AssemblyDoc, Doc } from "../types";
import { APPEARANCES } from "./materials";
import { Icon } from "./Icons";
import { loadBundle } from "./actions";
import { uid } from "../math";
import { makeSampleBracket, makeSampleAssembly, centerRect, circleAt } from "./samples";
import { PLANES } from "../math";

export function TaskPane() {
  const s = useApp(); const tab = s.taskTab; const doc = s.activeId ? s.docs[s.activeId] : null;
  const lib = Object.values(s.library).sort((a, b) => a.name.localeCompare(b.name));
  const openLib = (d: Doc) => { if (s.docs[d.id]) { s.activate(d.id); if (!s.order.includes(d.id)) useApp.setState({ order: [...s.order, d.id] }); } else loadBundle({ doc: d, deps: d.kind === "assembly" ? d.components.map(c => s.library[c.partId]).filter(Boolean) : [] }); };
  const insertIntoAsm = (p: PartDoc) => { if (doc?.kind !== "assembly") return; if (!s.docs[p.id]) s.addDoc(p, false); s.updateDoc(doc.id, (a: AssemblyDoc) => { const inst = a.components.filter(c => c.partId === p.id).length + 1; const n = a.components.length; return { ...a, components: [...a.components, { id: uid("c"), partId: p.id, name: p.name, instance: inst, t: { p: [n * 40, 0, 0], q: [0, 0, 0, 1] }, fixed: n === 0 }] }; }); };
  return <div className="taskpane">
    <div className="tp-head"><b>{({ library: "Design Library", explorer: "File Explorer", appearance: "Appearances, Scenes", config: "Custom Properties" } as any)[tab] || "Task Pane"}</b><button className="mini" onClick={() => useApp.setState({ taskPane: false })}>×</button></div>
    {tab === "library" && <div className="tp-body">
      <div className="tp-section">Templates</div>
      <div className="tp-grid">
        <button onClick={() => s.newDoc("part")}><Icon name="part" size={30} /><span>Part</span></button>
        <button onClick={() => s.newDoc("assembly")}><Icon name="assembly" size={30} /><span>Assembly</span></button>
        <button onClick={() => s.newDoc("drawing")}><Icon name="drawing" size={30} /><span>Drawing</span></button>
      </div>
      <div className="tp-section">Samples</div>
      <div className="tp-grid">
        <button onClick={() => makeSampleBracket()}><Icon name="extrude" size={30} /><span>Bracket</span></button>
        <button onClick={() => makeSampleAssembly()}><Icon name="mate" size={30} /><span>Pin assembly</span></button>
        <button onClick={() => { const p = newPart("Washer"); const sk = { id: uid("sk"), plane: PLANES.Top, planeLabel: "Top Plane", points: { O: { id: "O", x: 0, y: 0, fixed: true } }, entities: [], constraints: [] } as any; circleAt(sk, 0, 0, 24, false); const c2 = circleAt(sk, 0, 0, 13, false); sk.constraints.push({ id: uid("c"), type: "coincident", refs: ["O", c2.c] }); sk.constraints.push({ id: uid("c"), type: "concentric", refs: [sk.entities[0].id, c2.id] }); p.features = [{ id: uid("f"), type: "sketch", name: "Sketch1", params: {}, sketch: sk }, { id: uid("f"), type: "extrude", name: "Boss-Extrude1", params: { sketchId: "", end: "blind", depth: 2.5, offset: 0, dir2: { enabled: false }, draft: { angle: 0 }, thin: { enabled: false }, merge: true, contours: [] } }]; p.features[1].params.sketchId = p.features[0].id; p.counters = { sketch: 1, extrude: 1 }; p.material = "AISI 304"; p.appearance = { color: "#c3c8ce", metalness: 0.9, roughness: 0.2, opacity: 1 }; if (doc?.kind === "assembly") insertIntoAsm(p); else s.addDoc(p, true); }}><Icon name="circle" size={30} /><span>M12 washer</span></button>
        <button onClick={() => { const p = newPart("Block"); const sk = { id: uid("sk"), plane: PLANES.Front, planeLabel: "Front Plane", points: { O: { id: "O", x: 0, y: 0, fixed: true } }, entities: [], constraints: [] } as any; centerRect(sk, 40, 40); p.features = [{ id: uid("f"), type: "sketch", name: "Sketch1", params: {}, sketch: sk }]; p.features.push({ id: uid("f"), type: "extrude", name: "Boss-Extrude1", params: { sketchId: p.features[0].id, end: "midPlane", depth: 40, offset: 0, dir2: { enabled: false }, draft: { angle: 0 }, thin: { enabled: false }, merge: true, contours: [] } }); p.counters = { sketch: 1, extrude: 1 }; if (doc?.kind === "assembly") insertIntoAsm(p); else s.addDoc(p, true); }}><Icon name="part" size={30} /><span>40mm cube</span></button>
      </div>
      <div className="tp-section">Saved in browser library ({lib.length})</div>
      {lib.length === 0 && <div className="pm-note">Use File ▸ Save (Ctrl+S) to store documents here.</div>}
      {lib.map(d => <div key={d.id} className="tp-file" onDoubleClick={() => openLib(d)}>
        <Icon name={d.kind} size={18} /><span>{d.name}</span>
        {doc?.kind === "assembly" && d.kind === "part" && <button className="mini" title="Insert into assembly" onClick={() => insertIntoAsm(d as PartDoc)}>Insert</button>}
        <button className="mini" title="Open" onClick={() => openLib(d)}>Open</button>
        <button className="mini" title="Remove from library" onClick={() => confirm(`Remove “${d.name}” from the browser library?`) && s.removeFromLibrary(d.id)}>×</button>
      </div>)}
    </div>}
    {tab === "explorer" && <div className="tp-body">
      <div className="tp-section">Open Documents</div>
      {s.order.map(id => { const d = s.docs[id]; return <div key={id} className={`tp-file ${id === s.activeId ? "sel" : ""}`} onClick={() => s.activate(id)}><Icon name={d.kind} size={18} /><span>{d.name}{s.dirty[id] ? " *" : ""}</span></div>; })}
      <div className="tp-section">Loaded (referenced) Parts</div>
      {Object.values(s.docs).filter(d => !s.order.includes(d.id)).map(d => <div key={d.id} className="tp-file" onDoubleClick={() => { useApp.setState({ order: [...s.order, d.id] }); s.activate(d.id); }}><Icon name={d.kind} size={18} /><span>{d.name}</span></div>)}
      <div className="tp-section">Recent</div>
      {s.recent.map(id => s.library[id] && <div key={id} className="tp-file" onDoubleClick={() => openLib(s.library[id])}><Icon name={s.library[id].kind} size={18} /><span>{s.library[id].name}</span></div>)}
    </div>}
    {tab === "appearance" && <div className="tp-body">
      <div className="tp-section">Appearances (click to apply to the active part)</div>
      <div className="swatches">{APPEARANCES.map(a => <button key={a.name} title={a.name} onClick={() => { if (doc?.kind !== "part") return s.showToast("Open a part to apply appearances"); s.updateDoc(doc.id, (d: PartDoc) => ({ ...d, appearance: { ...d.appearance, color: a.color, metalness: a.metalness, roughness: a.roughness, opacity: a.name.includes("glass") ? 0.4 : 1 } })); }}>
        <span style={{ background: `radial-gradient(circle at 35% 30%, #fff ${a.metalness > 0.5 ? 2 : 8}%, ${a.color} 45%, #000 140%)` }} /><small>{a.name}</small></button>)}</div>
      <div className="tp-section">Scenes</div>
      <div className="tp-grid">{(["gradient", "white", "studio", "dark"] as const).map(sc => <button key={sc} className={s.display.scene === sc ? "on" : ""} onClick={() => useApp.setState({ display: { ...s.display, scene: sc } })}><span className={`scene-chip scene-${sc}`} /><span>{sc}</span></button>)}</div>
    </div>}
    {tab === "config" && <div className="tp-body">{doc?.kind === "part" ? Object.entries(doc.props).map(([k, v]) => <div key={k} className="pm-row"><label style={{ width: 90 }}>{k}</label><input value={v} onChange={e => s.updateDoc(doc.id, (d: PartDoc) => ({ ...d, props: { ...d.props, [k]: e.target.value } }))} /></div>) : <div className="pm-note">Open a part.</div>}</div>}
  </div>;
}
