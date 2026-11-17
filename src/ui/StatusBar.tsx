import { useApp, unitLabel } from "../store";
import { KernelBadge } from "./Overlays";
import type { UnitSystem } from "../types";

export function StatusBar() {
  const s = useApp(); const doc = s.activeId ? s.docs[s.activeId] : null;
  const ss = s.sketch; const solve = ss?.solve;
  const skStatus = ss ? (solve?.status === "over" ? "Over Defined" : solve?.status === "full" ? "Fully Defined" : "Under Defined") : "";
  const b = doc ? s.builds[doc.id] : undefined; const nErr = b ? Object.keys(b.errors || {}).length : 0;
  return <div className="statusbar">
    <span className="sb-msg">{s.status}</span>
    <span className="sb-flex" />
    {s.building && <span className="sb-item">⟳ Rebuilding…</span>}
    {b && !s.building && <span className="sb-item muted">Rebuild {Math.round(b.time)} ms</span>}
    {nErr > 0 && <span className="sb-item err" title="Features with rebuild errors">✖ {nErr} error{nErr > 1 ? "s" : ""}</span>}
    {ss && <span className={`sb-item sk-${solve?.status}`}>{skStatus}{solve?.status === "under" ? ` (${solve.dof} DOF)` : ""}</span>}
    {ss && <span className="sb-item">Editing: {ss.name}</span>}
    {doc && doc.kind === "part" && <span className="sb-item">{(doc.configs.find(c => c.id === doc.activeConfig)?.name) || "Default"}</span>}
    {s.selection.length > 0 && <span className="sb-item">{s.selection.length} selected</span>}
    {doc && <select className="sb-units" value={doc.units} title="Unit system" onChange={e => s.updateDoc(doc.id, d => ({ ...d, units: e.target.value as UnitSystem }))}>
      <option value="MMGS">MMGS (mm, g, s)</option><option value="CGS">CGS (cm, g, s)</option><option value="MKS">MKS (m, kg, s)</option><option value="IPS">IPS (in, lb, s)</option>
    </select>}
    <KernelBadge />
    <span className="sb-item muted">{doc ? unitLabel(doc.units) : ""}</span>
  </div>;
}
