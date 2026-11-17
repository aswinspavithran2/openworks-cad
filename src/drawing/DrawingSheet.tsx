import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useApp, effectiveFeatures } from "../store";
import type { DrawingDoc, DrawView, DrawAnno, DrawViewOrient, PartDoc, AssemblyDoc, Vec2, Vec3, Doc } from "../types";
import { kernel } from "../kernel/client";
import { uid, fmt, cross, norm, add, mul } from "../math";
import { download } from "../ui/actions";
import { MATERIALS } from "../ui/materials";
import { Icon } from "../ui/Icons";

const st = () => useApp.getState();
export const SHEETS: Record<string, [number, number]> = { A4: [297, 210], A3: [420, 297], A2: [594, 420], A1: [841, 594], A0: [1189, 841], Letter: [279.4, 215.9] };
const ORIENT: Record<DrawViewOrient, { dir: Vec3; x: Vec3; label: string }> = {
  front: { dir: [0, 0, 1], x: [1, 0, 0], label: "Front" }, back: { dir: [0, 0, -1], x: [-1, 0, 0], label: "Back" },
  top: { dir: [0, 1, 0], x: [1, 0, 0], label: "Top" }, bottom: { dir: [0, -1, 0], x: [1, 0, 0], label: "Bottom" },
  right: { dir: [1, 0, 0], x: [0, 0, -1], label: "Right" }, left: { dir: [-1, 0, 0], x: [0, 0, 1], label: "Left" },
  iso: { dir: norm([1, 1, 1]), x: norm([1, 0, -1]), label: "Isometric" },
};
const STD_SCALES = [10, 5, 4, 2, 1.5, 1, 0.5, 0.4, 0.25, 0.2, 0.1, 0.05, 0.02, 0.01];
const scaleLabel = (s: number) => s >= 1 ? `${fmt(s)}:1` : `1:${fmt(1 / s)}`;
type Proj = { visible: string[]; hidden: string[]; hatch?: string; bbox: number[] | null; error?: string };

