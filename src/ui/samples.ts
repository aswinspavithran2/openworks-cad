import type { Sketch, PlaneDef, PartDoc, Feature, AssemblyDoc } from "../types";
import { useApp, newPart, newAssembly, effectiveFeatures } from "../store";
import { PLANES, uid, offsetPlane } from "../math";
import { kernel } from "../kernel/client";

const emptySk = (plane: PlaneDef, label: string): Sketch => ({ id: uid("sk"), plane, planeLabel: label, points: { O: { id: "O", x: 0, y: 0, fixed: true } }, entities: [], constraints: [] });

/** Fully-defined center rectangle w×h (centered at cx,cy) */
export function centerRect(sk: Sketch, w: number, h: number, cx = 0, cy = 0, dims = true) {
  const id = (p: string) => uid(p);
  const c = [[cx - w / 2, cy - h / 2], [cx + w / 2, cy - h / 2], [cx + w / 2, cy + h / 2], [cx - w / 2, cy + h / 2]];
  const P = c.map(([x, y]) => { const k = id("p"); sk.points[k] = { id: k, x, y }; return k; });
  const L = [0, 1, 2, 3].map(i => ({ id: id("e"), type: "line" as const, p1: P[i], p2: P[(i + 1) % 4] }));
  const D = { id: id("e"), type: "line" as const, p1: P[0], p2: P[2], construction: true };
  sk.entities.push(...L, D);
  sk.constraints.push(
    { id: id("c"), type: "horizontal", refs: [L[0].id] }, { id: id("c"), type: "horizontal", refs: [L[2].id] },
    { id: id("c"), type: "vertical", refs: [L[1].id] }, { id: id("c"), type: "vertical", refs: [L[3].id] },
  );
  if (cx === 0 && cy === 0) sk.constraints.push({ id: id("c"), type: "midpoint", refs: ["O", D.id] });
  if (dims) {
    const n = sk.constraints.filter(k => k.name).length;
    sk.constraints.push({ id: id("c"), type: "hdistance", refs: [L[0].id], value: w, sign: 1, name: `D${n + 1}`, pos: [cx, cy - h / 2 - 12] });
    sk.constraints.push({ id: id("c"), type: "vdistance", refs: [L[1].id], value: h, sign: 1, name: `D${n + 2}`, pos: [cx + w / 2 + 14, cy] });
  }
  return { points: P, lines: L };
}
export function circleAt(sk: Sketch, cx: number, cy: number, d: number, dimFromOrigin = true) {
  const k = uid("p"); sk.points[k] = { id: k, x: cx, y: cy }; const e = { id: uid("e"), type: "circle" as const, c: k, r: d / 2 }; sk.entities.push(e);
  const n = sk.constraints.filter(q => q.name).length;
  sk.constraints.push({ id: uid("c"), type: "diameter", refs: [e.id], value: d, name: `D${n + 1}`, pos: [cx + d * 0.7, cy + d * 0.7] });
  if (dimFromOrigin) {
    sk.constraints.push({ id: uid("c"), type: "hdistance", refs: ["O", k], value: Math.abs(cx), sign: cx >= 0 ? 1 : -1, name: `D${n + 2}`, pos: [cx / 2, cy - d] });
    if (Math.abs(cy) < 1e-9) sk.constraints.push({ id: uid("c"), type: "hpoints", refs: ["O", k] });
    else sk.constraints.push({ id: uid("c"), type: "vdistance", refs: ["O", k], value: Math.abs(cy), sign: cy >= 0 ? 1 : -1, name: `D${n + 3}`, pos: [cx + d, cy / 2] });
  }
  return e;
}

