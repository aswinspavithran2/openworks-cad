import { useState } from "react";
import { useApp } from "../store";
import { runCommand } from "./actions";
import { Icon } from "./Icons";

type Btn = { id: string; label: string; icon: string; arg?: any; big?: boolean; modes?: { label: string; arg: string; icon?: string }[]; stack?: Btn[]; tip?: string; drawing?: boolean };
const B = (id: string, label: string, icon = id, extra: Partial<Btn> = {}): Btn => ({ id, label, icon, ...extra });
const D = (id: string, label: string, icon = id): Btn => ({ id, label, icon, drawing: true });

const TABS: Record<string, Record<string, (Btn | "|")[]>> = {
  part: {
    Features: [
      B("extrude", "Extruded Boss/Base", "extrude", { big: true }), B("revolve", "Revolved Boss/Base", "revolve", { big: true }),
      { id: "_s1", label: "", icon: "", stack: [B("sweep", "Swept Boss/Base"), B("loft", "Lofted Boss/Base")] }, "|",
      B("cut", "Extruded Cut", "cut", { big: true }), B("hole", "Hole Wizard", "hole", { big: true }), B("revolveCut", "Revolved Cut", "revolveCut", { big: true }),
      { id: "_s2", label: "", icon: "", stack: [B("sweepCut", "Swept Cut"), B("loftCut", "Lofted Cut")] }, "|",
      B("fillet", "Fillet", "fillet", { big: true }), B("linearPattern", "Linear Pattern", "linearPattern", { big: true }),
      { id: "_s3", label: "", icon: "", stack: [B("circularPattern", "Circular Pattern"), B("mirror", "Mirror")] },
      { id: "_s4", label: "", icon: "", stack: [B("chamfer", "Chamfer"), B("draft", "Draft"), B("shell", "Shell")] }, "|",
      B("plane", "Reference Geometry", "plane", { big: true, modes: [{ label: "Plane", arg: "plane", icon: "plane" }, { label: "Axis", arg: "axis", icon: "axis" }] }), "|",
      B("material", "Edit Material", "material", { big: true }), B("appearance", "Appearance", "appearance", { big: true }),
    ],
    Sketch: [
      B("sketch", "Sketch", "sketch", { big: true }), B("exitSketch", "Exit Sketch", "exitSketch", { big: true }), B("dimension", "Smart Dimension", "dimension", { big: true }), "|",
      { id: "_l", label: "", icon: "", stack: [B("line", "Line", "line", { modes: [{ label: "Line", arg: "", icon: "line" }, { label: "Centerline", arg: "centerline", icon: "centerline" }] }), B("rect", "Rectangle", "rect", { modes: [{ label: "Corner Rectangle", arg: "corner" }, { label: "Center Rectangle", arg: "center" }, { label: "3 Point Corner Rectangle", arg: "3corner" }, { label: "3 Point Center Rectangle", arg: "3center" }, { label: "Parallelogram", arg: "parallelogram" }] }), B("slot", "Slot", "slot", { modes: [{ label: "Straight Slot", arg: "straight" }, { label: "Centerpoint Straight Slot", arg: "center" }] })] },
      { id: "_c", label: "", icon: "", stack: [B("circle", "Circle", "circle", { modes: [{ label: "Circle", arg: "center" }, { label: "Perimeter Circle", arg: "perimeter" }] }), B("arc", "Arc", "arc", { modes: [{ label: "Centerpoint Arc", arg: "center" }, { label: "Tangent Arc", arg: "tangent", icon: "tangentArc" }, { label: "3 Point Arc", arg: "3point", icon: "threePtArc" }] }), B("polygon", "Polygon")] },
      { id: "_sp", label: "", icon: "", stack: [B("spline", "Spline"), B("ellipse", "Ellipse"), B("point", "Point")] }, "|",
      B("trim", "Trim Entities", "trim", { big: true }), B("convert", "Convert Entities", "convert", { big: true }), B("offset", "Offset Entities", "offset", { big: true }),
      { id: "_m", label: "", icon: "", stack: [B("sketchMirror", "Mirror Entities"), B("sketchLinear", "Linear Sketch Pattern", "linearPattern"), B("move", "Move Entities", "move", { modes: [{ label: "Move", arg: "move" }, { label: "Copy", arg: "copyEnt" }, { label: "Rotate", arg: "rotate" }, { label: "Scale", arg: "scale" }] })] }, "|",
      { id: "_r", label: "", icon: "", stack: [B("extend", "Extend Entities"), B("relations", "Display/Delete Relations"), B("construction", "Construction Geometry")] },
    ],
    Evaluate: [B("measure", "Measure", "measure", { big: true }), B("massProps", "Mass Properties", "massProps", { big: true }), B("check", "Check", "check", { big: true }), B("section", "Section View", "section", { big: true }), "|", B("equations", "Equations", "equations", { big: true }), B("designTable", "Design Table", "designTable", { big: true })],
  },
  assembly: {
    Assembly: [B("insertComp", "Insert Components", "insertComp", { big: true }), B("mate", "Mate", "mate", { big: true }), B("linearCompPattern", "Linear Component Pattern", "linearPattern", { big: true }), B("mirrorComp", "Mirror Components", "mirror", { big: true }), "|", B("moveComp", "Move Component", "move", { big: true }), B("rotateComp", "Rotate Component", "rotate", { big: true }), "|", B("explode", "Exploded View", "explode", { big: true }), B("toggleExplode", "Explode / Collapse", "explode", { big: true }), "|", B("interference", "Interference Detection", "interference", { big: true })],
    Evaluate: [B("measure", "Measure", "measure", { big: true }), B("massProps", "Mass Properties", "massProps", { big: true }), B("interference", "Interference Detection", "interference", { big: true }), B("asmStats", "Assembly Statistics", "stats", { big: true }), B("section", "Section View", "section", { big: true })],
  },
  drawing: {
    "View Layout": [D("std3", "Standard 3 View"), D("modelView", "Model View"), D("projView", "Projected View"), D("sectionView", "Section View"), D("detailView", "Detail View"), "|", D("sheetProps", "Sheet Format", "config")],
    Annotation: [D("smartDim", "Smart Dimension", "dimension"), D("autoDim", "Model Items", "dimension"), "|", D("note", "Note"), D("balloon", "Balloon"), D("autoBalloon", "Auto Balloon", "balloon"), D("surface", "Surface Finish"), D("gtol", "Geometric Tolerance"), D("datum", "Datum Feature"), D("centerMark", "Center Mark"), "|", D("bom", "Bill of Materials")],
  },
};

