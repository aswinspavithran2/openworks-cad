import { useEffect, useRef } from "react";
import { useApp, unitLabel } from "../store";
import type { MenuItem } from "./contextMenus";
import { runCommand } from "./actions";
import { Icon } from "./Icons";
import { kernelStatus } from "../kernel/client";
import { useState } from "react";

export function ContextMenu() {
  const menu = useApp(s => s.menu) as { x: number; y: number; items: MenuItem[]; toolbar?: MenuItem[] } | null;
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<[number, number]>([0, 0]);
  useEffect(() => { if (!menu) return; const el = ref.current; const w = el?.offsetWidth || 200, h = el?.offsetHeight || 300; setPos([Math.min(menu.x, window.innerWidth - w - 4), Math.min(menu.y, window.innerHeight - h - 4)]); }, [menu]);
  useEffect(() => { const f = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) useApp.setState({ menu: null }); }; window.addEventListener("mousedown", f); return () => window.removeEventListener("mousedown", f); }, []);
  if (!menu) return null;
  const run = (it: MenuItem) => { if (it.disabled || !it.action) return; useApp.setState({ menu: null }); it.action(); };
  return <div className="ctx" ref={ref} style={{ left: pos[0], top: pos[1] }} onMouseDown={e => e.stopPropagation()} onContextMenu={e => e.preventDefault()}>
    {menu.toolbar && menu.toolbar.length > 0 && <div className="ctx-toolbar">{menu.toolbar.map((t, i) => <button key={i} title={t.hint} onClick={() => run(t)}><Icon name={t.icon!} size={18} /></button>)}</div>}
    {menu.items.map((it, i) => it.sep ? <div key={i} className="dd-sep" /> : <div key={i} className={`dd-item ${it.disabled ? "disabled" : ""} ${!it.action && it.disabled ? "heading" : ""}`} onClick={() => run(it)}>
      <span className="dd-ico">{it.checked ? "✓" : it.icon ? <Icon name={it.icon} size={16} /> : null}</span><span className="dd-label">{it.label}</span></div>)}
  </div>;
}

/** "S" shortcut bar: context-sensitive mini toolbar at the cursor */
export function ShortcutBar() {
  const s = useApp(); const sb = s.shortcutBar; if (!sb) return null;
  const doc = s.activeId ? s.docs[s.activeId] : null;
  const items: [string, string][] = s.sketch ? [["line", "Line"], ["rect", "Rectangle"], ["circle", "Circle"], ["arc", "Arc"], ["slot", "Slot"], ["spline", "Spline"], ["polygon", "Polygon"], ["dimension", "Smart Dimension"], ["trim", "Trim"], ["offset", "Offset"], ["sketchMirror", "Mirror"], ["convert", "Convert"], ["relations", "Relations"], ["exitSketch", "Exit Sketch"]]
    : doc?.kind === "assembly" ? [["insertComp", "Insert Components"], ["mate", "Mate"], ["moveComp", "Move"], ["explode", "Explode"], ["interference", "Interference"], ["measure", "Measure"]]
    : [["sketch", "Sketch"], ["extrude", "Extruded Boss"], ["cut", "Extruded Cut"], ["revolve", "Revolve"], ["fillet", "Fillet"], ["chamfer", "Chamfer"], ["shell", "Shell"], ["hole", "Hole Wizard"], ["linearPattern", "Linear Pattern"], ["mirror", "Mirror"], ["plane", "Plane"], ["measure", "Measure"]];
  const x = Math.min(sb.x - 120, window.innerWidth - 300), y = Math.min(sb.y - 20, window.innerHeight - 110);
  return <div className="shortcut-bar" style={{ left: Math.max(4, x), top: Math.max(4, y) }} onMouseLeave={() => useApp.setState({ shortcutBar: null })}>
    {items.map(([c, l]) => <button key={c} title={l} onClick={() => { useApp.setState({ shortcutBar: null }); runCommand(c); }}><Icon name={c === "relations" ? "relations" : c} size={20} /></button>)}
  </div>;
}

export function Toast() {
  const t = useApp(s => s.toast); if (!t) return null;
  return <div className={`toast ${t.msg.startsWith("⚠") || /fail|cannot|error|invalid/i.test(t.msg) ? "warn" : ""}`} key={t.seq}>{t.msg}</div>;
}

export function KernelBadge() {
  const [, set] = useState(0);
  useEffect(() => { const f = () => set(x => x + 1); kernelStatus.listeners.add(f); return () => { kernelStatus.listeners.delete(f); }; }, []);
  return <span className={`kbadge ${kernelStatus.ready ? "ok" : ""}`} title="OpenCascade geometry kernel (WebAssembly)">{kernelStatus.ready ? "● OCCT ready" : "◌ Loading kernel…"}</span>;
}
export { unitLabel };
