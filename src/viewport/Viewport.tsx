import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import { Engine } from "./engine";
import { useApp, selKey, effectiveFeatures, type Sel } from "../store";
import type { PartDoc, AssemblyDoc, Sketch, Constraint, Vec2, Vec3, PlaneDef } from "../types";
import { SketchTool, hitSketch } from "../sketch/tools";
import { solveSketch, DIM_TYPES } from "../sketch/solver";
import { PLANES, toWorld, fmt, applyT, evalExpr, planeFromNormal } from "../math";
import { pmBus } from "../ui/pmBus";
import { sampleEntity, arcAngles } from "../sketch/geom";
import { compWorld, explodeOffset } from "../assembly/solver";
import { onContextMenu } from "../ui/contextMenus";
import { holeClick } from "../ui/pm";

const STD_PLANES = ["Front", "Top", "Right"] as const;

export default function Viewport() {
  const host = useRef<HTMLDivElement>(null);
  const eng = useRef<Engine | null>(null);
  const tool = useRef(new SketchTool());
  const [, setTick] = useState(0);
  const rerender = () => setTick(t => t + 1);
  const rafPending = useRef(false);
  const s = useApp();
  const doc = s.activeId ? s.docs[s.activeId] : null;
  const part = doc?.kind === "part" ? (doc as PartDoc) : null;
  const asm = doc?.kind === "assembly" ? (doc as AssemblyDoc) : null;
  const build = doc ? s.builds[doc.id] : undefined;
  const [modify, setModify] = useState<{ cid: string; x: number; y: number; val: string } | null>(null);
  const [dragBox, setDragBox] = useState<[number, number, number, number] | null>(null);

  // ── engine lifecycle
  useEffect(() => {
    const e = new Engine(host.current!); eng.current = e; pmBus.engine = e;
    e.onCamera = () => { if (!rafPending.current) { rafPending.current = true; requestAnimationFrame(() => { rafPending.current = false; rerender(); }); } };
    const ro = new ResizeObserver(() => { e.resize(); rerender(); }); ro.observe(host.current!);
    return () => { ro.disconnect(); e.dispose(); eng.current = null; };
  }, []);

  // ── view commands
  useEffect(() => {
    const e = eng.current; const vc = s.viewCmd; if (!e || !vc.kind) return;
    if (vc.kind === "fit") e.fit();
    else if (vc.kind === "normal" && vc.plane) e.normalTo(vc.plane);
    else if (vc.kind === "prev") e.previousView();
    else if (vc.kind === "zoomIn") e.zoomAt(e.size.w / 2, e.size.h / 2, 0.8);
    else if (vc.kind === "zoomOut") e.zoomAt(e.size.w / 2, e.size.h / 2, 1.25);
    else if (vc.kind === "zoomArea") useApp.setState({ cursor: "zoomArea", status: "Drag a box to zoom to area" });
    else if (vc.kind === "screenshot") { const url = e.screenshot(); const a = document.createElement("a"); a.href = url; a.download = `${doc?.name || "view"}.png`; a.click(); }
    else if (vc.kind === "normalToSel") { const sel = useApp.getState().selection[0]; if (sel?.kind === "plane") e.normalTo(sel.plane); else if (sel?.kind === "face" && sel.normal) e.normalTo(planeFromNormal(sel.point, sel.normal)); }
    else e.setStandard(vc.kind);
    setTimeout(rerender, 350);
  }, [s.viewCmd.seq]);

  // ── model + style
  useEffect(() => { eng.current?.setStyle(s.display.style); }, [s.display.style]);
  useEffect(() => {
    const e = eng.current; if (!e) return;
    if (part) {
      const pv = s.preview && s.pm ? s.preview : null;
      e.setModel(pv ? pv.main : build?.main || null, part.appearance);
      const kind = pv?.preview ? (pv.previewTool ? (/cut|Cut|hole/.test(s.pm!.draft.type) ? "cut" : "add") : "result") : null;
      e.setPreview(pv?.preview || null, kind as any);
    } else { e.setModel(null, { color: "#ccc", metalness: 0, roughness: 0.5, opacity: 1 }); e.setPreview(null, null); }
  }, [part?.id, build, s.preview, s.pm?.type, part?.appearance]);
  useEffect(() => {
    const e = eng.current; if (!e) return;
    if (!asm) { e.setAssembly([]); return; }
    const items = asm.components.map(c => {
      const pd = s.docs[c.partId] as PartDoc | undefined; const b = s.builds[c.partId];
      if (!pd || !b?.main) return null;
      const t = compWorld(asm, c.id);
      return { compId: c.id, data: b.main, app: pd.appearance, pos: t.p, quat: t.q, hidden: c.hidden, transparent: c.transparent };
    }).filter(Boolean) as any[];
    e.setAssembly(items);
    // explode lines
    const objs: THREE.Object3D[] = [];
    if (asm.exploded) for (const c of asm.components) { const off = explodeOffset(asm, c.id); if (Math.hypot(...off) < 1e-6) continue; const b = s.builds[c.partId]?.main?.bbox; const ctr: Vec3 = b ? [(b[0][0] + b[1][0]) / 2, (b[0][1] + b[1][1]) / 2, (b[0][2] + b[1][2]) / 2] : [0, 0, 0]; const w1 = applyT(c.t as any, ctr); const w2: Vec3 = [w1[0] + off[0], w1[1] + off[1], w1[2] + off[2]]; const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(...w1), new THREE.Vector3(...w2)]), new THREE.LineDashedMaterial({ color: 0xc0392b, dashSize: 3, gapSize: 2 })); l.computeLineDistances(); objs.push(l); }
    for (const r of s.interference || []) if (r.mesh && r.show) { const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.BufferAttribute(r.mesh.vertices, 3)); g.setIndex(new THREE.BufferAttribute(r.mesh.triangles, 1)); g.computeVertexNormals(); const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: 0xff2020, transparent: true, opacity: 0.7, depthTest: false })); m.renderOrder = 40; objs.push(m); }
    e.setMisc(objs);
  }, [asm, s.builds, s.docs, s.interference]);

  // ── section
  useEffect(() => { const sec = s.display.section; eng.current?.setSection(sec.on, PLANES[sec.plane], sec.offset, sec.flip); }, [s.display.section, build, asm]);

  // ── reference geometry & sketches
  const planesForPick = s.pendingPick === "sketchPlane" || s.pendingPick === "plane" || (s.pm && ["mirror", "plane", "draft"].includes(s.pm.type) && /plane|neutral|base/.test(s.pm.box || ""));
  useEffect(() => {
    const e = eng.current; if (!e) return;
    const selKeys = new Set(s.selection.map(selKey)); const hk = s.hover ? selKey(s.hover) : "";
    const size = Math.max(40, build?.main?.bbox ? Math.max(...build.main.bbox[1].map((v, i) => Math.abs(v - build.main!.bbox![0][i]))) * 0.6 + 10 : 60);
    const planes: { id: string; plane: PlaneDef; size: number; hl: number }[] = [];
    if (part || (asm && s.display.planes)) {
      for (const n of STD_PLANES) { const k = `plane:${n}`; const show = s.display.planes || planesForPick || selKeys.has(k) || hk === k; if (show && !s.sketch) planes.push({ id: n, plane: PLANES[n], size, hl: selKeys.has(k) ? 2 : hk === k ? 1 : 0 }); }
      if (part) for (const f of effectiveFeatures(part)) if (f.type === "plane" && build?.planes?.[f.id] && !f.suppressed) { const k = `plane:${f.id}`; planes.push({ id: f.id, plane: build.planes[f.id], size: size * 0.8, hl: selKeys.has(k) ? 2 : hk === k ? 1 : 0 }); }
    }
    const axes = part && s.display.axes ? effectiveFeatures(part).filter(f => f.type === "axis" && build?.axes?.[f.id]).map(f => ({ id: f.id, ...build!.axes[f.id], hl: selKeys.has(`axis:${f.id}`) ? 2 : hk === `axis:${f.id}` ? 1 : 0 })) : [];
    e.setRefs(planes, s.display.origins && (!!part || !!asm), axes);
    // sketches
    const list: { id: string; sk: Sketch; hl: number }[] = [];
    if (part && s.display.sketches) {
      const feats = effectiveFeatures(part);
      const consumed = new Set<string>(); feats.forEach(f => { if (f.type !== "sketch" && !f.suppressed) { const p = f.params || {}; [p.sketchId, p.profileId, p.pathId, ...(p.profiles || [])].forEach(x => x && consumed.add(x)); } });
      for (const f of feats) if (f.type === "sketch" && f.sketch && f.id !== s.sketch?.featureId) {
        const k = `feature:${f.id}`; const shown = !consumed.has(f.id) || selKeys.has(k) || hk === k || (s.pm && JSON.stringify(s.pm.draft.params).includes(f.id));
        if (shown && !f.params?.hidden) list.push({ id: f.id, sk: f.sketch, hl: selKeys.has(k) || (s.pm && JSON.stringify(s.pm.draft.params).includes(`"${f.id}"`)) ? 2 : hk === k ? 1 : 0 });
      }
    }
    e.setSketches(list);
  }, [part, asm, build, s.display, s.selection, s.hover, s.pendingPick, s.sketch?.featureId, s.pm, planesForPick]);

  // ── highlights
  useEffect(() => {
    const e = eng.current; if (!e) return;
    const extra: Sel[] = [];
    if (s.pm) { const p = s.pm.draft.params || {}; for (const r of [...(p.edges || []), ...(p.faces || [])]) extra.push(r.kind === "edge" ? { kind: "edge", index: r.index, point: r.point } : { kind: "face", index: r.index, point: r.point }); if (s.pm.extra?.sels) extra.push(...s.pm.extra.sels); }
    const model = [...s.selection, ...extra].filter(x => x.kind === "face" || x.kind === "edge" || x.kind === "vertex" || x.kind === "comp");
    // resolve stale refs to current indices by nearest point
    e.setHighlights(model, s.hover && (s.hover.kind === "face" || s.hover.kind === "edge" || s.hover.kind === "vertex" || s.hover.kind === "comp") ? s.hover : null);
  }, [s.selection, s.hover, build, s.preview, s.pm, asm]);

  // ── active sketch rendering
  const ss = s.sketch;
  useEffect(() => {
    const e = eng.current; if (!e) return;
    if (!ss) { e.setActiveSketch(null, () => 0, null); e.setGrid(null, 10); return; }
    const selKeys = new Set(s.selection.map(selKey)); const hk = s.hover ? selKey(s.hover) : "";
    const sol = ss.solve; const bad = new Set<string>();
    if (sol) for (const cid of sol.bad) { const c = ss.sk.constraints.find(k => k.id === cid); c?.refs.forEach(r => bad.add(r)); }
    const colorOf = (id: string) => {
      if (selKeys.has(`sk:${id}`)) return 0x1f9e4a; if (hk === `sk:${id}`) return 0xff8c00;
      if (bad.has(id)) return 0xd01818;
      if (id === "O") return 0xc0392b;
      if (sol?.determined.has(id)) return 0x111111; return 0x1d4ed8;
    };
    tool.current.tol = e.worldPerPixel() * 8;
    const ov = tool.current.overlay();
    e.setActiveSketch(ss.sk, colorOf, { lines: ov.lines, pts: ov.snap?.kind ? [ov.snap.p] : [], dashed: ov.dashed });
    if (s.display.grid) e.setGrid(ss.sk.plane, s.options.gridSpacing); else e.setGrid(null, 10);
  }, [ss, s.selection, s.hover, tool.current.version, s.display.grid, s.options.gridSpacing]);

  useEffect(() => { tool.current.reset(); }, [ss?.tool, ss?.mode, !!ss]);

  // sketch API for PM/toolbar (convert entities etc.)
  pmBus.sketchApi = { tool: tool.current };

  // ── fit on first build
  const fitted = useRef<string>("");
  useEffect(() => { if (doc && fitted.current !== doc.id && (build?.main || asm)) { fitted.current = doc.id; setTimeout(() => eng.current?.fit(false), 30); setTimeout(rerender, 60); } }, [build, doc?.id, asm]);

  // ── input
  const down = useRef<{ x: number; y: number; btn: number; ctrl: boolean; shift: boolean; alt: boolean; moved: boolean; comp?: string; t: number } | null>(null);
  const local = (ev: { clientX: number; clientY: number }) => { const r = host.current!.getBoundingClientRect(); return [ev.clientX - r.left, ev.clientY - r.top] as [number, number]; };
  const skPt = (x: number, y: number): Vec2 | null => { const e = eng.current; const sk = useApp.getState().sketch?.sk; if (!e || !sk) return null; return e.planePoint(x, y, sk.plane); };

  const pickFilter = () => {
    const st = useApp.getState(); const f = st.selFilter;
    if (f === "faces") return { edges: false, vertices: false, planes: false, sketches: false };
    if (f === "edges") return { faces: false, vertices: false, planes: false, sketches: false };
    if (f === "vertices") return { faces: false, edges: false, planes: false, sketches: false };
    if (st.pendingPick === "sketchPlane") return { edges: false, vertices: false, sketches: false, axes: false, origin: false };
    return {};
  };

  const handleClickPick = (x: number, y: number, additive: boolean) => {
    const e = eng.current!; const st = useApp.getState();
    let sel = e.pick(x, y, pickFilter());
    if (st.pendingPick === "sketchPlane") {
      if (sel?.kind === "plane") { st.startSketch(sel.plane, sel.plane.name || sel.id, undefined); return; }
      if (sel?.kind === "face" && !sel.comp) { const info = st.builds[st.activeId!]?.main?.faces[sel.index]; if (info?.type === "PLANE" && info.normal) { st.startSketch(planeFromNormal(info.center, info.normal, `Face<${sel.index + 1}>`), `Face<${sel.index + 1}>`); return; } st.setStatus("Select a planar face or a plane"); return; }
      return;
    }
    if (asm && sel && (sel.kind === "face" || sel.kind === "edge" || sel.kind === "vertex") && sel.comp && !st.pm) sel = { kind: "comp", id: sel.comp };
    if (st.pm?.type === "hole" && st.pm.box === "points" && sel?.kind === "face" && sel.hit) { holeClick(sel.hit); return; }
    if (st.pm && pmBus.pick && sel) { if (pmBus.pick(sel, additive)) return; }
    st.select(sel, additive);
  };

  const onPointerDown = (ev: React.PointerEvent) => {
    (ev.target as Element).setPointerCapture?.(ev.pointerId);
    const [x, y] = local(ev); const st = useApp.getState();
    down.current = { x, y, btn: ev.button, ctrl: ev.ctrlKey || ev.metaKey, shift: ev.shiftKey, alt: ev.altKey, moved: false, t: performance.now() };
    useApp.setState({ menu: null, shortcutBar: null });
    if (ev.button === 0 && !ev.altKey && st.cursor !== "zoomArea") {
      if (st.sketch) { const p = skPt(x, y); if (p) { tool.current.tol = eng.current!.worldPerPixel() * 8; tool.current.down(p, { shift: ev.shiftKey, ctrl: ev.ctrlKey || ev.metaKey, sx: x, sy: y, dbl: ev.detail >= 2 }); rerender(); } return; }
      if (asm) { const sel = eng.current!.pick(x, y, { edges: false, vertices: false, planes: false, sketches: false }); if (sel && (sel as any).comp) { const c = asm.components.find(k => k.id === (sel as any).comp); if (c && !c.fixed && (!st.pm || st.pm.type === "moveComp" || st.pm.type === "rotateComp")) down.current.comp = c.id; } }
    }
  };
  const onPointerMove = (ev: React.PointerEvent) => {
    const [x, y] = local(ev); const e = eng.current; if (!e) return; const d = down.current; const st = useApp.getState();
    const p = st.sketch ? skPt(x, y) : null;
    if (st.sketch && p) { const pts = st.sketch.sk.plane; const w = toWorld(pts, p[0], p[1]); useApp.setState({ status: `X: ${fmt(p[0])}  Y: ${fmt(p[1])}   (${fmt(w[0])}, ${fmt(w[1])}, ${fmt(w[2])})` }); }
    if (d) {
      const dx = ev.movementX, dy = ev.movementY;
      if (!d.moved && Math.hypot(x - d.x, y - d.y) > 3) d.moved = true;
      if (!d.moved) return;
      if (d.btn === 1) { if (d.ctrl) e.pan(dx, dy); else if (d.shift) e.zoomAt(d.x, d.y, Math.pow(1.01, dy)); else e.orbit(dx, dy); return; }
      if (d.btn === 2 || (d.btn === 0 && d.alt)) { if (d.ctrl || d.shift) e.pan(dx, dy); else e.orbit(dx, dy); return; }
      if (d.btn === 0) {
        if (st.sketch && p) { tool.current.move(p, x, y); rerender(); return; }
        if (d.comp && pmBus.dragComp) { pmBus.dragComp(d.comp, dx, dy, st.pm?.type === "rotateComp" ? "rotate" : "move"); return; }
        setDragBox([d.x, d.y, x, y]); return;
      }
      return;
    }
    // hover
    if (st.sketch && p) { tool.current.tol = e.worldPerPixel() * 8; tool.current.move(p, x, y); const h = st.sketch.tool === "select" || st.sketch.tool === "dimension" || st.sketch.tool === "trim" || st.sketch.tool === "extend" ? hitSketch(st.sketch.sk, p, tool.current.tol) : null; const hs: Sel | null = h ? { kind: "sk", id: h.id } : null; if (JSON.stringify(hs) !== JSON.stringify(st.hover)) useApp.setState({ hover: hs }); rerender(); return; }
    const sel = e.pick(x, y, pickFilter()); const hs = asm && sel && (sel as any).comp && !st.pm ? { kind: "comp", id: (sel as any).comp } as Sel : sel;
    if (JSON.stringify(hs) !== JSON.stringify(st.hover)) useApp.setState({ hover: hs });
  };
  const onPointerUp = (ev: React.PointerEvent) => {
    const [x, y] = local(ev); const d = down.current; down.current = null; const st = useApp.getState(); const e = eng.current!;
    if (!d) return;
    if (dragBox) setDragBox(null);
    if (d.btn === 2 && !d.moved) { onContextMenu(ev.clientX, ev.clientY, st.sketch ? null : e.pick(x, y)); return; }
    if (d.btn !== 0 || d.alt) return;
    if (st.cursor === "zoomArea") { if (d.moved) e.zoomToBox(d.x, d.y, x, y); useApp.setState({ cursor: "", status: "Ready" }); return; }
    if (st.sketch) { const p = skPt(x, y); if (p) tool.current.up(p, x, y, d.ctrl); rerender(); return; }
    if (d.comp && d.moved) { pmBus.dragEnd?.(); return; }
    if (d.moved) { const sels = e.pickBox(d.x, d.y, x, y, x < d.x); if (sels.length) { if (st.pm && pmBus.pick) { sels.forEach(s2 => pmBus.pick!(s2, true)); } else useApp.setState({ selection: d.ctrl ? [...st.selection, ...sels] : sels }); } return; }
    handleClickPick(x, y, d.ctrl || d.shift);
  };
  const onWheel = (ev: React.WheelEvent) => { const [x, y] = local(ev); eng.current?.zoomAt(x, y, Math.pow(1.0015, ev.deltaY)); };
  const onDouble = (ev: React.MouseEvent) => {
    const st = useApp.getState();
    if (st.sketch) { tool.current.dblclick(); rerender(); return; }
    const [x, y] = local(ev); const sel = eng.current!.pick(x, y);
    if (sel?.kind === "feature") window.dispatchEvent(new CustomEvent("cad:editFeature", { detail: sel.id }));
  };

  // keyboard for sketch tool (typed input, escape)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const st = useApp.getState(); if (!st.sketch) return;
      if ((e.target as HTMLElement)?.tagName === "INPUT" || (e.target as HTMLElement)?.tagName === "SELECT" || (e.target as HTMLElement)?.tagName === "TEXTAREA") return;
      if (tool.current.key(e)) { e.preventDefault(); e.stopImmediatePropagation(); rerender(); }
    };
    window.addEventListener("keydown", onKey, true); return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  // ── overlay computations
  const e = eng.current;
  const proj = (sk: Sketch, p: Vec2): Vec2 => e ? e.project(toWorld(sk.plane, p[0], p[1])) : [0, 0];
  tool.current.dimHit = (raw: Vec2) => {
    if (!e || !ss) return null; const sp = proj(ss.sk, raw);
    for (const g of dimGlyphs.current) if (Math.hypot(g.x - sp[0], g.y - sp[1]) < g.r) return g.id;
    return null;
  };
  tool.current.onDimPlaced = (c: Constraint) => { if (!useApp.getState().options.inputDim) return; const sk = useApp.getState().sketch?.sk; if (!sk || !e) return; const pos = c.pos || [0, 0]; const sp = proj(sk, pos); setModify({ cid: c.id, x: sp[0], y: sp[1], val: fmt(c.value ?? 0, 3) }); };
  tool.current.boxSelect = (x0, y0, x1, y1, additive) => {
    const sk = useApp.getState().sketch?.sk; if (!sk || !e) return; const crossing = x1 < x0;
    const minx = Math.min(x0, x1), maxx = Math.max(x0, x1), miny = Math.min(y0, y1), maxy = Math.max(y0, y1);
    const ins = (p: Vec2) => { const q = proj(sk, p); return q[0] >= minx && q[0] <= maxx && q[1] >= miny && q[1] <= maxy; };
    const sels: Sel[] = [];
    for (const en of sk.entities) { const poly = sampleEntity(sk, en, 24); const r = crossing ? poly.some(ins) : poly.every(ins); if (r) sels.push({ kind: "sk", id: en.id }); }
    useApp.setState({ selection: additive ? [...useApp.getState().selection, ...sels] : sels });
  };
  const dimGlyphs = useRef<{ id: string; x: number; y: number; r: number }[]>([]);
  const overlay = useMemo(() => {
    if (!e || !ss) { dimGlyphs.current = []; return null; }
    const sk = ss.sk; const out: ReactNode[] = []; const glyphs: { id: string; x: number; y: number; r: number }[] = [];
    const selKeys = new Set(s.selection.map(selKey));
    const bad = ss.solve?.bad || new Set<string>();
    const unitS = 1;
    const cs = sk.constraints.filter(c => DIM_TYPES.has(c.type));
    const ov = tool.current.overlay();
    const all = ov.dimPreview ? [...cs, { ...ov.dimPreview, id: "__preview" }] : cs;
    for (const c of all) {
      const el = renderDim(c, sk, p => proj(sk, p), unitS, { selected: selKeys.has(`skc:${c.id}`), bad: bad.has(c.id), preview: c.id === "__preview", onDbl: (x, y) => setModify({ cid: c.id, x, y, val: fmt(c.value ?? 0, 3) }), onDown: (x, y) => glyphs.push({ id: c.id, x, y, r: 16 }) });
      if (el) out.push(el);
    }
    // relation glyphs
    if (s.options.showRelations) {
      const stack: Record<string, number> = {};
      for (const c of sk.constraints) {
        if (DIM_TYPES.has(c.type)) continue;
        const anchors = relAnchors(sk, c);
        for (const a of anchors) {
          const sp = proj(sk, a); const key = `${Math.round(sp[0] / 6)},${Math.round(sp[1] / 6)}`; const k = (stack[key] = (stack[key] || 0) + 1);
          const x = sp[0] + 8 + (k - 1) * 15, y = sp[1] + 8;
          const sel = selKeys.has(`skc:${c.id}`);
          glyphs.push({ id: c.id, x: x + 6, y: y + 6, r: 8 });
          out.push(<g key={c.id + a.join()} className="rel-glyph"><rect x={x} y={y} width={13} height={13} rx={2} fill={sel ? "#1f9e4a" : bad.has(c.id) ? "#d01818" : "#3d8a3d"} opacity={0.9} /><text x={x + 6.5} y={y + 10} textAnchor="middle" fontSize={10} fill="#fff" fontWeight={700}>{REL_GLYPH[c.type] || "?"}</text></g>);
        }
      }
    }
    dimGlyphs.current = glyphs;
    // label near cursor
    if (ov.label) { const sp = proj(sk, ov.label.at); out.push(<g key="lbl"><rect x={sp[0] + 14} y={sp[1] + 10} width={ov.label.text.length * 6.6 + 8} height={17} fill="#fffbe6" stroke="#c9b458" rx={2} /><text x={sp[0] + 18} y={sp[1] + 22} fontSize={11} fill="#333">{ov.label.text}</text></g>); }
    if (ov.snap?.kind && ov.snap.kind !== "grid") { const sp = proj(sk, ov.snap.p); out.push(<text key="snapk" x={sp[0] + 10} y={sp[1] - 8} fontSize={10} fill="#d97706">{SNAP_ICON[ov.snap.kind] || ""}</text>); }
    if (ov.box) { const [x0, y0, x1, y1] = ov.box; out.push(<rect key="box" x={Math.min(x0, x1)} y={Math.min(y0, y1)} width={Math.abs(x1 - x0)} height={Math.abs(y1 - y0)} fill={x1 < x0 ? "rgba(40,180,90,.12)" : "rgba(60,120,230,.12)"} stroke={x1 < x0 ? "#2a9" : "#37c"} strokeDasharray={x1 < x0 ? "4 3" : undefined} />); }
    return out;
  }, [e, ss, s.selection, tool.current.version, s.options.showRelations, s.viewCmd.seq, setTick, e?.halfH, e?.target.x, e?.target.y, e?.target.z, e?.camera.quaternion.x, e?.camera.quaternion.y, e?.camera.quaternion.w]);

  const typed = ss ? tool.current.overlay().typed : null;
  const typedPos = typed && e && ss ? proj(ss.sk, typed.at) : null;

  // triad
  const triad = e ? (() => { const { r, u } = e.camAxes(); const ax: [string, Vec3, string][] = [["X", [1, 0, 0], "#d22"], ["Y", [0, 1, 0], "#2a2"], ["Z", [0, 0, 1], "#22d"]]; return ax.map(([n, v, c]) => ({ n, c, x: (v[0] * r.x + v[1] * r.y + v[2] * r.z) * 30, y: -(v[0] * u.x + v[1] * u.y + v[2] * u.z) * 30 })); })() : [];

  const applyModify = () => {
    if (!modify) return; const st = useApp.getState(); const sk = st.sketch?.sk; if (!sk) return setModify(null);
    const v = evalExpr(modify.val); if (v === null || v <= 0 && !sk.constraints.find(c => c.id === modify.cid)?.type.includes("angle")) { st.showToast("Enter a valid positive value"); return; }
    const n = { ...sk, constraints: sk.constraints.map(c => c.id === modify.cid ? { ...c, value: v } : c) };
    const r = solveSketch(n);
    if (!r.ok) { st.showToast("Cannot solve: the sketch would be over defined / impossible"); setModify(null); return; }
    st.skSet(n, { force: true }); setModify(null);
  };

  const editingLabel = ss ? `Editing ${ss.name}` : s.pm?.editId ? `Editing ${s.pm.draft.name}` : asm ? `Editing Assembly` : "";
  const cursorCls = s.cursor === "zoomArea" ? "cur-zoom" : ss && ss.tool !== "select" ? "cur-pencil" : s.pendingPick ? "cur-pick" : "";

  return (
    <div className={`viewport scene-${s.display.scene} ${cursorCls}`} ref={host} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onWheel={onWheel} onDoubleClick={onDouble} onContextMenu={ev => ev.preventDefault()}>
      <svg className="vp-overlay">
        {overlay}
        {dragBox && <rect x={Math.min(dragBox[0], dragBox[2])} y={Math.min(dragBox[1], dragBox[3])} width={Math.abs(dragBox[2] - dragBox[0])} height={Math.abs(dragBox[3] - dragBox[1])} fill={dragBox[2] < dragBox[0] ? "rgba(40,180,90,.12)" : "rgba(60,120,230,.12)"} stroke={dragBox[2] < dragBox[0] ? "#2a9" : "#37c"} strokeDasharray={dragBox[2] < dragBox[0] ? "4 3" : undefined} />}
      </svg>
      {s.display.triad && <svg className="triad" width={90} height={90} viewBox="-45 -45 90 90">
        {triad.map(t => <g key={t.n} className="triad-axis" onPointerDown={ev => { ev.stopPropagation(); useApp.getState().cmd(t.n === "X" ? "right" : t.n === "Y" ? "top" : "front"); }}><line x1={0} y1={0} x2={t.x} y2={t.y} stroke={t.c} strokeWidth={2.5} /><circle cx={t.x * 1.18} cy={t.y * 1.18} r={7} fill="#fff" stroke={t.c} /><text x={t.x * 1.18} y={t.y * 1.18 + 3.5} textAnchor="middle" fontSize={9} fontWeight={700} fill={t.c}>{t.n}</text></g>)}
      </svg>}
      {editingLabel && <div className="editing-label">{editingLabel}</div>}
      {(ss || s.pm) && <div className="confirm-corner" onPointerDown={ev => ev.stopPropagation()}>
        <button title="OK (exit / accept)" className="ok" onClick={() => ss && !s.pm ? useApp.getState().exitSketch(true) : window.dispatchEvent(new CustomEvent("cad:pm", { detail: "ok" }))}>✔</button>
        <button title="Cancel" className="cancel" onClick={() => ss && !s.pm ? useApp.getState().exitSketch(false) : window.dispatchEvent(new CustomEvent("cad:pm", { detail: "cancel" }))}>✖</button>
      </div>}
      {s.pendingPick === "sketchPlane" && <div className="vp-prompt">Select a plane or a planar face on which to create a sketch.</div>}
      {typed && typedPos && <div className="typed-box" style={{ left: typedPos[0] + 16, top: typedPos[1] + 30 }} onPointerDown={ev => ev.stopPropagation()}>
        {typed.fields.map((f, i) => <div key={f} className={i === typed.active ? "active" : ""}><span>{f}</span><b>{typed.values[i] || "…"}</b></div>)}
        <small>Tab: next · Enter: apply</small>
      </div>}
      {modify && <div className="modify-box" style={{ left: modify.x - 70, top: modify.y + 12 }} onPointerDown={ev => ev.stopPropagation()}>
        <div className="mb-title">Modify</div>
        <div className="mb-row"><input autoFocus value={modify.val} onChange={ev => setModify({ ...modify, val: ev.target.value })} onKeyDown={ev => { if (ev.key === "Enter") applyModify(); if (ev.key === "Escape") setModify(null); ev.stopPropagation(); }} onFocus={ev => ev.target.select()} /></div>
        <div className="mb-btns"><button onClick={applyModify} title="Accept">✔</button><button onClick={() => setModify(null)} title="Cancel">✖</button></div>
      </div>}
      {!s.activeId && <div className="vp-empty"><h2>OpenWorks CAD</h2><p>Create a new document to begin.</p>
        <div className="vp-empty-btns"><button onClick={() => useApp.getState().newDoc("part")}>▣ New Part</button><button onClick={() => useApp.getState().newDoc("assembly")}>⧉ New Assembly</button><button onClick={() => useApp.getState().newDoc("drawing")}>▤ New Drawing</button><button onClick={() => window.dispatchEvent(new CustomEvent("cad:sample"))}>★ Open sample bracket</button></div></div>}
      {s.building && <div className="building">Rebuilding…</div>}
    </div>
  );
}