/** camera data for a view (section views use their own cutting plane) */
function viewCamera(d: DrawingDoc, v: DrawView): { dir: Vec3; xAxis: Vec3; section?: any } {
  if (v.type === "section" && v.parent && v.section) {
    const par = d.views.find(x => x.id === v.parent); if (!par) return { dir: ORIENT.front.dir, xAxis: ORIENT.front.x };
    const pc = ORIENT[par.orient]; const yAx = cross(pc.dir, pc.x);
    const P = (q: Vec2): Vec3 => add(mul(pc.x, q[0]), mul(yAx, -q[1]));
    const A = P(v.section.a), B = P(v.section.b); const ld = norm([B[0] - A[0], B[1] - A[1], B[2] - A[2]]);
    let n = norm(cross(ld, pc.dir)); if (v.flip) n = mul(n, -1);
    return { dir: mul(n, -1), xAxis: v.flip ? mul(ld, -1) : ld, section: { origin: A, x: ld, n } };
  }
  const o = ORIENT[v.orient] || ORIENT.front; return { dir: o.dir, xAxis: o.x };
}
function sourcePayload(src: Doc | null): any | null {
  const s = st(); if (!src) return null;
  if (src.kind === "part") return { features: effectiveFeatures(src) };
  if (src.kind === "assembly") return { assembly: src.components.filter(c => !c.hidden && s.docs[c.partId]).map(c => ({ features: effectiveFeatures(s.docs[c.partId] as PartDoc), t: c.t })) };
  return null;
}
/** endpoints of path segments (for dimension snapping & DXF) */
function pathPolylines(d: string): Vec2[][] {
  const out: Vec2[][] = []; let cur: Vec2[] = []; const tok = d.match(/[MLAZCQmlazcq]|-?\d*\.?\d+(?:e[-+]?\d+)?/g) || []; let i = 0; let cmd = ""; let last: Vec2 = [0, 0];
  const num = () => parseFloat(tok[i++]);
  while (i < tok.length) {
    if (/[A-Za-z]/.test(tok[i])) cmd = tok[i++];
    if (cmd === "M") { if (cur.length > 1) out.push(cur); last = [num(), num()]; cur = [last]; cmd = "L"; }
    else if (cmd === "L") { last = [num(), num()]; cur.push(last); }
    else if (cmd === "A") { const rx = num(), ry = num(); num(); const large = num(), sweep = num(); const e: Vec2 = [num(), num()]; cur.push(...arcPts(last, e, rx, ry, large, sweep)); last = e; }
    else if (cmd === "C") { const c1: Vec2 = [num(), num()], c2: Vec2 = [num(), num()], e: Vec2 = [num(), num()]; for (let k = 1; k <= 8; k++) { const t = k / 8, u = 1 - t; cur.push([u * u * u * last[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * e[0], u * u * u * last[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * e[1]]); } last = e; }
    else if (cmd === "Q") { const c1: Vec2 = [num(), num()], e: Vec2 = [num(), num()]; for (let k = 1; k <= 6; k++) { const t = k / 6, u = 1 - t; cur.push([u * u * last[0] + 2 * u * t * c1[0] + t * t * e[0], u * u * last[1] + 2 * u * t * c1[1] + t * t * e[1]]); } last = e; }
    else if (cmd === "Z" || cmd === "z") { if (cur.length) cur.push(cur[0]); cmd = ""; }
    else i++;
  }
  if (cur.length > 1) out.push(cur); return out;
}
function arcPts(a: Vec2, b: Vec2, rx: number, _ry: number, large: number, sweep: number): Vec2[] {
  const dx = (b[0] - a[0]) / 2, dy = (b[1] - a[1]) / 2; const d = Math.hypot(dx, dy); if (d < 1e-9) return [b]; const r = Math.max(rx, d);
  const h = Math.sqrt(Math.max(0, r * r - d * d)); const sgn = (large === sweep) ? -1 : 1; const mx = a[0] + dx, my = a[1] + dy;
  const cx = mx + sgn * h * (-dy / d), cy = my + sgn * h * (dx / d);
  let a1 = Math.atan2(a[1] - cy, a[0] - cx), a2 = Math.atan2(b[1] - cy, b[0] - cx); let sw = a2 - a1;
  if (sweep && sw < 0) sw += 2 * Math.PI; if (!sweep && sw > 0) sw -= 2 * Math.PI;
  const n = Math.max(4, Math.ceil(Math.abs(sw) / 0.2)); return Array.from({ length: n }, (_, k) => [cx + r * Math.cos(a1 + sw * (k + 1) / n), cy + r * Math.sin(a1 + sw * (k + 1) / n)] as Vec2);
}

export function DrawingSheet() {
  const s = useApp(); const doc = s.docs[s.activeId!] as DrawingDoc; const src = doc.sourceId ? s.docs[doc.sourceId] : null;
  const [W, H] = SHEETS[doc.sheet] || SHEETS.A3;
  const svgRef = useRef<SVGSVGElement>(null);
  const [vb, setVb] = useState<[number, number, number, number]>([-10, -10, W + 20, H + 20]);
  const [proj, setProj] = useState<Record<string, Proj>>({});
  const [busy, setBusy] = useState(false);
  const [sel, setSel] = useState<string | null>(null);
  const [tool, setTool] = useState<string | null>(null);
  const [pts, setPts] = useState<Vec2[]>([]);
  const [mouse, setMouse] = useState<Vec2>([0, 0]);
  const [placing, setPlacing] = useState<{ orient: DrawViewOrient } | null>(null);
  const [pickSrc, setPickSrc] = useState<null | "std3" | "model">(null);
  const upd = (fn: (d: DrawingDoc) => DrawingDoc, rec = true) => s.updateDoc(doc.id, fn, rec);
  useEffect(() => setVb([-10, -10, W + 20, H + 20]), [doc.sheet]);

  // ── projections (recompute when model or view cameras change)
  const srcKey = useMemo(() => JSON.stringify(sourcePayload(src)), [src, s.docs]);
  const camKey = JSON.stringify(doc.views.filter(v => v.type !== "detail").map(v => [v.id, viewCamera(doc, v), v.hidden ?? true]));
  useEffect(() => {
    const payload = sourcePayload(src); if (!payload || !doc.views.length) { setProj({}); return; }
    let cancel = false; setBusy(true);
    const views = doc.views.filter(v => v.type !== "detail").map(v => { const c = viewCamera(doc, v); return { id: v.id, dir: c.dir, xAxis: c.xAxis, section: c.section, hidden: v.orient !== "iso" && v.hidden !== false }; });
    const t = setTimeout(() => kernel.project({ ...payload, views }).then(r => { if (!cancel) setProj(r as any); }).catch(e => st().showToast("Projection failed: " + e.message)).finally(() => !cancel && setBusy(false)), 150);
    return () => { cancel = true; clearTimeout(t); };
  }, [srcKey, camKey]);

  // ── coordinate helpers
  const toSheet = (cx: number, cy: number): Vec2 => { const svg = svgRef.current!; const p = svg.createSVGPoint(); p.x = cx; p.y = cy; const m = svg.getScreenCTM()!.inverse(); const r = p.matrixTransform(m); return [r.x, r.y]; };
  const bboxOf = (v: DrawView): number[] | null => v.type === "detail" ? (v.detail ? [v.detail.c[0] - v.detail.r, v.detail.c[1] - v.detail.r, v.detail.c[0] + v.detail.r, v.detail.c[1] + v.detail.r] : null) : proj[v.id]?.bbox || null;
  const ctr = (b: number[]) => [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
  /** model-projected coords (of a view) → sheet mm */
  const v2s = (v: DrawView, q: Vec2): Vec2 => { const b = bboxOf(v); if (!b) return [v.x, v.y]; const c = ctr(b); return [v.x + (q[0] - c[0]) * v.scale, v.y + (q[1] - c[1]) * v.scale]; };
  const s2v = (v: DrawView, p: Vec2): Vec2 => { const b = bboxOf(v); if (!b) return [0, 0]; const c = ctr(b); return [(p[0] - v.x) / v.scale + c[0], (p[1] - v.y) / v.scale + c[1]]; };
  const viewAt = (p: Vec2) => [...doc.views].reverse().find(v => { const b = bboxOf(v); if (!b) return Math.hypot(p[0] - v.x, p[1] - v.y) < 15; const hw = (b[2] - b[0]) / 2 * v.scale + 4, hh = (b[3] - b[1]) / 2 * v.scale + 4; return Math.abs(p[0] - v.x) < hw && Math.abs(p[1] - v.y) < hh; });
  const snapPts = useMemo(() => { const out: Vec2[] = []; for (const v of doc.views) { const pr = v.type === "detail" ? proj[v.parent || ""] : proj[v.id]; if (!pr || v.type === "detail") continue; for (const d of pr.visible) for (const pl of pathPolylines(d)) { out.push(v2s(v, pl[0]), v2s(v, pl[pl.length - 1])); if (pl.length > 6) { const xs = pl.map(p => p[0]), ys = pl.map(p => p[1]); const c: Vec2 = [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2]; out.push(v2s(v, c)); } } } return out; }, [proj, doc.views]);
  const snap = (p: Vec2): Vec2 => { let best: Vec2 = p, bd = 3 * (vb[2] / 800); for (const q of snapPts) { const d = Math.hypot(q[0] - p[0], q[1] - p[1]); if (d < bd) { bd = d; best = q; } } return best; };

  // ── commands from CommandManager
  useEffect(() => {
    const onCmd = (e: Event) => {
      const c = (e as CustomEvent).detail as string; setPts([]);
      if (c === "std3") { if (!src) { setPickSrc("std3"); return; } return addStd3(); }
      if (c === "modelView") { setPickSrc("model"); return; }
      if (c === "projView" || c === "sectionView" || c === "detailView") { const v = doc.views.find(x => x.id === sel); if (!v || v.type === "detail") { st().showToast("Select a parent view first (click a view), then choose the command"); return; } setTool(c); st().setStatus(c === "projView" ? "Move the cursor around the parent view and click to place the projected view" : c === "sectionView" ? "Click two points across the parent view to define the cutting line" : "Click the center of the detail circle, then its radius"); return; }
      if (c === "sheetProps") { st().set({ dialog: { name: "properties" } }); return; }
      if (c === "autoDim") return autoDims();
      if (c === "bom") { setTool("bom"); st().setStatus("Click to place the Bill of Materials"); return; }
      if (c === "autoBalloon") return autoBalloons();
      setTool(c); st().setStatus(({ smartDim: "Smart Dimension: click two points (snaps to geometry ends/centers), then click to place", note: "Click to place a note", balloon: "Click on a part edge (leader start), then click to place the balloon", surface: "Click to place a surface finish symbol", gtol: "Click to place a geometric tolerance frame", datum: "Click to place a datum feature symbol", centerMark: "Click a hole center to add a center mark" } as any)[c] || "");
    };
    const onExp = (e: Event) => exportDrawing((e as CustomEvent).detail);
    const onDel = () => { if (!sel) return; upd(d => ({ ...d, views: d.views.filter(v => v.id !== sel && v.parent !== sel), annos: d.annos.filter(a => a.id !== sel && a.view !== sel) })); setSel(null); };
    const onSel = (e: Event) => setSel((e as CustomEvent).detail);
    window.addEventListener("cad:drawCmd", onCmd); window.addEventListener("cad:drawingExport", onExp); window.addEventListener("cad:drawingDelete", onDel); window.addEventListener("cad:drawSelect", onSel);
    return () => { window.removeEventListener("cad:drawCmd", onCmd); window.removeEventListener("cad:drawingExport", onExp); window.removeEventListener("cad:drawingDelete", onDel); window.removeEventListener("cad:drawSelect", onSel); };
  });
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === "Escape") { setTool(null); setPts([]); setPlacing(null); setPickSrc(null); } }; window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k); }, []);

  const GAP = 20; // paper mm between the standard views
  const srcBox = (srcDoc: Doc | null): [Vec3, Vec3] | null => { const s0 = st(); let bb: [Vec3, Vec3] | null = null;
    const grow = (b: [Vec3, Vec3] | null | undefined, off: Vec3 = [0, 0, 0]) => { if (!b) return; const lo = add(b[0], off), hi = add(b[1], off);
      bb = bb ? [[Math.min(bb[0][0], lo[0]), Math.min(bb[0][1], lo[1]), Math.min(bb[0][2], lo[2])], [Math.max(bb[1][0], hi[0]), Math.max(bb[1][1], hi[1]), Math.max(bb[1][2], hi[2])]] : [lo, hi]; };
    if (srcDoc?.kind === "part") grow(s0.builds[srcDoc.id]?.main?.bbox);
    if (srcDoc?.kind === "assembly") srcDoc.components.forEach(c => { const b = s0.builds[c.partId]?.main?.bbox; if (!b) return; const r = Math.max(...[0, 1, 2].map(i => Math.abs(b[0][i]) + Math.abs(b[1][i]))) ; grow([[-r, -r, -r], [r, r, r]], c.t.p); });
    return bb; };
  /** area for the 3-view block: left of the iso view, above the title block band */
  const blockArea = () => ({ x0: 22, x1: W * 0.64, y0: 22, y1: H - 22 });
  const fitScale = (srcDoc: Doc | null) => { const b = srcBox(srcDoc); if (!b) return 1;
    const dx = b[1][0] - b[0][0], dy = b[1][1] - b[0][1], dz = b[1][2] - b[0][2]; const A = blockArea();
    const sc = Math.min((A.x1 - A.x0 - GAP) / (dx + dz || 1), (A.y1 - A.y0 - GAP) / (dy + dz || 1)) * 0.92;
    return STD_SCALES.find(x => x <= sc) ?? 0.01; };
  function addStd3(srcId?: string) {
    const sid = srcId || doc.sourceId; const sd = sid ? st().docs[sid] : null; if (!sd) return;
    const sc = fitScale(sd); const bx = srcBox(sd); const first = doc.projection === "first";
    const dx = bx ? (bx[1][0] - bx[0][0]) * sc : 60, dy = bx ? (bx[1][1] - bx[0][1]) * sc : 60, dz = bx ? (bx[1][2] - bx[0][2]) * sc : 60;
    // centre the [front | side] × [top / front] block in its area
    const A = blockArea(); const bw = dx + GAP + dz, bh = dy + GAP + dz; const ox = (A.x0 + A.x1 - bw) / 2, oy = (A.y0 + A.y1 - bh) / 2;
    const fx = first ? ox + dz + GAP + dx / 2 : ox + dx / 2; const fy = first ? oy + dy / 2 : oy + dz + GAP + dy / 2; const sp = GAP;
    const f: DrawView = { id: uid("v"), type: "model", label: "Drawing View1", orient: "front", x: fx, y: fy, scale: sc, style: "hlr" };
    const t: DrawView = { id: uid("v"), type: "projected", label: "Drawing View2", orient: "top", parent: f.id, x: fx, y: first ? fy + dy / 2 + dz / 2 + sp : fy - dy / 2 - dz / 2 - sp, scale: sc, style: "hlr" };
    const r: DrawView = { id: uid("v"), type: "projected", label: "Drawing View3", orient: "right", parent: f.id, x: first ? fx - dx / 2 - dz / 2 - sp : fx + dx / 2 + dz / 2 + sp, y: fy, scale: sc, style: "hlr" };
    const iso: DrawView = { id: uid("v"), type: "model", label: "Drawing View4", orient: "iso", x: W * 0.81, y: H * 0.36, scale: sc * 0.8, style: "hlr", hidden: false };
    upd(d => ({ ...d, sourceId: sid!, scale: sc, views: [...d.views, f, t, r, iso], title: { ...d.title, title: d.title.title === d.name ? sd.name : d.title.title, partNo: d.title.partNo || sd.name, material: (sd as PartDoc).material || d.title.material } }));
    setPickSrc(null); st().setStatus(`Standard 3 View of ${sd.name} at ${scaleLabel(sc)}`);
  }
  function autoDims() {
    const add: DrawAnno[] = [];
    for (const v of doc.views) { if ((v.type !== "model" && v.type !== "projected") || v.orient === "iso") continue; const b = bboxOf(v); if (!b) continue;
      const A = v2s(v, [b[0], b[3]]), B = v2s(v, [b[2], b[3]]), C = v2s(v, [b[2], b[1]]);
      if (v.orient !== "top" || !doc.views.some(x => x.orient === "front")) add.push({ id: uid("a"), type: "dim", kind: "h", a: A, b: B, pos: [(A[0] + B[0]) / 2, A[1] + 10], value: (b[2] - b[0]), view: v.id });
      add.push({ id: uid("a"), type: "dim", kind: "v", a: B, b: C, pos: [B[0] + 10, (B[1] + C[1]) / 2], value: (b[3] - b[1]), view: v.id });
    }
    if (!add.length) return st().showToast("Add drawing views first");
    upd(d => ({ ...d, annos: [...d.annos, ...add] })); st().setStatus(`Inserted ${add.length} model dimensions`);
  }
  function autoBalloons() {
    const v = doc.views.find(x => x.orient === "iso") || doc.views[0]; if (!v || !src) return; const b = bboxOf(v); if (!b) return;
    const items = bomRows(src); const add: DrawAnno[] = items.map((it, i) => { const ang = -Math.PI / 4 + i * 0.6; const a = v2s(v, [ctr(b)[0] + (b[2] - b[0]) * 0.15 * Math.cos(ang), ctr(b)[1] + (b[3] - b[1]) * 0.15 * Math.sin(ang)]); return { id: uid("a"), type: "balloon", a, pos: [a[0] + 25 * Math.cos(ang), a[1] + 25 * Math.sin(ang)], text: String(it.item), view: v.id }; });
    upd(d => ({ ...d, annos: [...d.annos, ...add] }));
  }

  // ── pointer handling
  const drag = useRef<{ kind: "view" | "anno" | "pan"; id?: string; start: Vec2; orig: any; moved: boolean; cx: number; cy: number } | null>(null);
  const dragBase = useRef<DrawingDoc | null>(null);
  const onDown = (e: React.PointerEvent) => {
    const p = toSheet(e.clientX, e.clientY); dragBase.current = doc;
    if (e.button === 1 || e.button === 2 || (e.button === 0 && e.altKey)) { drag.current = { kind: "pan", start: p, orig: vb, moved: false, cx: e.clientX, cy: e.clientY }; (e.target as Element).setPointerCapture?.(e.pointerId); return; }
    if (e.button !== 0) return;
    if (placing) { const v: DrawView = { id: uid("v"), type: "model", label: `Drawing View${doc.views.length + 1}`, orient: placing.orient, x: p[0], y: p[1], scale: doc.scale, style: "hlr", hidden: placing.orient !== "iso" }; upd(d => ({ ...d, views: [...d.views, v] })); setPlacing(null); setSel(v.id); return; }
    if (tool) return toolClick(p, e);
    const annoEl = (e.target as Element).closest("[data-anno]"); if (annoEl) { const id = annoEl.getAttribute("data-anno")!; setSel(id); const a = doc.annos.find(x => x.id === id)!; drag.current = { kind: "anno", id, start: p, orig: a.pos, moved: false, cx: e.clientX, cy: e.clientY }; (e.target as Element).setPointerCapture?.(e.pointerId); return; }
    const v = viewAt(p); setSel(v?.id || null);
    if (v) { drag.current = { kind: "view", id: v.id, start: p, orig: Object.fromEntries(doc.views.map(x => [x.id, [x.x, x.y]])), moved: false, cx: e.clientX, cy: e.clientY }; (e.target as Element).setPointerCapture?.(e.pointerId); }
  };
  const onMove = (e: React.PointerEvent) => {
    const p = toSheet(e.clientX, e.clientY); setMouse(tool === "smartDim" ? snap(p) : p); const d = drag.current; if (!d) return;
    if (Math.hypot(e.clientX - d.cx, e.clientY - d.cy) > 3) d.moved = true; if (!d.moved) return;
    if (d.kind === "pan") { const sx = vb[2] / (svgRef.current!.clientWidth || 1); const nv: [number, number, number, number] = [d.orig[0] - (e.clientX - d.cx) * sx, d.orig[1] - (e.clientY - d.cy) * sx, d.orig[2], d.orig[3]]; setVb(nv); return; }
    const dx = p[0] - d.start[0], dy = p[1] - d.start[1];
    if (d.kind === "anno") { upd(dd => ({ ...dd, annos: dd.annos.map(a => a.id === d.id ? { ...a, pos: [d.orig[0] + dx, d.orig[1] + dy] } : a) }), false); return; }
    if (d.kind === "view") {
      const v = doc.views.find(x => x.id === d.id)!; const par = v.parent ? doc.views.find(x => x.id === v.parent) : null;
      upd(dd => ({ ...dd, views: dd.views.map(x => {
        const o = d.orig[x.id];
        if (x.id === v.id) { if (v.type === "projected" && par) { const vert = v.orient === "top" || v.orient === "bottom"; return { ...x, x: vert ? par.x : o[0] + dx, y: vert ? o[1] + dy : par.y }; } return { ...x, x: o[0] + dx, y: o[1] + dy }; }
        if (x.parent === v.id && x.type === "projected") { const vert = x.orient === "top" || x.orient === "bottom"; return { ...x, x: vert ? o[0] + dx : o[0], y: vert ? o[1] : o[1] + dy }; }
        return x; }), annos: dd.annos.map(a => a.view === v.id && a.type !== "bom" ? { ...a, a: a.a && moveBy(a.a, d, dd, a), b: a.b && moveBy(a.b, d, dd, a), pos: moveBy(a.pos, d, dd, a) } : a) }), false);
    }
  };
  const moveBy = (q: Vec2, _d: any, _dd: DrawingDoc, _a: DrawAnno): Vec2 => q; // annotations keep sheet position (re-attach by Model Items)
  const onUp = () => { const d = drag.current; drag.current = null; if (d && d.moved && d.kind !== "pan") { const cur = st().docs[doc.id] as DrawingDoc; const base = dragBase.current; if (base && base !== cur) { upd(() => base, false); upd(() => cur, true); } } };
  const onWheel = (e: React.WheelEvent) => { const p = toSheet(e.clientX, e.clientY); const k = e.deltaY > 0 ? 1.15 : 1 / 1.15; setVb([p[0] - (p[0] - vb[0]) * k, p[1] - (p[1] - vb[1]) * k, vb[2] * k, vb[3] * k]); };

  function toolClick(p0: Vec2, e: React.PointerEvent) {
    const parent = doc.views.find(x => x.id === sel);
    const done = (fn?: () => void) => { fn?.(); setPts([]); if (!e.shiftKey) setTool(null); st().setStatus("Ready"); };
    if (tool === "projView" && parent) {
      const dx = p0[0] - parent.x, dy = p0[1] - parent.y; const first = doc.projection === "first";
      let orient: DrawViewOrient; if (Math.abs(dx) > 2 * Math.abs(dy) || Math.abs(dy) > 2 * Math.abs(dx)) { orient = Math.abs(dx) > Math.abs(dy) ? ((dx > 0) !== first ? "right" : "left") : ((dy < 0) !== first ? "top" : "bottom"); } else orient = "iso";
      if (parent.orient !== "front" && orient !== "iso") { st().showToast("Projected views are derived from a Front base view in this version — creating an isometric view"); orient = "iso"; }
      const v: DrawView = { id: uid("v"), type: orient === "iso" ? "model" : "projected", label: `Drawing View${doc.views.length + 1}`, orient, parent: orient === "iso" ? undefined : parent.id, x: orient === "top" || orient === "bottom" ? parent.x : p0[0], y: orient === "left" || orient === "right" ? parent.y : p0[1], scale: parent.scale, style: "hlr", hidden: orient !== "iso" };
      return done(() => upd(d => ({ ...d, views: [...d.views, v] })));
    }
    if (tool === "sectionView" && parent) {
      const q = s2v(parent, p0);
      if (pts.length < 2) { const np = [...pts, q]; setPts(np); if (np.length === 2) st().setStatus("Click to place the section view"); return; }
      const n = doc.views.filter(v => v.type === "section").length; const L = String.fromCharCode(65 + n);
      const v: DrawView = { id: uid("v"), type: "section", label: `Section View ${L}-${L}`, orient: parent.orient, parent: parent.id, section: { a: pts[0], b: pts[1] }, x: p0[0], y: p0[1], scale: parent.scale, style: "hlr", hidden: false };
      return done(() => upd(d => ({ ...d, views: [...d.views, v] })));
    }
    if (tool === "detailView" && parent) {
      const q = s2v(parent, p0);
      if (pts.length === 0) { setPts([q]); st().setStatus("Click to set the detail circle radius"); return; }
      if (pts.length === 1) { setPts([pts[0], q]); st().setStatus("Click to place the detail view"); return; }
      const r = Math.hypot(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]); const n = doc.views.filter(v => v.type === "detail").length; const L = String.fromCharCode(65 + 8 + n);
      const v: DrawView = { id: uid("v"), type: "detail", label: `Detail View ${L}`, orient: parent.orient, parent: parent.id, detail: { c: pts[0], r }, x: p0[0], y: p0[1], scale: parent.scale * 2, style: "hlr" };
      return done(() => upd(d => ({ ...d, views: [...d.views, v] })));
    }
    if (tool === "smartDim") {
      const p = snap(p0);
      if (pts.length < 2) { setPts([...pts, p]); return; }
      const [a, b] = pts; const v = viewAt(a) || viewAt(b); const sc = v?.scale || doc.scale;
      const dx = Math.abs(b[0] - a[0]), dy = Math.abs(b[1] - a[1]); const minx = Math.min(a[0], b[0]), maxx = Math.max(a[0], b[0]), miny = Math.min(a[1], b[1]), maxy = Math.max(a[1], b[1]);
      const kind: "h" | "v" | "a" = p[1] < miny || p[1] > maxy ? (p[0] >= minx && p[0] <= maxx ? "h" : dx > dy ? "h" : "a") : p[0] < minx || p[0] > maxx ? "v" : "a";
      const val = (kind === "h" ? dx : kind === "v" ? dy : Math.hypot(dx, dy)) / sc;
      return done(() => upd(d => ({ ...d, annos: [...d.annos, { id: uid("a"), type: "dim", kind, a, b, pos: p, value: val, view: v?.id }] })));
    }
    if (tool === "balloon") { if (!pts.length) { setPts([p0]); return; } const n = doc.annos.filter(a => a.type === "balloon").length + 1; return done(() => upd(d => ({ ...d, annos: [...d.annos, { id: uid("a"), type: "balloon", a: pts[0], pos: p0, text: String(n) }] }))); }
    if (tool === "note") { const t = prompt("Note text", "NOTES:\n1. BREAK ALL SHARP EDGES."); if (!t) return done(); return done(() => upd(d => ({ ...d, annos: [...d.annos, { id: uid("a"), type: "note", a: p0, pos: p0, text: t }] }))); }
    if (tool === "surface") { const t = prompt("Roughness (Ra, µm)", "3.2"); if (!t) return done(); return done(() => upd(d => ({ ...d, annos: [...d.annos, { id: uid("a"), type: "surface", a: p0, pos: p0, text: t }] }))); }
    if (tool === "datum") { const t = prompt("Datum label", String.fromCharCode(65 + doc.annos.filter(a => a.type === "datum").length)); if (!t) return done(); return done(() => upd(d => ({ ...d, annos: [...d.annos, { id: uid("a"), type: "datum", a: p0, pos: [p0[0], p0[1] - 10], text: t }] }))); }
    if (tool === "gtol") { const t = prompt("Tolerance frame (symbol|tolerance|datums)", "⌖|⌀0.05|A|B"); if (!t) return done(); return done(() => upd(d => ({ ...d, annos: [...d.annos, { id: uid("a"), type: "gtol", a: p0, pos: p0, text: t }] }))); }
    if (tool === "centerMark") { const p = snap(p0); return done(() => upd(d => ({ ...d, annos: [...d.annos, { id: uid("a"), type: "centerMark", a: p, pos: p, value: 4 }] }))); }
    if (tool === "bom") return done(() => upd(d => ({ ...d, annos: [...d.annos.filter(a => a.type !== "bom"), { id: uid("a"), type: "bom", a: p0, pos: p0 }] })));
  }

  // ── export
  function exportDrawing(fmtName: string) {
    const svg = svgRef.current; if (!svg) return;
    const clone = svg.cloneNode(true) as SVGSVGElement; clone.setAttribute("viewBox", `0 0 ${W} ${H}`); clone.setAttribute("width", `${W}mm`); clone.setAttribute("height", `${H}mm`); clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    clone.querySelectorAll(".no-export, .dv-sel, .pick-dot, .pick-line, .sec-preview").forEach(n => n.remove());
    clone.querySelectorAll(".sel").forEach(n => n.classList.remove("sel"));
    // embed the drawing styles so the file renders identically outside the app
    const font = getComputedStyle(document.body).getPropertyValue("--font").trim() || "Arial, sans-serif";
    const css: string[] = [];
    for (const sh of Array.from(document.styleSheets)) { let rules: CSSRuleList | null = null; try { rules = sh.cssRules; } catch { continue; }
      for (const r of Array.from(rules || [])) { const sel = (r as CSSStyleRule).selectorText; if (sel && sel !== ".sheet-svg" && /(\.sheet-svg|\.dv-|\.anno|\.dim-line|\.ext-line|\.center-line|\.balloon|\.tb-|\.sec-line|\.paper|\.border|\.zone)/.test(sel) && !/\.sel\b|\.dv-sel/.test(sel)) css.push(r.cssText.replace(/var\(--font\)/g, font)); } }
    const style = document.createElementNS("http://www.w3.org/2000/svg", "style"); style.textContent = css.join("\n").replace(/\.sheet-svg \.paper \{[^}]*\}/, ".sheet-svg .paper { fill: #fff; }"); clone.insertBefore(style, clone.firstChild);
    const xml = new XMLSerializer().serializeToString(clone);
    if (fmtName === "svg") return download(`${doc.name}.svg`, xml, "image/svg+xml");
    if (fmtName === "pdf") { const w = window.open("", "_blank"); if (!w) return st().showToast("Allow pop-ups to print / save as PDF"); w.document.write(`<html><head><title>${doc.name}</title><style>@page{size:${W}mm ${H}mm;margin:0}body{margin:0}</style></head><body>${xml}<script>setTimeout(()=>print(),300)</script></body></html>`); w.document.close(); return; }
    if (fmtName === "dxf") {
      const out: string[] = ["0", "SECTION", "2", "ENTITIES"]; const L = (a: Vec2, b: Vec2, layer = "VISIBLE") => out.push("0", "LINE", "8", layer, "10", fmt(a[0], 4), "20", fmt(H - a[1], 4), "30", "0", "11", fmt(b[0], 4), "21", fmt(H - b[1], 4), "31", "0");
      for (const v of doc.views) { const pr = v.type === "detail" ? null : proj[v.id]; if (!pr) continue; for (const [list, layer] of [[pr.visible, "VISIBLE"], [pr.hidden, "HIDDEN"]] as const) for (const d of list) for (const pl of pathPolylines(d)) for (let i = 0; i < pl.length - 1; i++) L(v2s(v, pl[i]), v2s(v, pl[i + 1]), layer); }
      L([10, 10], [W - 10, 10], "BORDER"); L([W - 10, 10], [W - 10, H - 10], "BORDER"); L([W - 10, H - 10], [10, H - 10], "BORDER"); L([10, H - 10], [10, 10], "BORDER");
      for (const a of doc.annos) if (a.type === "dim" && a.b) { L(a.a, a.b, "DIM"); out.push("0", "TEXT", "8", "DIM", "10", fmt(a.pos[0], 3), "20", fmt(H - a.pos[1], 3), "30", "0", "40", "3.5", "1", fmt(a.value ?? 0, 2)); }
      out.push("0", "ENDSEC", "0", "EOF"); return download(`${doc.name}.dxf`, out.join("\n"), "application/dxf");
    }
  }

  // ── render helpers
  const strokeW = 0.35, thin = 0.18;
  const renderView = (v: DrawView): ReactNode => {
    const isSel = sel === v.id; const b = bboxOf(v);
    if (v.type === "detail") {
      const par = doc.views.find(x => x.id === v.parent); const pr = par && proj[par.id]; if (!pr || !v.detail || !b) return null; const c = v.detail.c; const cid = `clip-${v.id}`;
      return <g key={v.id}>
        <clipPath id={cid}><circle cx={c[0]} cy={c[1]} r={v.detail.r} /></clipPath>
        <g transform={`translate(${v.x},${v.y}) scale(${v.scale}) translate(${-c[0]},${-c[1]})`}>
          <g clipPath={`url(#${cid})`}>{pr.visible.map((d, i) => <path key={i} d={d} className="dv-vis" />)}</g>
          <circle cx={c[0]} cy={c[1]} r={v.detail.r} className="dv-thin" />
        </g>
        <text x={v.x} y={v.y + v.detail.r * v.scale + 7} className="dv-label">{v.label.toUpperCase()}  SCALE {scaleLabel(v.scale)}</text>
        {isSel && <rect className="dv-sel no-export" x={v.x - v.detail.r * v.scale - 3} y={v.y - v.detail.r * v.scale - 3} width={v.detail.r * v.scale * 2 + 6} height={v.detail.r * v.scale * 2 + 6} />}
      </g>;
    }
    const pr = proj[v.id]; if (!pr || !b) return <g key={v.id}><rect x={v.x - 20} y={v.y - 12} width={40} height={24} className="dv-sel" strokeDasharray="2 2" /><text x={v.x} y={v.y + 2} className="dv-label">{pr?.error ? "⚠ " + pr.error.slice(0, 40) : busy ? "Computing…" : src ? "…" : "No model"}</text></g>;
    const c = ctr(b); const w = (b[2] - b[0]) * v.scale, h = (b[3] - b[1]) * v.scale;
    return <g key={v.id}>
      <g transform={`translate(${v.x},${v.y}) scale(${v.scale}) translate(${-c[0]},${-c[1]})`}>
        {pr.hatch && <path d={pr.hatch} fill="url(#hatch)" stroke="none" />}
        {pr.hidden.map((d, i) => <path key={"h" + i} d={d} className="dv-hid" />)}
        {pr.visible.map((d, i) => <path key={i} d={d} className="dv-vis" />)}
      </g>
      {(v.type === "section" || v.orient === "iso" || v.type === "model" && doc.views.length > 1 && v.orient !== "front") && <text x={v.x} y={v.y + h / 2 + 8} className="dv-label">{v.type === "section" ? `${v.label.toUpperCase()}  SCALE ${scaleLabel(v.scale)}` : v.orient === "iso" ? "" : ORIENT[v.orient].label.toUpperCase()}</text>}
      {isSel && <rect className="dv-sel no-export" x={v.x - w / 2 - 4} y={v.y - h / 2 - 4} width={w + 8} height={h + 8} />}
      {/* section line & detail circle markers on parents */}
      {doc.views.filter(x => x.parent === v.id && x.type === "section" && x.section).map(x => { const A = v2s(v, x.section!.a), B = v2s(v, x.section!.b); const L = x.label.split(" ").pop()!.split("-")[0]; const ux = B[0] - A[0], uy = B[1] - A[1]; const l = Math.hypot(ux, uy) || 1; const nx = -uy / l * (x.flip ? -1 : 1), ny = ux / l * (x.flip ? -1 : 1);
        return <g key={x.id} className="sec-line"><line x1={A[0]} y1={A[1]} x2={B[0]} y2={B[1]} /><path d={`M${A[0]},${A[1]} l${-nx * 8},${-ny * 8} M${B[0]},${B[1]} l${-nx * 8},${-ny * 8}`} /><path className="arrowhead" d={`M${A[0] - nx * 8},${A[1] - ny * 8} l${nx * 2 + ux / l * 1.2},${ny * 2 + uy / l * 1.2} l${-ux / l * 2.4},${-uy / l * 2.4} z M${B[0] - nx * 8},${B[1] - ny * 8} l${nx * 2 + ux / l * 1.2},${ny * 2 + uy / l * 1.2} l${-ux / l * 2.4},${-uy / l * 2.4} z`} /><text x={A[0] - nx * 12} y={A[1] - ny * 12 + 1.5} className="dv-label big">{L}</text><text x={B[0] - nx * 12} y={B[1] - ny * 12 + 1.5} className="dv-label big">{L}</text></g>; })}
      {doc.views.filter(x => x.parent === v.id && x.type === "detail" && x.detail).map(x => { const C = v2s(v, x.detail!.c); const r = x.detail!.r * v.scale; return <g key={x.id}><circle cx={C[0]} cy={C[1]} r={r} className="dv-thin" strokeDasharray="4 1 1 1" /><text x={C[0] + r * 0.8} y={C[1] - r * 0.8} className="dv-label big">{x.label.split(" ").pop()}</text></g>; })}
    </g>;
  };
  const renderAnno = (a: DrawAnno): ReactNode => {
    const isSel = sel === a.id; const cls = `anno ${isSel ? "sel" : ""}`;
    if (a.type === "dim" && a.b) return <g key={a.id} data-anno={a.id} className={cls}>{dimGraphic(a.a, a.b, a.pos, a.kind || "a", `${a.kind === "d" ? "⌀" : a.kind === "r" ? "R" : ""}${fmt(a.value ?? 0, 2)}`)}</g>;
    if (a.type === "note") return <g key={a.id} data-anno={a.id} className={cls}>{(a.text || "").split("\n").map((l, i) => <text key={i} x={a.pos[0]} y={a.pos[1] + i * 5} className="anno-text left">{l}</text>)}</g>;
    if (a.type === "balloon") return <g key={a.id} data-anno={a.id} className={cls}><line x1={a.a[0]} y1={a.a[1]} x2={a.pos[0]} y2={a.pos[1]} className="dim-line" /><circle cx={a.a[0]} cy={a.a[1]} r={0.7} fill="#000" /><circle cx={a.pos[0]} cy={a.pos[1]} r={5} className="balloon" /><text x={a.pos[0]} y={a.pos[1] + 1.6} className="anno-text">{a.text}</text></g>;
    if (a.type === "surface") return <g key={a.id} data-anno={a.id} className={cls}><path d={`M${a.pos[0] - 4},${a.pos[1] - 3} l2,4 l6,-12 h8`} className="dim-line" /><text x={a.pos[0] + 6} y={a.pos[1] - 9} className="anno-text left small">Ra {a.text}</text></g>;
    if (a.type === "datum") return <g key={a.id} data-anno={a.id} className={cls}><path d={`M${a.a[0] - 2.5},${a.a[1]} h5 l-2.5,-3.5 z`} fill="#000" /><line x1={a.a[0]} y1={a.a[1] - 3.5} x2={a.pos[0]} y2={a.pos[1] + 3.5} className="dim-line" /><rect x={a.pos[0] - 3.5} y={a.pos[1] - 3.5} width={7} height={7} className="balloon" /><text x={a.pos[0]} y={a.pos[1] + 1.6} className="anno-text">{a.text}</text></g>;
    if (a.type === "gtol") { const cells = (a.text || "").split("|"); let x = a.pos[0]; return <g key={a.id} data-anno={a.id} className={cls}>{cells.map((c, i) => { const w = Math.max(7, c.length * 2.4 + 3); const el = <g key={i}><rect x={x} y={a.pos[1] - 3.5} width={w} height={7} className="balloon" /><text x={x + w / 2} y={a.pos[1] + 1.4} className="anno-text">{c}</text></g>; x += w; return el; })}</g>; }
    if (a.type === "centerMark") { const r = a.value || 4; return <g key={a.id} data-anno={a.id} className={cls}><path d={`M${a.pos[0] - r},${a.pos[1]} h${r * 2} M${a.pos[0]},${a.pos[1] - r} v${r * 2}`} className="center-line" /></g>; }
    if (a.type === "bom") { const rows = src ? bomRows(src) : []; const cw = [12, 45, 50, 12]; const rh = 6; const x0 = a.pos[0], y0 = a.pos[1]; const tw = cw.reduce((p, q) => p + q, 0);
      return <g key={a.id} data-anno={a.id} className={cls}><rect x={x0} y={y0} width={tw} height={rh * (rows.length + 1)} className="tb-rect" />
        {["ITEM NO.", "PART NUMBER", "DESCRIPTION", "QTY."].map((h, i) => <text key={h} x={x0 + cw.slice(0, i).reduce((p, q) => p + q, 0) + cw[i] / 2} y={y0 + 4.2} className="anno-text small b">{h}</text>)}
        {rows.map((r, j) => <g key={j}><line x1={x0} x2={x0 + tw} y1={y0 + rh * (j + 1)} y2={y0 + rh * (j + 1)} className="tb-line" />{[String(r.item), r.name, r.desc, String(r.qty)].map((t, i) => <text key={i} x={x0 + cw.slice(0, i).reduce((p, q) => p + q, 0) + cw[i] / 2} y={y0 + rh * (j + 1) + 4.2} className="anno-text small">{t}</text>)}</g>)}
        {cw.slice(0, -1).map((_, i) => <line key={i} x1={x0 + cw.slice(0, i + 1).reduce((p, q) => p + q, 0)} x2={x0 + cw.slice(0, i + 1).reduce((p, q) => p + q, 0)} y1={y0} y2={y0 + rh * (rows.length + 1)} className="tb-line" />)}</g>; }
    return null;
  };

  const tb = doc.title; const tbW = 180, tbH = 40; const tx = W - 10 - tbW, ty = H - 10 - tbH;
  const editTitle = (k: string) => { const v = prompt(k, tb[k] || ""); if (v !== null) upd(d => ({ ...d, title: { ...d.title, [k]: v } })); };
  const sources = Object.values(s.docs).filter(d => d.kind === "part" || d.kind === "assembly");
  const parent = doc.views.find(x => x.id === sel);

  return <div className="drawing-wrap">
    <svg ref={svgRef} className={`sheet-svg ${tool || placing ? "cur-pick" : ""}`} viewBox={vb.join(" ")} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onWheel={onWheel} onContextMenu={e => e.preventDefault()}
      onDoubleClick={e => { const p = toSheet(e.clientX, e.clientY); const a = (e.target as Element).closest("[data-anno]"); if (a) { const an = doc.annos.find(x => x.id === a.getAttribute("data-anno")); if (an && an.type === "dim") { const v = prompt("Dimension value (override display)", fmt(an.value ?? 0, 3)); if (v !== null && !isNaN(+v)) upd(d => ({ ...d, annos: d.annos.map(x => x.id === an.id ? { ...x, value: +v } : x) })); } else if (an && an.text !== undefined) { const v = prompt("Text", an.text); if (v !== null) upd(d => ({ ...d, annos: d.annos.map(x => x.id === an.id ? { ...x, text: v } : x) })); } return; } const v = viewAt(p); if (v) { const sc = prompt(`Scale for ${v.label} (e.g. 1:2 or 2:1)`, scaleLabel(v.scale)); if (sc) { const m = sc.match(/([\d.]+)\s*:\s*([\d.]+)/); if (m) { const k = +m[1] / +m[2]; upd(d => ({ ...d, views: d.views.map(x => x.id === v.id || x.parent === v.id && x.type === "projected" ? { ...x, scale: k } : x) })); } } } }}>
      <defs><pattern id="hatch" width="2.5" height="2.5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="2.5" stroke="#000" strokeWidth="0.18" /></pattern>
        <marker id="arr" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="3.2" markerHeight="3.2" orient="auto-start-reverse"><path d="M0,1 L10,5 L0,9 z" fill="#000" /></marker></defs>
      <rect x={0} y={0} width={W} height={H} className="paper" />
      <rect x={10} y={10} width={W - 20} height={H - 20} className="border" />
      {/* zone markers */}
      {Array.from({ length: Math.floor((W - 20) / 50) }, (_, i) => <text key={"zx" + i} x={10 + 25 + i * 50} y={8} className="zone">{Math.floor((W - 20) / 50) - i}</text>)}
      {Array.from({ length: Math.floor((H - 20) / 50) }, (_, i) => <text key={"zy" + i} x={5} y={10 + 27 + i * 50} className="zone">{String.fromCharCode(65 + i)}</text>)}
      {doc.views.map(renderView)}
      {doc.annos.map(renderAnno)}
      {/* title block */}
      <g className="titleblock">
        <rect x={tx} y={ty} width={tbW} height={tbH} className="tb-rect" />
        {[[tx, ty + 10, tx + tbW, ty + 10], [tx, ty + 20, tx + tbW, ty + 20], [tx, ty + 30, tx + tbW, ty + 30], [tx + 60, ty, tx + 60, ty + tbH], [tx + 120, ty + 20, tx + 120, ty + tbH], [tx + 150, ty + 20, tx + 150, ty + tbH]].map((l, i) => <line key={i} x1={l[0]} y1={l[1]} x2={l[2]} y2={l[3]} className="tb-line" />)}
        {([["company", tx + 2, ty + 7, 3.4, true], ["title", tx + 62, ty + 7, 4, true], ["drawnBy", tx + 2, ty + 17, 2.6, false], ["partNo", tx + 62, ty + 17, 3, false], ["date", tx + 2, ty + 27, 2.6, false], ["material", tx + 62, ty + 27, 2.6, false], ["rev", tx + 152, ty + 27, 2.6, false]] as [string, number, number, number, boolean][]).map(([k, x, y, fs, b]) => <text key={k} x={x} y={y} className="tb-text" style={{ fontSize: fs, fontWeight: b ? 700 : 400, cursor: "pointer" }} onDoubleClick={e => { e.stopPropagation(); editTitle(k); }}>{tb[k] || ""}</text>)}
        <text x={tx + 2} y={ty + 13} className="tb-cap">DRAWN</text><text x={tx + 62} y={ty + 13} className="tb-cap">DWG. NO.</text><text x={tx + 2} y={ty + 23} className="tb-cap">DATE</text><text x={tx + 62} y={ty + 23} className="tb-cap">MATERIAL</text><text x={tx + 122} y={ty + 23} className="tb-cap">SIZE</text><text x={tx + 152} y={ty + 23} className="tb-cap">REV</text>
        <text x={tx + 122} y={ty + 27} className="tb-text" style={{ fontSize: 2.6 }}>{doc.sheet}</text>
        <text x={tx + 2} y={ty + 37} className="tb-text" style={{ fontSize: 2.6 }}>SCALE: {scaleLabel(doc.scale)}    UNITS: {doc.units === "IPS" ? "INCH" : "MM"}    {doc.projection === "third" ? "THIRD" : "FIRST"} ANGLE PROJECTION</text>
        <text x={tx + 122} y={ty + 37} className="tb-text" style={{ fontSize: 2.6 }}>SHEET 1 OF 1</text>
        <g transform={`translate(${tx + 166},${ty + 34})`}><circle r={2.4} className="tb-line" /><circle r={1.1} className="tb-line" /><path d={doc.projection === "third" ? "M-9,-2.4 L-4,-1.3 L-4,1.3 L-9,2.4 Z" : "M4,-1.3 L9,-2.4 L9,2.4 L4,1.3 Z"} className="tb-line" /></g>
      </g>
      {/* tool previews */}
      <g className="no-export">
        {tool === "smartDim" && pts.length >= 1 && <>{pts.map((p, i) => <circle key={i} cx={p[0]} cy={p[1]} r={1} className="pick-dot" />)}{pts.length === 1 && <line x1={pts[0][0]} y1={pts[0][1]} x2={mouse[0]} y2={mouse[1]} className="pick-line" />}{pts.length === 2 && <g className="anno">{dimGraphic(pts[0], pts[1], mouse, "a", "…")}</g>}</>}
        {tool === "smartDim" && <circle cx={mouse[0]} cy={mouse[1]} r={0.9} className="pick-dot" />}
        {tool === "sectionView" && parent && pts.length >= 1 && (() => { const A = v2s(parent, pts[0]); const B = pts[1] ? v2s(parent, pts[1]) : mouse; return <line x1={A[0]} y1={A[1]} x2={B[0]} y2={B[1]} className="sec-preview" />; })()}
        {tool === "detailView" && parent && pts.length >= 1 && (() => { const C = v2s(parent, pts[0]); const r = pts[1] ? Math.hypot(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]) * parent.scale : Math.hypot(mouse[0] - C[0], mouse[1] - C[1]); return <circle cx={C[0]} cy={C[1]} r={r} className="sec-preview" fill="none" />; })()}
        {tool === "balloon" && pts.length === 1 && <line x1={pts[0][0]} y1={pts[0][1]} x2={mouse[0]} y2={mouse[1]} className="pick-line" />}
        {placing && <rect x={mouse[0] - 20} y={mouse[1] - 15} width={40} height={30} className="sec-preview" fill="none" />}
      </g>
    </svg>
    {(tool || placing) && <div className="vp-prompt">{s.status} <button className="mini" onClick={() => { setTool(null); setPts([]); setPlacing(null); }}>Cancel (Esc)</button></div>}
    {busy && <div className="building">Updating views…</div>}
    <div className="draw-toolbar no-export">
      <button title="Zoom to sheet" onClick={() => setVb([-10, -10, W + 20, H + 20])}><Icon name="zoomFit" size={18} /></button>
      <button title="Export SVG" onClick={() => exportDrawing("svg")}>SVG</button><button title="Export DXF" onClick={() => exportDrawing("dxf")}>DXF</button><button title="Print / PDF" onClick={() => exportDrawing("pdf")}>PDF</button>
      {parent && parent.type !== "detail" && <><span className="hu-sep" /><span className="muted">{parent.label}:</span>
        <button onClick={() => upd(d => ({ ...d, views: d.views.map(x => x.id === parent.id ? { ...x, hidden: !(x.hidden ?? true) } : x) }))}>{parent.hidden === false ? "Show hidden" : "Hide hidden"}</button>
        {parent.type === "section" && <button onClick={() => upd(d => ({ ...d, views: d.views.map(x => x.id === parent.id ? { ...x, flip: !x.flip } : x) }))}>Flip direction</button>}
        {parent.type === "model" && <select value={parent.orient} onChange={e => upd(d => ({ ...d, views: d.views.map(x => x.id === parent.id ? { ...x, orient: e.target.value as DrawViewOrient } : x) }))}>{Object.entries(ORIENT).map(([k, o]) => <option key={k} value={k}>{o.label}</option>)}</select>}
        <select value={String(parent.scale)} onChange={e => upd(d => ({ ...d, views: d.views.map(x => x.id === parent.id || (x.parent === parent.id && x.type === "projected") ? { ...x, scale: +e.target.value } : x) }))}>{[...new Set([...STD_SCALES, parent.scale])].sort((a, b) => b - a).map(k => <option key={k} value={k}>{scaleLabel(k)}</option>)}</select>
        <button onClick={() => window.dispatchEvent(new CustomEvent("cad:drawingDelete"))}>Delete</button></>}
    </div>
    {pickSrc && <div className="dlg-back"><div className="dlg">
      <div className="dlg-title"><Icon name="modelView" size={18} /><span>{pickSrc === "std3" ? "Standard 3 View" : "Model View"} — select a model</span><button onClick={() => setPickSrc(null)}>×</button></div>
      <div className="dlg-body">
        {sources.length === 0 && <p>Open or create a part / assembly first.</p>}
        <div className="list-box">{sources.map(d => <div key={d.id} className={`tp-file ${doc.sourceId === d.id ? "sel" : ""}`} onClick={() => upd(x => ({ ...x, sourceId: d.id, title: { ...x.title, title: d.name, partNo: d.name, material: (d as PartDoc).material || "" } }))}><Icon name={d.kind} size={18} /><span>{d.name}</span></div>)}</div>
        {pickSrc === "model" && doc.sourceId && <><p className="muted">Orientation — then click on the sheet to place:</p><div className="orient-grid">{(Object.keys(ORIENT) as DrawViewOrient[]).map(o => <button key={o} onClick={() => { setPlacing({ orient: o }); setPickSrc(null); st().setStatus(`Click on the sheet to place the ${ORIENT[o].label} view`); }}>{ORIENT[o].label}</button>)}</div></>}
      </div>
      <div className="dlg-foot">{pickSrc === "std3" && <button className="btn primary" disabled={!doc.sourceId} onClick={() => { const sid = st().docs[doc.id] && (st().docs[doc.id] as DrawingDoc).sourceId; if (sid) { setPickSrc(null); setTimeout(() => addStd3(sid), 0); } }}>OK</button>}<button className="btn" onClick={() => setPickSrc(null)}>Cancel</button></div>
    </div></div>}
    {!doc.views.length && !pickSrc && <div className="vp-empty drawing-empty"><h2>{doc.name}</h2><p>{src ? `Model: ${src.name}` : "No model selected."}</p><div className="vp-empty-btns"><button onClick={() => { if (src) addStd3(); else setPickSrc("std3"); }}>▦ Standard 3 View</button><button onClick={() => setPickSrc("model")}>▣ Model View…</button></div></div>}
  </div>;
}

