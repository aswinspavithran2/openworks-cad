import { useState } from "react";
import { useApp } from "../store";
import { runCommand } from "./actions";
import { Icon } from "./Icons";

export function HeadsUp() {
  const s = useApp(); const [fly, setFly] = useState<string | null>(null);
  if (!s.activeId) return null;
  const F = (id: string, items: [string, string, () => void, boolean?][]) => fly === id && <div className="hu-fly" onMouseLeave={() => setFly(null)}>{items.map(([ic, label, fn, on]) => <button key={label} title={label} className={on ? "on" : ""} onClick={() => { fn(); setFly(null); }}><Icon name={ic} size={18} /><span>{label}</span></button>)}</div>;
  const d = s.display;
  return <div className="headsup" onPointerDown={e => e.stopPropagation()}>
    <button title="Zoom to Fit (F)" onClick={() => runCommand("zoomFit")}><Icon name="zoomFit" size={18} /></button>
    <button title="Zoom to Area" className={s.cursor === "zoomArea" ? "on" : ""} onClick={() => runCommand("zoomArea")}><Icon name="zoomArea" size={18} /></button>
    <button title="Previous View" onClick={() => runCommand("prevView")}><Icon name="prevView" size={18} /></button>
    <button title="Section View" className={d.section.on ? "on" : ""} onClick={() => runCommand("section")}><Icon name="section" size={18} /></button>
    <span className="hu-sep" />
    <div className="hu-wrap"><button title="View Orientation (Space)" onClick={() => setFly(fly === "orient" ? null : "orient")}><Icon name="viewOrient" size={18} />▾</button>
      {F("orient", [["viewOrient", "Front", () => s.cmd("front")], ["viewOrient", "Back", () => s.cmd("back")], ["viewOrient", "Left", () => s.cmd("left")], ["viewOrient", "Right", () => s.cmd("right")], ["viewOrient", "Top", () => s.cmd("top")], ["viewOrient", "Bottom", () => s.cmd("bottom")], ["viewOrient", "Isometric", () => s.cmd("iso")], ["viewOrient", "Trimetric", () => s.cmd("trimetric")], ["viewOrient", "Dimetric", () => s.cmd("dimetric")], ["normalTo", "Normal To", () => runCommand("normalTo")]])}</div>
    <div className="hu-wrap"><button title="Display Style" onClick={() => setFly(fly === "style" ? null : "style")}><Icon name="displayStyle" size={18} />▾</button>
      {F("style", [["displayStyle", "Shaded With Edges", () => runCommand("style", "shadedEdges"), d.style === "shadedEdges"], ["displayStyle", "Shaded", () => runCommand("style", "shaded"), d.style === "shaded"], ["displayStyle", "Hidden Lines Removed", () => runCommand("style", "hlr"), d.style === "hlr"], ["displayStyle", "Hidden Lines Visible", () => runCommand("style", "hlv"), d.style === "hlv"], ["displayStyle", "Wireframe", () => runCommand("style", "wire"), d.style === "wire"]])}</div>
    <div className="hu-wrap"><button title="Hide/Show Items" onClick={() => setFly(fly === "hide" ? null : "hide")}><Icon name="hideShow" size={18} />▾</button>
      {F("hide", [["plane", "Planes", () => runCommand("toggle", "planes"), d.planes], ["origin", "Origins", () => runCommand("toggle", "origins"), d.origins], ["axis", "Axes", () => runCommand("toggle", "axes"), d.axes], ["sketch", "Sketches", () => runCommand("toggle", "sketches"), d.sketches], ["rect", "Grid", () => runCommand("toggle", "grid"), d.grid], ["viewOrient", "View Triad", () => runCommand("toggle", "triad"), d.triad]])}</div>
    <div className="hu-wrap"><button title="Edit Appearance" onClick={() => runCommand("appearance")}><Icon name="appearance" size={18} /></button></div>
    <div className="hu-wrap"><button title="Apply Scene" onClick={() => setFly(fly === "scene" ? null : "scene")}><Icon name="scene" size={18} />▾</button>
      {F("scene", [["scene", "Gradient (default)", () => runCommand("scene", "gradient"), d.scene === "gradient"], ["scene", "Plain White", () => runCommand("scene", "white"), d.scene === "white"], ["scene", "Studio", () => runCommand("scene", "studio"), d.scene === "studio"], ["scene", "Dark", () => runCommand("scene", "dark"), d.scene === "dark"]])}</div>
    <span className="hu-sep" />
    <div className="hu-wrap"><button title="Selection Filter" className={s.selFilter ? "on" : ""} onClick={() => setFly(fly === "filter" ? null : "filter")}><Icon name="smartSel" size={18} />▾</button>
      {F("filter", [["smartSel", "No filter", () => useApp.setState({ selFilter: null }), !s.selFilter], ["shell", "Faces", () => runCommand("filter", "faces"), s.selFilter === "faces"], ["fillet", "Edges", () => runCommand("filter", "edges"), s.selFilter === "edges"], ["point", "Vertices", () => runCommand("filter", "vertices"), s.selFilter === "vertices"]])}</div>
  </div>;
}