/** The workflow example: 100×60 plate, 20 thick, R5 vertical-edge fillets, Ø15 through hole */
export async function makeSampleBracket() {
  const s = useApp.getState();
  const doc = newPart("Bracket");
  const sk1 = emptySk(PLANES.Top, "Top Plane"); centerRect(sk1, 100, 60);
  const f1: Feature = { id: uid("f"), type: "sketch", name: "Sketch1", params: {}, sketch: sk1 };
  const f2: Feature = { id: uid("f"), type: "extrude", name: "Boss-Extrude1", params: { sketchId: f1.id, end: "blind", depth: 20, reverse: false, offset: 0, dir2: { enabled: false, end: "blind", depth: 10 }, draft: { angle: 0, outward: false }, thin: { enabled: false, thickness: 1, side: "fwd" }, merge: true, contours: [] } };
  doc.features = [f1, f2]; doc.counters = { sketch: 1, extrude: 1 };
  doc.material = "6061-T6 (SS)"; doc.appearance = { color: "#cfd4da", metalness: 0.55, roughness: 0.35, opacity: 1 };
  s.addDoc(doc, true); useApp.setState({ cmTab: "Features", status: "Building sample bracket…" });
  try {
    const r = await kernel.build(effectiveFeatures(doc));
    const edges = (r.main?.edges || []).filter(e => e.type === "LINE" && e.a && e.b && Math.abs(Math.abs(e.b[1] - e.a[1]) - 20) < 1e-6 && Math.abs(e.b[0] - e.a[0]) < 1e-6 && Math.abs(e.b[2] - e.a[2]) < 1e-6);
    const f3: Feature = { id: uid("f"), type: "fillet", name: "Fillet1", params: { edges: edges.map(e => ({ kind: "edge", index: e.id, point: e.mid })), radius: 5, radius2: 2, ftype: "constant" } };
    const sk2 = emptySk(offsetPlane(PLANES.Top, 20, false, "Face<1>"), "Face<1>"); circleAt(sk2, 25, 0, 15);
    const f4: Feature = { id: uid("f"), type: "sketch", name: "Sketch2", params: {}, sketch: sk2 };
    const f5: Feature = { id: uid("f"), type: "cut", name: "Cut-Extrude1", params: { sketchId: f4.id, end: "throughAll", depth: 10, reverse: false, offset: 0, dir2: { enabled: false, end: "blind", depth: 10 }, draft: { angle: 0, outward: false }, thin: { enabled: false, thickness: 1, side: "fwd" }, flipSide: false, contours: [] } };
    useApp.getState().updateDoc(doc.id, (d: PartDoc) => ({ ...d, features: [...d.features, f3, f4, f5], counters: { sketch: 2, extrude: 1, fillet: 1, cut: 1 } }), false);
    useApp.setState({ status: "Sample bracket loaded — 100×60×20 plate, R5 fillets, Ø15 through hole" });
    setTimeout(() => useApp.getState().cmd("iso"), 50); setTimeout(() => useApp.getState().cmd("fit"), 900);
  } catch (e) { s.showToast("Sample build failed: " + (e as Error).message); }
  return doc.id;
}

/** sample: plate + pin assembly */
export function makeSampleAssembly() {
  const s = useApp.getState();
  const plate = newPart("Plate"); const sk = emptySk(PLANES.Top, "Top Plane"); centerRect(sk, 80, 50); circleAt(sk, 0, 0, 12);
  plate.features = [{ id: uid("f"), type: "sketch", name: "Sketch1", params: {}, sketch: sk }]; plate.features.push({ id: uid("f"), type: "extrude", name: "Boss-Extrude1", params: { sketchId: plate.features[0].id, end: "blind", depth: 10, offset: 0, dir2: { enabled: false }, draft: { angle: 0 }, thin: { enabled: false }, merge: true, contours: [] } }); plate.counters = { sketch: 1, extrude: 1 };
  const pin = newPart("Pin"); const sk2 = emptySk(PLANES.Top, "Top Plane"); circleAt(sk2, 0, 0, 12, false);
  pin.features = [{ id: uid("f"), type: "sketch", name: "Sketch1", params: {}, sketch: sk2 }]; pin.features.push({ id: uid("f"), type: "extrude", name: "Boss-Extrude1", params: { sketchId: pin.features[0].id, end: "blind", depth: 40, offset: 0, dir2: { enabled: false }, draft: { angle: 0 }, thin: { enabled: false }, merge: true, contours: [] } }); pin.counters = { sketch: 1, extrude: 1 };
  pin.appearance = { color: "#d6b04c", metalness: 0.9, roughness: 0.2, opacity: 1 }; pin.material = "Brass";
  s.addDoc(plate, false); s.addDoc(pin, false);
  const a: AssemblyDoc = newAssembly("PinAssembly");
  a.components = [
    { id: uid("c"), partId: plate.id, name: "Plate", instance: 1, t: { p: [0, 0, 0], q: [0, 0, 0, 1] }, fixed: true },
    { id: uid("c"), partId: pin.id, name: "Pin", instance: 1, t: { p: [60, 25, 30], q: [0, 0, 0, 1] }, fixed: false },
  ];
  s.addDoc(a, true); useApp.setState({ cmTab: "Assembly", status: "Sample assembly: use Mate → select the pin's cylinder and the plate's hole → Concentric" });
  setTimeout(() => useApp.getState().cmd("iso"), 50); setTimeout(() => useApp.getState().cmd("fit"), 1200);
}