const REL_GLYPH: Record<string, string> = { horizontal: "—", vertical: "|", parallel: "∥", perpendicular: "⊥", equal: "=", tangent: "◠", coincident: "•", pointOnLine: "◦", pointOnCircle: "◦", midpoint: "M", concentric: "◎", fix: "⚓", collinear: "⋯", symmetric: "⇆", hpoints: "—", vpoints: "|", coradial: "◎" };
const SNAP_ICON: Record<string, string> = { point: "● endpoint", origin: "⊕ origin", mid: "◆ midpoint", edge: "◦ on entity", horizontal: "— horizontal", vertical: "| vertical", intersection: "✕ intersection" };

function relAnchors(sk: Sketch, c: Constraint): Vec2[] {
  const P = (id: string): Vec2 | null => sk.points[id] ? [sk.points[id].x, sk.points[id].y] : null;
  const ent = (id: string) => sk.entities.find(e => e.id === id);
  const mid = (id: string): Vec2 | null => {
    const e = ent(id); if (!e) return P(id);
    if (e.type === "line") { const a = P(e.p1)!, b = P(e.p2)!; return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]; }
    if (e.type === "circle") { const cc = P(e.c)!; return [cc[0] + e.r * 0.707, cc[1] + e.r * 0.707]; }
    if (e.type === "arc") { const { c: cc, r, a1, sw } = arcAngles(sk, e); return [cc[0] + r * Math.cos(a1 + sw / 2), cc[1] + r * Math.sin(a1 + sw / 2)]; }
    const s = sampleEntity(sk, e); return s[Math.floor(s.length / 2)];
  };
  if (["coincident", "pointOnLine", "pointOnCircle", "midpoint"].includes(c.type)) { const p = P(c.refs[0]); return p ? [p] : []; }
  if (c.type === "concentric" || c.type === "coradial") { const e = ent(c.refs[0]) as any; const p = e?.c ? P(e.c) : null; return p ? [p] : []; }
  if (c.type === "symmetric") return c.refs.slice(0, 2).map(mid).filter(Boolean) as Vec2[];
  return c.refs.slice(0, 2).map(mid).filter(Boolean) as Vec2[];
}