export function CommandManager() {
  const s = useApp(); const doc = s.activeId ? s.docs[s.activeId] : null; const kind = doc?.kind || "part";
  const tabs = TABS[kind]; const tabNames = Object.keys(tabs);
  const tab = tabNames.includes(s.cmTab) ? s.cmTab : tabNames[0];
  const [flyout, setFlyout] = useState<string | null>(null);
  const activeTool = s.sketch ? (s.sketch.tool === "select" ? s.sketch.mode : s.sketch.tool === "centerline" ? "line" : s.sketch.tool) : s.pm?.type;
  const click = (b: Btn, arg?: any) => {
    setFlyout(null);
    if (b.drawing) return window.dispatchEvent(new CustomEvent("cad:drawCmd", { detail: arg ?? b.id }));
    if (b.id === "line" && arg === "centerline") return runCommand("centerline");
    if ((b.id === "plane") && arg) return runCommand(arg);
    if (b.id === "move" && arg) return runCommand(arg);
    runCommand(b.id, arg);
  };
  const render = (b: Btn, small = false) => {
    const disabled = !doc || (kind === "part" && ["exitSketch", "trim", "convert", "offset", "sketchMirror", "sketchLinear", "move", "extend", "relations", "construction"].includes(b.id) && !s.sketch);
    return <div key={b.id} className={`cm-btn ${small ? "small" : "big"} ${activeTool === b.id ? "active" : ""} ${disabled ? "disabled" : ""}`} title={b.tip || b.label}>
      <button onClick={() => !disabled && click(b)}><Icon name={b.icon} size={small ? 18 : 30} /><span>{b.label}</span></button>
      {b.modes && <button className="cm-more" onClick={e => { e.stopPropagation(); setFlyout(flyout === b.id ? null : b.id); }}>▾</button>}
      {flyout === b.id && b.modes && <div className="dropdown cm-fly" onMouseLeave={() => setFlyout(null)}>{b.modes.map(m => <div key={m.arg} className="dd-item" onClick={() => click(b, m.arg)}><span className="dd-ico"><Icon name={m.icon || b.icon} size={16} /></span><span className="dd-label">{m.label}</span></div>)}</div>}
    </div>;
  };
  return (
    <div className="cmdmgr">
      <div className="cm-body">
        {tabs[tab].map((b, i) => b === "|" ? <div key={i} className="cm-sep" /> : b.stack ? <div key={b.id} className="cm-stack">{b.stack.map(x => render(x, true))}</div> : render(b))}
      </div>
      <div className="cm-tabs">
        {tabNames.map(t => <button key={t} className={t === tab ? "active" : ""} onClick={() => useApp.setState({ cmTab: t })}>{t}</button>)}
        {kind === "part" && s.sketch && <span className="cm-sketch-badge">Editing {s.sketch.name}</span>}
      </div>
    </div>
  );
}