function dimGraphic(a: Vec2, b: Vec2, pos: Vec2, kind: string, text: string): ReactNode {
  let p1: Vec2, p2: Vec2;
  if (kind === "h") { p1 = [a[0], pos[1]]; p2 = [b[0], pos[1]]; }
  else if (kind === "v") { p1 = [pos[0], a[1]]; p2 = [pos[0], b[1]]; }
  else { const ux = b[0] - a[0], uy = b[1] - a[1]; const L = Math.hypot(ux, uy) || 1; const nx = -uy / L, ny = ux / L; const off = (pos[0] - a[0]) * nx + (pos[1] - a[1]) * ny; p1 = [a[0] + nx * off, a[1] + ny * off]; p2 = [b[0] + nx * off, b[1] + ny * off]; }
  const ext = (q: Vec2, p: Vec2) => { const dx = p[0] - q[0], dy = p[1] - q[1]; const L = Math.hypot(dx, dy); if (L < 0.01) return null; const k = (L + 1.5) / L; return <line x1={q[0] + dx / L * 1} y1={q[1] + dy / L * 1} x2={q[0] + dx * k} y2={q[1] + dy * k} className="ext-line" />; };
  const mx = (p1[0] + p2[0]) / 2, my = (p1[1] + p2[1]) / 2; const ang = Math.atan2(p2[1] - p1[1], p2[0] - p1[0]) * 180 / Math.PI; const rot = ang > 90 || ang < -90 ? ang + 180 : ang;
  return <>{ext(a, p1)}{ext(b, p2)}<line x1={p1[0]} y1={p1[1]} x2={p2[0]} y2={p2[1]} className="dim-line" markerStart="url(#arr)" markerEnd="url(#arr)" />
    <text x={mx} y={my - 1.2} transform={`rotate(${rot} ${mx} ${my})`} className="anno-text dim-text">{text}</text></>;
}

export function bomRows(src: Doc): { item: number; name: string; desc: string; qty: number }[] {
  const s = st();
  if (src.kind === "part") return [{ item: 1, name: src.name, desc: src.props.Description || (src.material || ""), qty: 1 }];
  if (src.kind === "assembly") { const ids = [...new Set(src.components.map(c => c.partId))]; return ids.map((id, i) => { const p = s.docs[id] as PartDoc; return { item: i + 1, name: p?.name || "?", desc: p?.props?.Description || p?.material || "", qty: (src as AssemblyDoc).components.filter(c => c.partId === id).length }; }); }
  return [];
}
void MATERIALS;