function arrow(x: number, y: number, dx: number, dy: number, color: string, key: string) {
  const L = Math.hypot(dx, dy) || 1; const ux = dx / L, uy = dy / L; const s = 8, w = 3;
  return <path key={key} d={`M${x},${y} L${x - ux * s - uy * w},${y - uy * s + ux * w} L${x - ux * s + uy * w},${y - uy * s - ux * w} Z`} fill={color} />;
}

function renderDim(c: Constraint, sk: Sketch, pr: (p: Vec2) => Vec2, _u: number, o: { selected: boolean; bad: boolean; preview: boolean; onDbl: (x: number, y: number) => void; onDown: (x: number, y: number) => void }): ReactNode {
  const P = (id: string): Vec2 => [sk.points[id]?.x ?? 0, sk.points[id]?.y ?? 0];
  const ent = (id: string) => sk.entities.find(e => e.id === id) as any;
  const color = o.selected ? "#1f9e4a" : o.bad ? "#d01818" : o.preview ? "#2563eb" : "#4a4a4a";
  const pos = c.pos || [0, 0]; const T = pr(pos);
  const parts: ReactNode[] = []; let text = fmt(c.value ?? 0, 2);
  const line = (a: Vec2, b: Vec2, k: string, dash = false) => { const A = pr(a), B = pr(b); parts.push(<line key={k} x1={A[0]} y1={A[1]} x2={B[0]} y2={B[1]} stroke={color} strokeWidth={1} strokeDasharray={dash ? "3 2" : undefined} />); return [A, B]; };
  const dimLine = (a: Vec2, b: Vec2) => { const [A, B] = line(a, b, "dl"); parts.push(arrow(A[0], A[1], A[0] - B[0], A[1] - B[1], color, "a1"), arrow(B[0], B[1], B[0] - A[0], B[1] - A[1], color, "a2")); };
  try {
    const [r0, r1] = c.refs;
    if (c.type === "distance" || c.type === "hdistance" || c.type === "vdistance") {
      let A: Vec2, B: Vec2;
      if (r1 === undefined && ent(r0)?.type === "line") { A = P(ent(r0).p1); B = P(ent(r0).p2); } else { A = P(r0); B = P(r1); }
      if (c.type === "hdistance") { const a2: Vec2 = [A[0], pos[1]], b2: Vec2 = [B[0], pos[1]]; line(A, a2, "e1"); line(B, b2, "e2"); dimLine(a2, b2); }
      else if (c.type === "vdistance") { const a2: Vec2 = [pos[0], A[1]], b2: Vec2 = [pos[0], B[1]]; line(A, a2, "e1"); line(B, b2, "e2"); dimLine(a2, b2); }
      else { const dx = B[0] - A[0], dy = B[1] - A[1]; const L = Math.hypot(dx, dy) || 1; const n: Vec2 = [-dy / L, dx / L]; const off = (pos[0] - A[0]) * n[0] + (pos[1] - A[1]) * n[1]; const a2: Vec2 = [A[0] + n[0] * off, A[1] + n[1] * off], b2: Vec2 = [B[0] + n[0] * off, B[1] + n[1] * off]; line(A, a2, "e1"); line(B, b2, "e2"); dimLine(a2, b2); }
    } else if (c.type === "pointLineDistance" || c.type === "lineLineDistance") {
      const l = ent(c.type === "pointLineDistance" ? r1 : r0); const q = c.type === "pointLineDistance" ? P(r0) : P(ent(r1).p1);
      const a = P(l.p1), b = P(l.p2); const dx = b[0] - a[0], dy = b[1] - a[1]; const L2 = dx * dx + dy * dy || 1; const t = ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / L2; const F: Vec2 = [a[0] + t * dx, a[1] + t * dy];
      const u: Vec2 = [dx / Math.sqrt(L2), dy / Math.sqrt(L2)]; const sh = (pos[0] - q[0]) * u[0] + (pos[1] - q[1]) * u[1];
      const q2: Vec2 = [q[0] + u[0] * sh, q[1] + u[1] * sh], F2: Vec2 = [F[0] + u[0] * sh, F[1] + u[1] * sh]; line(q, q2, "e1"); line(F, F2, "e2"); dimLine(q2, F2);
    } else if (c.type === "radius" || c.type === "diameter") {
      const e = ent(r0); const C = P(e.c); const r = e.type === "circle" ? e.r : Math.hypot(P(e.p1)[0] - C[0], P(e.p1)[1] - C[1]);
      const d = [pos[0] - C[0], pos[1] - C[1]]; const L = Math.hypot(d[0], d[1]) || 1; const u: Vec2 = [d[0] / L, d[1] / L];
      const tip: Vec2 = [C[0] + u[0] * r, C[1] + u[1] * r]; const start: Vec2 = c.type === "diameter" ? [C[0] - u[0] * r, C[1] - u[1] * r] : C;
      const [S, Tp] = line(start, L > r ? pos : tip, "rl"); void S;
      const TP = pr(tip); parts.push(arrow(TP[0], TP[1], TP[0] - pr(C)[0], TP[1] - pr(C)[1], color, "ra"));
      if (c.type === "diameter") { const SP = pr(start); parts.push(arrow(SP[0], SP[1], SP[0] - pr(C)[0], SP[1] - pr(C)[1], color, "rb")); }
      void Tp; text = (c.type === "diameter" ? "Ø" : "R") + text;
    } else if (c.type === "angle") {
      const l1 = ent(r0), l2 = ent(r1); const a = P(l1.p1), b = P(l1.p2), p = P(l2.p1), q = P(l2.p2);
      const r = [b[0] - a[0], b[1] - a[1]], s2 = [q[0] - p[0], q[1] - p[1]]; const den = r[0] * s2[1] - r[1] * s2[0];
      let V: Vec2 = a; if (Math.abs(den) > 1e-12) { const t = ((p[0] - a[0]) * s2[1] - (p[1] - a[1]) * s2[0]) / den; V = [a[0] + t * r[0], a[1] + t * r[1]]; }
      const R = Math.hypot(pos[0] - V[0], pos[1] - V[1]) || 10; const a1 = Math.atan2(r[1], r[0]); const sw = (c.sign ?? 1) * (c.value ?? 0) * Math.PI / 180;
      const pts: Vec2[] = Array.from({ length: 25 }, (_, i) => pr([V[0] + R * Math.cos(a1 + sw * i / 24), V[1] + R * Math.sin(a1 + sw * i / 24)]));
      parts.push(<polyline key="arc" points={pts.map(p2 => p2.join(",")).join(" ")} fill="none" stroke={color} />);
      parts.push(arrow(pts[0][0], pts[0][1], pts[0][0] - pts[1][0], pts[0][1] - pts[1][1], color, "aa"), arrow(pts[24][0], pts[24][1], pts[24][0] - pts[23][0], pts[24][1] - pts[23][1], color, "ab"));
      text += "°";
    }
  } catch { return null; }
  if (!o.preview) o.onDown(T[0], T[1]);
  const w = text.length * 7 + 8;
  return <g key={c.id} className={o.preview ? "dim preview" : "dim"}>
    {parts}
    <rect x={T[0] - w / 2} y={T[1] - 9} width={w} height={17} fill="rgba(255,255,255,.85)" rx={2} stroke={o.selected ? color : "none"} />
    <text x={T[0]} y={T[1] + 4} textAnchor="middle" fontSize={12} fill={color} style={{ pointerEvents: o.preview ? "none" : "all", cursor: "pointer" }} onDoubleClick={ev => { ev.stopPropagation(); o.onDbl(T[0], T[1]); }}>{text}</text>
  </g>;
}
