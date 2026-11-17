import * as THREE from "three";
import type { MeshData, PlaneDef, Vec3, Vec2, Sketch, Appearance } from "../types";
import type { Sel, DisplayState } from "../store";
import { sampleEntity } from "../sketch/geom";
import { toWorld } from "../math";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";

export interface Body {
  group: THREE.Group; mesh: THREE.Mesh; edges: THREE.LineSegments; hidden: THREE.LineSegments;
  faceOfTri: Int32Array; data: MeshData; edgeOfSeg: Int32Array; compId?: string;
}

const V = (a: Vec3) => new THREE.Vector3(a[0], a[1], a[2]);
export const SEL_COLOR = 0x1f9e4a, HOVER_COLOR = 0x3f8cff;

export class Engine {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera: THREE.OrthographicCamera;
  target = new THREE.Vector3();
  halfH = 120;
  container: HTMLDivElement;
  needs = true; raf = 0;
  onCamera?: () => void;
  // groups
  modelG = new THREE.Group(); previewG = new THREE.Group(); refG = new THREE.Group(); sketchG = new THREE.Group();
  activeSkG = new THREE.Group(); hlG = new THREE.Group(); asmG = new THREE.Group(); gridG = new THREE.Group(); capG = new THREE.Group(); miscG = new THREE.Group();
  body: Body | null = null;
  comps: Body[] = [];
  style: DisplayState["style"] = "shadedEdges";
  planeObjs: { id: string; plane: PlaneDef; size: number; mesh: THREE.Object3D }[] = [];
  sketchObjs: { id: string; sk: Sketch; pts: Vec3[][] }[] = [];
  axisObjs: { id: string; o: Vec3; d: Vec3 }[] = [];
  clip: THREE.Plane | null = null;
  anim: { t0: number; dur: number; q0: THREE.Quaternion; q1: THREE.Quaternion; t0v: THREE.Vector3; t1v: THREE.Vector3; h0: number; h1: number } | null = null;
  prevViews: { q: THREE.Quaternion; t: THREE.Vector3; h: number }[] = [];
  light1: THREE.DirectionalLight; light2: THREE.DirectionalLight;

  constructor(container: HTMLDivElement) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true, stencil: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    this.renderer.localClippingEnabled = true;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    container.appendChild(this.renderer.domElement);
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -50000, 50000);
    this.scene.add(this.camera);
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.25));
    const hemi = new THREE.HemisphereLight(0xffffff, 0x8a8f98, 0.35); this.scene.add(hemi);
    // headlight rig: lights AND their targets ride with the camera so shading is view-relative (like SolidWorks)
    const tgt = new THREE.Object3D(); tgt.position.set(0, 0, -1); this.camera.add(tgt);
    this.light1 = new THREE.DirectionalLight(0xffffff, 1.6); this.light1.position.set(0.55, 0.85, 0.35); this.light1.target = tgt; this.camera.add(this.light1);
    this.light2 = new THREE.DirectionalLight(0xffffff, 0.5); this.light2.position.set(-0.8, -0.35, 0.25); this.light2.target = tgt; this.camera.add(this.light2);
    try { const pm = new THREE.PMREMGenerator(this.renderer); this.scene.environment = pm.fromScene(new RoomEnvironment(), 0.04).texture; this.scene.environmentIntensity = 0.45; pm.dispose(); } catch { /* no env */ }
    for (const g of [this.gridG, this.modelG, this.asmG, this.capG, this.previewG, this.refG, this.sketchG, this.hlG, this.activeSkG, this.miscG]) this.scene.add(g);
    this.setStandard("iso", false);
    this.resize();
    const loop = () => { this.raf = requestAnimationFrame(loop); this.tick(); };
    loop();
  }
  dispose() { cancelAnimationFrame(this.raf); this.renderer.dispose(); this.renderer.domElement.remove(); }
  resize() {
    const w = this.container.clientWidth || 1, h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h, false); this.renderer.domElement.style.width = w + "px"; this.renderer.domElement.style.height = h + "px";
    this.updateCam(); this.needs = true;
  }
  get size() { return { w: this.container.clientWidth || 1, h: this.container.clientHeight || 1 }; }
  updateCam() {
    const { w, h } = this.size; const a = w / h;
    this.camera.left = -this.halfH * a; this.camera.right = this.halfH * a; this.camera.top = this.halfH; this.camera.bottom = -this.halfH;
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
    this.camera.position.copy(this.target).addScaledVector(fwd, -20000);
    this.camera.updateProjectionMatrix(); this.camera.updateMatrixWorld();
  }
  tick() {
    if (this.anim) {
      const k = Math.min(1, (performance.now() - this.anim.t0) / this.anim.dur); const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      this.camera.quaternion.slerpQuaternions(this.anim.q0, this.anim.q1, e);
      this.target.lerpVectors(this.anim.t0v, this.anim.t1v, e); this.halfH = this.anim.h0 + (this.anim.h1 - this.anim.h0) * e;
      if (k >= 1) this.anim = null; this.updateCam(); this.needs = true; this.onCamera?.();
    }
    if (!this.needs) return; this.needs = false;
    this.renderer.render(this.scene, this.camera);
  }
  request() { this.needs = true; }
  pushPrev() { this.prevViews.push({ q: this.camera.quaternion.clone(), t: this.target.clone(), h: this.halfH }); if (this.prevViews.length > 20) this.prevViews.shift(); }
  animateTo(q: THREE.Quaternion, t?: THREE.Vector3, h?: number, dur = 300) {
    this.pushPrev();
    this.anim = { t0: performance.now(), dur, q0: this.camera.quaternion.clone(), q1: q, t0v: this.target.clone(), t1v: t || this.target.clone(), h0: this.halfH, h1: h ?? this.halfH };
  }
  previousView() { const p = this.prevViews.pop(); if (!p) return; this.anim = { t0: performance.now(), dur: 300, q0: this.camera.quaternion.clone(), q1: p.q, t0v: this.target.clone(), t1v: p.t, h0: this.halfH, h1: p.h }; }
  static quatFor(dir: THREE.Vector3, up: THREE.Vector3) { const m = new THREE.Matrix4().lookAt(new THREE.Vector3(0, 0, 0), dir.clone().negate(), up); return new THREE.Quaternion().setFromRotationMatrix(m); }
  setStandard(name: string, animate = true) {
    const views: Record<string, [Vec3, Vec3]> = {
      front: [[0, 0, 1], [0, 1, 0]], back: [[0, 0, -1], [0, 1, 0]], left: [[-1, 0, 0], [0, 1, 0]], right: [[1, 0, 0], [0, 1, 0]],
      top: [[0, 1, 0], [0, 0, -1]], bottom: [[0, -1, 0], [0, 0, 1]], iso: [[1, 1, 1], [0, 1, 0]], trimetric: [[1, 0.75, 1.6], [0, 1, 0]], dimetric: [[1, 0.6, 1], [0, 1, 0]],
    };
    const v = views[name]; if (!v) return;
    // camera sits along dir looking toward target
    const dir = V(v[0]).normalize(); let up = V(v[1]);
    if (name === "iso" || name === "trimetric" || name === "dimetric") up = new THREE.Vector3(0, 1, 0);
    const q = Engine.quatFor(dir, up);
    if (animate) this.animateTo(q); else { this.camera.quaternion.copy(q); this.updateCam(); }
    this.needs = true;
  }
  normalTo(pl: PlaneDef, animate = true) {
    const q = Engine.quatFor(V(pl.n), V(pl.y));
    if (animate) this.animateTo(q); else { this.camera.quaternion.copy(q); this.updateCam(); }
  }
  camAxes() { const r = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion), u = new THREE.Vector3(0, 1, 0).applyQuaternion(this.camera.quaternion), f = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion); return { r, u, f }; }
  orbit(dx: number, dy: number) {
    const { r, u } = this.camAxes(); const s = 0.006;
    const q = new THREE.Quaternion().setFromAxisAngle(u, -dx * s).multiply(new THREE.Quaternion().setFromAxisAngle(r, -dy * s));
    this.camera.quaternion.premultiply(q).normalize(); this.updateCam(); this.needs = true; this.onCamera?.();
  }
  pan(dx: number, dy: number) {
    const { r, u } = this.camAxes(); const wpp = (2 * this.halfH) / this.size.h;
    this.target.addScaledVector(r, -dx * wpp).addScaledVector(u, dy * wpp); this.updateCam(); this.needs = true; this.onCamera?.();
  }
  zoomAt(px: number, py: number, f: number) {
    const { w, h } = this.size; const nx = (px / w) * 2 - 1, ny = -(py / h) * 2 + 1; const a = w / h; const { r, u } = this.camAxes();
    const W = this.target.clone().addScaledVector(r, nx * this.halfH * a).addScaledVector(u, ny * this.halfH);
    this.halfH = Math.max(0.05, Math.min(1e5, this.halfH * f));
    this.target.copy(W).addScaledVector(r, -nx * this.halfH * a).addScaledVector(u, -ny * this.halfH);
    this.updateCam(); this.needs = true; this.onCamera?.();
  }
  boundsOf(): THREE.Box3 {
    const box = new THREE.Box3();
    // visibility-aware (Box3.setFromObject ignores .visible, which would include hidden sketches/helpers)
    const walk = (o: THREE.Object3D) => {
      if (!o.visible || o.userData.noFit) return;
      const g = (o as any).geometry as THREE.BufferGeometry | undefined;
      if (g && !(o as any).isSprite) { if (!g.boundingBox) g.computeBoundingBox(); if (g.boundingBox && !g.boundingBox.isEmpty()) box.union(g.boundingBox.clone().applyMatrix4(o.matrixWorld)); }
      for (const c of o.children) walk(c);
    };
    for (const g of [this.modelG, this.asmG, this.sketchG, this.activeSkG, this.previewG]) { g.updateMatrixWorld(true); walk(g); }
    if (box.isEmpty()) box.set(new THREE.Vector3(-60, -60, -60), new THREE.Vector3(60, 60, 60));
    return box;
  }
  fit(animate = true, box?: THREE.Box3) {
    box = box || this.boundsOf(); const { r, u } = this.camAxes(); const { w, h } = this.size;
    const pts: THREE.Vector3[] = []; for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) pts.push(new THREE.Vector3(x, y, z));
    const xs = pts.map(p => p.dot(r)), ys = pts.map(p => p.dot(u));
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    const center = box.getCenter(new THREE.Vector3()); const f = new THREE.Vector3().crossVectors(r, u);
    const t = r.clone().multiplyScalar(cx).addScaledVector(u, cy).addScaledVector(f, center.dot(f));
    const hh = Math.max((Math.max(...ys) - Math.min(...ys)) / 2, (Math.max(...xs) - Math.min(...xs)) / 2 / (w / h)) * 1.25 + 1;
    if (animate) this.animateTo(this.camera.quaternion.clone(), t, hh); else { this.target.copy(t); this.halfH = hh; this.updateCam(); }
    this.needs = true;
  }
  zoomToBox(x0: number, y0: number, x1: number, y1: number) {
    const { w, h } = this.size; const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    const f = Math.max(Math.abs(x1 - x0) / w, Math.abs(y1 - y0) / h); if (f < 0.01) return;
    const { r, u } = this.camAxes(); const a = w / h; const nx = cx / w * 2 - 1, ny = -cy / h * 2 + 1;
    const t = this.target.clone().addScaledVector(r, nx * this.halfH * a).addScaledVector(u, ny * this.halfH);
    this.animateTo(this.camera.quaternion.clone(), t, this.halfH * f);
  }
  project(p: Vec3 | THREE.Vector3): Vec2 {
    const v = (Array.isArray(p) ? V(p) : p.clone()).project(this.camera); const { w, h } = this.size;
    return [(v.x + 1) / 2 * w, (1 - v.y) / 2 * h];
  }
  ray(px: number, py: number) {
    const { w, h } = this.size; const rc = new THREE.Raycaster();
    rc.setFromCamera(new THREE.Vector2(px / w * 2 - 1, -py / h * 2 + 1), this.camera); return rc;
  }
  planePoint(px: number, py: number, pl: PlaneDef): Vec2 | null {
    const rc = this.ray(px, py); const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(V(pl.n), V(pl.origin));
    const hit = rc.ray.intersectPlane(plane, new THREE.Vector3());
    if (!hit) { const d = rc.ray.origin.clone().sub(V(pl.origin)); return [d.dot(V(pl.x)), d.dot(V(pl.y))]; }
    const d = hit.sub(V(pl.origin)); return [d.dot(V(pl.x)), d.dot(V(pl.y))];
  }
  worldPerPixel() { return (2 * this.halfH) / this.size.h; }

  // ───────── bodies
  makeBody(data: MeshData, app: Appearance, compId?: string): Body {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(data.vertices, 3));
    g.setAttribute("normal", new THREE.BufferAttribute(data.normals, 3));
    g.setIndex(new THREE.BufferAttribute(data.triangles, 1));
    const mat = new THREE.MeshStandardMaterial({ color: new THREE.Color(app.color), metalness: app.metalness, roughness: app.roughness, transparent: app.opacity < 1, opacity: app.opacity, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(g, mat);
    const faceOfTri = new Int32Array(data.triangles.length / 3).fill(-1);
    for (const fg of data.faceGroups) for (let i = fg.start / 3; i < (fg.start + fg.count) / 3; i++) faceOfTri[i] = fg.faceId;
    const eg = new THREE.BufferGeometry(); eg.setAttribute("position", new THREE.BufferAttribute(data.lines, 3));
    const edges = new THREE.LineSegments(eg, new THREE.LineBasicMaterial({ color: 0x111111 }));
    const hidden = new THREE.LineSegments(eg, new THREE.LineDashedMaterial({ color: 0x7a7a7a, dashSize: 1.5, gapSize: 1, depthFunc: THREE.GreaterDepth, transparent: true, opacity: 0.8 }));
    hidden.computeLineDistances(); hidden.renderOrder = 2;
    const edgeOfSeg = new Int32Array(data.lines.length / 6).fill(-1);
    for (const gr of data.edgeGroups) for (let i = gr.start / 2; i < (gr.start + gr.count) / 2; i++) edgeOfSeg[i] = gr.edgeId;
    const group = new THREE.Group(); group.add(mesh, edges, hidden);
    const b: Body = { group, mesh, edges, hidden, faceOfTri, data, edgeOfSeg, compId };
    this.applyStyle(b, this.style);
    return b;
  }
  applyStyle(b: Body, style: DisplayState["style"]) {
    const m = b.mesh.material as THREE.MeshStandardMaterial;
    const shaded = style === "shaded" || style === "shadedEdges";
    m.colorWrite = shaded; m.depthWrite = style !== "wire"; b.mesh.visible = style !== "wire";
    b.edges.visible = style !== "shaded";
    (b.edges.material as THREE.LineBasicMaterial).depthTest = style !== "wire";
    (b.edges.material as THREE.LineBasicMaterial).color.set(style === "shadedEdges" ? 0x161616 : 0x000000);
    b.hidden.visible = style === "hlv";
    m.clippingPlanes = this.clip ? [this.clip] : null; (b.edges.material as any).clippingPlanes = m.clippingPlanes; (b.hidden.material as any).clippingPlanes = m.clippingPlanes;
    m.needsUpdate = true;
  }
  setStyle(style: DisplayState["style"]) { this.style = style; if (this.body) this.applyStyle(this.body, style); this.comps.forEach(c => this.applyStyle(c, style)); this.needs = true; }
  setModel(data: MeshData | null, app: Appearance) {
    this.modelG.clear(); this.body = null;
    if (data && data.vertices.length) { this.body = this.makeBody(data, app); this.modelG.add(this.body.group); }
    this.updateCap(); this.needs = true;
  }
  setPreview(data: MeshData | null, kind: "add" | "cut" | "result" | null) {
    this.previewG.clear();
    if (data && kind) {
      const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.BufferAttribute(data.vertices, 3)); g.setAttribute("normal", new THREE.BufferAttribute(data.normals, 3)); g.setIndex(new THREE.BufferAttribute(data.triangles, 1));
      const color = kind === "cut" ? 0xe0503c : 0xf2c230;
      const mesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color, transparent: true, opacity: kind === "result" ? 0.55 : 0.45, depthWrite: false, side: THREE.DoubleSide, roughness: 0.6 }));
      mesh.renderOrder = 5;
      const eg = new THREE.BufferGeometry(); eg.setAttribute("position", new THREE.BufferAttribute(data.lines, 3));
      const e = new THREE.LineSegments(eg, new THREE.LineBasicMaterial({ color: kind === "cut" ? 0x9a1c10 : 0x8a6a00, transparent: true, opacity: 0.8 })); e.renderOrder = 6;
      this.previewG.add(mesh, e);
    }
    this.needs = true;
  }
  setAssembly(items: { compId: string; data: MeshData; app: Appearance; pos: Vec3; quat: number[]; hidden?: boolean; transparent?: boolean }[]) {
    this.asmG.clear(); this.comps = [];
    for (const it of items) {
      const b = this.makeBody(it.data, it.transparent ? { ...it.app, opacity: 0.35 } : it.app, it.compId);
      b.group.position.set(...it.pos); b.group.quaternion.set(it.quat[0], it.quat[1], it.quat[2], it.quat[3]);
      b.group.visible = !it.hidden; b.group.userData.compId = it.compId;
      this.asmG.add(b.group); this.comps.push(b);
    }
    this.updateCap(); this.needs = true;
  }
  updateCompTransform(compId: string, pos: Vec3, quat: number[]) { const b = this.comps.find(c => c.compId === compId); if (b) { b.group.position.set(...pos); b.group.quaternion.set(quat[0], quat[1], quat[2], quat[3]); this.needs = true; } }

  // ───────── section (clipping + stencil caps)
  setSection(on: boolean, pl?: PlaneDef, offset = 0, flip = false) {
    if (on && pl) { const n = V(pl.n).multiplyScalar(flip ? 1 : -1); this.clip = new THREE.Plane(n, 0); this.clip.constant = (flip ? -1 : 1) * (offset + V(pl.origin).dot(V(pl.n))); }
    else this.clip = null;
    if (this.body) this.applyStyle(this.body, this.style); this.comps.forEach(c => this.applyStyle(c, this.style));
    this.updateCap(); this.needs = true;
  }
  updateCap() {
    this.capG.clear(); if (!this.clip) return;
    const bodies = [this.body, ...this.comps].filter(Boolean) as Body[];
    bodies.forEach((b, i) => {
      const base = { depthWrite: false, depthTest: false, colorWrite: false, stencilWrite: true, stencilFunc: THREE.AlwaysStencilFunc, clippingPlanes: [this.clip!] } as any;
      const back = new THREE.Mesh(b.mesh.geometry, new THREE.MeshBasicMaterial({ ...base, side: THREE.BackSide, stencilFail: THREE.IncrementWrapStencilOp, stencilZFail: THREE.IncrementWrapStencilOp, stencilZPass: THREE.IncrementWrapStencilOp }));
      const front = new THREE.Mesh(b.mesh.geometry, new THREE.MeshBasicMaterial({ ...base, side: THREE.FrontSide, stencilFail: THREE.DecrementWrapStencilOp, stencilZFail: THREE.DecrementWrapStencilOp, stencilZPass: THREE.DecrementWrapStencilOp }));
      for (const m of [back, front]) { m.renderOrder = 10 + i * 3; m.matrixAutoUpdate = false; m.matrix.copy(b.group.matrixWorld); }
      b.group.updateMatrixWorld(true); back.matrix.copy(b.mesh.matrixWorld); front.matrix.copy(b.mesh.matrixWorld);
      const capMat = new THREE.MeshStandardMaterial({ color: 0xd04a3a, metalness: 0.1, roughness: 0.7, stencilWrite: true, stencilRef: 0, stencilFunc: THREE.NotEqualStencilFunc, stencilFail: THREE.ReplaceStencilOp, stencilZFail: THREE.ReplaceStencilOp, stencilZPass: THREE.ReplaceStencilOp, side: THREE.DoubleSide });
      const capGeo = new THREE.PlaneGeometry(1e4, 1e4);
      const cap = new THREE.Mesh(capGeo, capMat); cap.renderOrder = 11 + i * 3;
      const p = this.clip!; cap.position.copy(p.normal.clone().multiplyScalar(-p.constant)); cap.lookAt(cap.position.clone().add(p.normal));
      cap.onAfterRender = (r) => r.clearStencil();
      this.capG.add(back, front, cap);
    });
  }

  // ───────── reference geometry
  setRefs(planes: { id: string; plane: PlaneDef; size: number; hl: number }[], showOrigin: boolean, axes: { id: string; o: Vec3; d: Vec3; hl: number }[]) {
    this.refG.clear(); this.planeObjs = []; this.axisObjs = [];
    for (const p of planes) {
      const s = p.size; const pl = p.plane;
      const corners = [[-s, -s], [s, -s], [s, s], [-s, s]].map(([u, v]) => V(toWorld(pl, u, v)));
      const g = new THREE.BufferGeometry().setFromPoints([corners[0], corners[1], corners[2], corners[0], corners[2], corners[3]]);
      const col = p.hl === 2 ? SEL_COLOR : p.hl === 1 ? HOVER_COLOR : 0x5b8bd0;
      const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: p.hl ? 0.22 : 0.1, side: THREE.DoubleSide, depthWrite: false }));
      const border = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(corners), new THREE.LineBasicMaterial({ color: p.hl ? col : 0x3e6fb5, transparent: true, opacity: 0.9 }));
      m.renderOrder = 3; border.renderOrder = 3;
      const grp = new THREE.Group(); grp.add(m, border); this.refG.add(grp);
      this.planeObjs.push({ id: p.id, plane: pl, size: s, mesh: grp });
    }
    if (showOrigin) {
      const L = this.halfH * 0.12; const mk = (d: Vec3, c: number) => { const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), V(d).multiplyScalar(L)]), new THREE.LineBasicMaterial({ color: c, depthTest: false })); l.renderOrder = 20; return l; };
      this.refG.add(mk([1, 0, 0], 0xd22), mk([0, 1, 0], 0x2a2), mk([0, 0, 1], 0x22d));
      const dot = new THREE.Points(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3()]), new THREE.PointsMaterial({ color: 0xc0392b, size: 7, sizeAttenuation: false, depthTest: false })); dot.renderOrder = 21; this.refG.add(dot);
    }
    for (const a of axes) {
      const L = Math.max(30, this.halfH * 0.6); const c = a.hl === 2 ? SEL_COLOR : a.hl === 1 ? HOVER_COLOR : 0x666666;
      const ln = new THREE.Line(new THREE.BufferGeometry().setFromPoints([V(a.o).addScaledVector(V(a.d), -L), V(a.o).addScaledVector(V(a.d), L)]), new THREE.LineDashedMaterial({ color: c, dashSize: 4, gapSize: 1.5, depthTest: false }));
      ln.computeLineDistances(); ln.renderOrder = 4; this.refG.add(ln); this.axisObjs.push(a);
    }
    this.needs = true;
  }
  setSketches(list: { id: string; sk: Sketch; hl: number }[]) {
    this.sketchG.clear(); this.sketchObjs = [];
    for (const it of list) {
      const pts: Vec3[][] = [];
      const pos: number[] = []; const cpos: number[] = [];
      for (const e of it.sk.entities) {
        const poly = sampleEntity(it.sk, e, 48).map(p => toWorld(it.sk.plane, p[0], p[1])); pts.push(poly);
        const arr = e.construction ? cpos : pos;
        for (let i = 0; i < poly.length - 1; i++) arr.push(...poly[i], ...poly[i + 1]);
      }
      const col = it.hl === 2 ? SEL_COLOR : it.hl === 1 ? HOVER_COLOR : 0x404a5a;
      if (pos.length) { const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); const l = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: col })); l.renderOrder = 4; this.sketchG.add(l); }
      if (cpos.length) { const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(cpos, 3)); const l = new THREE.LineSegments(g, new THREE.LineDashedMaterial({ color: col, dashSize: 3, gapSize: 2 })); l.computeLineDistances(); this.sketchG.add(l); }
      this.sketchObjs.push({ id: it.id, sk: it.sk, pts });
    }
    this.needs = true;
  }
  /** active sketch: entity color map provided by caller */
  setActiveSketch(sk: Sketch | null, colorOf: (id: string) => number, preview: { lines: Vec2[][]; pts: Vec2[]; dashed?: Vec2[][] } | null) {
    this.activeSkG.clear(); if (!sk) { this.needs = true; return; }
    const pl = sk.plane; const W = (p: Vec2) => toWorld(pl, p[0], p[1]);
    const byColor = new Map<string, { pos: number[]; dashed: boolean; color: number }>();
    for (const e of sk.entities) {
      if (e.type === "point") continue;
      const poly = sampleEntity(sk, e, 96).map(W); const color = colorOf(e.id); const key = color + (e.construction ? "d" : "s");
      const bucket = byColor.get(key) || { pos: [], dashed: !!e.construction, color }; byColor.set(key, bucket);
      for (let i = 0; i < poly.length - 1; i++) bucket.pos.push(...poly[i], ...poly[i + 1]);
    }
    for (const b of byColor.values()) {
      const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(b.pos, 3));
      const l = new THREE.LineSegments(g, b.dashed ? new THREE.LineDashedMaterial({ color: b.color, dashSize: this.halfH * 0.025, gapSize: this.halfH * 0.015, depthTest: false }) : new THREE.LineBasicMaterial({ color: b.color, depthTest: false }));
      if (b.dashed) l.computeLineDistances(); l.renderOrder = 30; this.activeSkG.add(l);
    }
    // points
    const used = new Set<string>();
    for (const e of sk.entities) { if (e.type === "line" || e.type === "arc") { used.add(e.p1); used.add(e.p2); } if (e.type === "arc" || e.type === "circle" || e.type === "ellipse") used.add(e.c); if (e.type === "spline") e.pts.forEach(p => used.add(p)); if (e.type === "point") used.add(e.p); }
    const byPC = new Map<number, number[]>();
    for (const id of used) { const p = sk.points[id]; if (!p) continue; const c = colorOf(id); const arr = byPC.get(c) || []; arr.push(...W([p.x, p.y])); byPC.set(c, arr); }
    for (const [c, arr] of byPC) { const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(arr, 3)); const pts = new THREE.Points(g, new THREE.PointsMaterial({ color: c, size: 5, sizeAttenuation: false, depthTest: false })); pts.renderOrder = 31; this.activeSkG.add(pts); }
    if (preview) {
      const pos: number[] = []; for (const poly of preview.lines) for (let i = 0; i < poly.length - 1; i++) pos.push(...W(poly[i]), ...W(poly[i + 1]));
      if (pos.length) { const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); const l = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0x1565ff, depthTest: false })); l.renderOrder = 32; this.activeSkG.add(l); }
      const dpos: number[] = []; for (const poly of preview.dashed || []) for (let i = 0; i < poly.length - 1; i++) dpos.push(...W(poly[i]), ...W(poly[i + 1]));
      if (dpos.length) { const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(dpos, 3)); const l = new THREE.LineSegments(g, new THREE.LineDashedMaterial({ color: 0x5c8fd6, dashSize: this.halfH * 0.02, gapSize: this.halfH * 0.015, depthTest: false })); l.computeLineDistances(); l.renderOrder = 32; this.activeSkG.add(l); }
      if (preview.pts.length) { const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(preview.pts.flatMap(p => W(p)), 3)); const pts = new THREE.Points(g, new THREE.PointsMaterial({ color: 0xff8c00, size: 8, sizeAttenuation: false, depthTest: false })); pts.renderOrder = 33; this.activeSkG.add(pts); }
    }
    this.needs = true;
  }
  setGrid(pl: PlaneDef | null, spacing: number) {
    this.gridG.clear(); if (!pl) { this.needs = true; return; }
    const ext = Math.max(200, Math.ceil(this.halfH * 3 / spacing) * spacing); const n = Math.min(400, Math.round(ext / spacing));
    const minor: number[] = [], major: number[] = [];
    for (let i = -n; i <= n; i++) { const arr = i % 5 === 0 ? major : minor; const v = i * spacing; arr.push(...toWorld(pl, -ext, v), ...toWorld(pl, ext, v), ...toWorld(pl, v, -ext), ...toWorld(pl, v, ext)); }
    const mk = (a: number[], c: number, o: number) => { const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(a, 3)); return new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: c, transparent: true, opacity: o, depthWrite: false })); };
    this.gridG.add(mk(minor, 0x7f95b3, 0.18), mk(major, 0x5d7395, 0.35)); this.needs = true;
  }

  // ───────── highlights
  setHighlights(sel: Sel[], hover: Sel | null) {
    this.hlG.clear();
    const add = (s: Sel, color: number) => {
      const body = (s as any).comp ? this.comps.find(c => c.compId === (s as any).comp) : this.body;
      if (s.kind === "comp") { const b = this.comps.find(c => c.compId === s.id); if (b) { const m = new THREE.Mesh(b.mesh.geometry, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.25, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 })); m.renderOrder = 7; const e = new THREE.LineSegments(b.edges.geometry, new THREE.LineBasicMaterial({ color })); const grp = new THREE.Group(); grp.add(m, e); grp.position.copy(b.group.position); grp.quaternion.copy(b.group.quaternion); this.hlG.add(grp); } return; }
      if (!body) return;
      const wrap = (o: THREE.Object3D) => { const grp = new THREE.Group(); grp.add(o); grp.position.copy(body.group.position); grp.quaternion.copy(body.group.quaternion); this.hlG.add(grp); };
      if (s.kind === "face") {
        const fg = body.data.faceGroups.find(f => f.faceId === s.index); if (!fg) return;
        const g = new THREE.BufferGeometry(); g.setAttribute("position", body.mesh.geometry.getAttribute("position")); g.setAttribute("normal", body.mesh.geometry.getAttribute("normal"));
        g.setIndex(new THREE.BufferAttribute(body.data.triangles.slice(fg.start, fg.start + fg.count), 1));
        const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.45, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, side: THREE.DoubleSide, clippingPlanes: this.clip ? [this.clip] : null }));
        m.renderOrder = 7; wrap(m);
      } else if (s.kind === "edge") {
        const groups = body.data.edgeGroups.filter(gp => gp.edgeId === s.index); const pos: number[] = [];
        for (const gp of groups) for (let i = gp.start; i < gp.start + gp.count; i++) pos.push(body.data.lines[i * 3], body.data.lines[i * 3 + 1], body.data.lines[i * 3 + 2]);
        const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
        const l = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color, depthTest: false, linewidth: 2 })); l.renderOrder = 8; wrap(l);
        // thick look: add a slightly offset second line set
        const l2 = l.clone(); l2.position.addScalar(this.worldPerPixel() * 0.6); wrap(l2);
      } else if (s.kind === "vertex") {
        const pts = new THREE.Points(new THREE.BufferGeometry().setFromPoints([V(s.point)]), new THREE.PointsMaterial({ color, size: 9, sizeAttenuation: false, depthTest: false })); pts.renderOrder = 9; this.hlG.add(pts);
      }
    };
    for (const s of sel) add(s, SEL_COLOR);
    if (hover && !sel.some(s => JSON.stringify(s) === JSON.stringify(hover))) add(hover, HOVER_COLOR);
    this.needs = true;
  }
  setMisc(objs: THREE.Object3D[]) { this.miscG.clear(); objs.forEach(o => this.miscG.add(o)); this.needs = true; }

  // ───────── picking
  pick(px: number, py: number, f: { faces?: boolean; edges?: boolean; vertices?: boolean; planes?: boolean; sketches?: boolean; axes?: boolean; origin?: boolean } = {}): Sel | null {
    const want = { faces: true, edges: true, vertices: true, planes: true, sketches: true, axes: true, origin: true, ...f };
    const bodies = [this.body, ...this.comps].filter(b => b && b.group.visible) as Body[];
    const rc = this.ray(px, py);
    // faces (find nearest hit)
    let faceHit: { b: Body; face: number; point: THREE.Vector3; dist: number; normal: THREE.Vector3 } | null = null;
    if (this.style !== "wire") for (const b of bodies) {
      const hits = rc.intersectObject(b.mesh, false).filter(h => !this.clip || this.clip.distanceToPoint(h.point) >= 0);
      if (hits.length && (!faceHit || hits[0].distance < faceHit.dist)) { const h = hits[0]; faceHit = { b, face: b.faceOfTri[h.faceIndex!], point: h.point, dist: h.distance, normal: h.face!.normal.clone().transformDirection(b.mesh.matrixWorld) }; }
    }
    const depthOk = (wp: THREE.Vector3) => { if (!faceHit || this.style === "wire" || this.style === "hlv") return true; const d = rc.ray.origin.distanceTo(wp); return d <= faceHit.dist + this.worldPerPixel() * 4; };
    // vertices & edges in screen space
    if (want.vertices || want.edges) {
      let bestV: { d: number; p: THREE.Vector3; b: Body } | null = null; let bestE: { d: number; e: number; b: Body; p: THREE.Vector3 } | null = null;
      const tmp = new THREE.Vector3(), tmp2 = new THREE.Vector3();
      for (const b of bodies) {
        const L = b.data.lines; const mw = b.group.matrixWorld;
        for (let s = 0; s < L.length / 6; s++) {
          tmp.set(L[s * 6], L[s * 6 + 1], L[s * 6 + 2]).applyMatrix4(mw); tmp2.set(L[s * 6 + 3], L[s * 6 + 4], L[s * 6 + 5]).applyMatrix4(mw);
          const a = this.project(tmp), c = this.project(tmp2);
          const dx = c[0] - a[0], dy = c[1] - a[1]; const ll = dx * dx + dy * dy; const t = ll ? Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / ll)) : 0;
          const d = Math.hypot(px - a[0] - t * dx, py - a[1] - t * dy);
          if (d < 6 && (!bestE || d < bestE.d)) { const wp = tmp.clone().lerp(tmp2, t); if (depthOk(wp)) bestE = { d, e: b.edgeOfSeg[s], b, p: wp }; }
        }
        if (want.vertices) for (const e of b.data.edges) for (const p of [e.a, e.b]) { if (!p) continue; const wp = V(p).applyMatrix4(mw); const sp = this.project(wp); const d = Math.hypot(sp[0] - px, sp[1] - py); if (d < 7 && (!bestV || d < bestV.d) && depthOk(wp)) bestV = { d, p: wp, b }; }
      }
      if (bestV && want.vertices) { const inv = bestV.b.group.matrixWorld.clone().invert(); void inv; return { kind: "vertex", point: [bestV.p.x, bestV.p.y, bestV.p.z], comp: bestV.b.compId }; }
      if (bestE && want.edges && bestE.e >= 0) { const lp = bestE.b.group.worldToLocal(bestE.p.clone()); const info = bestE.b.data.edges[bestE.e]; return { kind: "edge", index: bestE.e, point: info ? info.mid : [lp.x, lp.y, lp.z], comp: bestE.b.compId }; }
    }
    // sketches (screen distance)
    if (want.sketches) for (const so of this.sketchObjs) for (const poly of so.pts) for (let i = 0; i < poly.length - 1; i++) {
      const a = this.project(poly[i]), c = this.project(poly[i + 1]); const dx = c[0] - a[0], dy = c[1] - a[1]; const ll = dx * dx + dy * dy; const t = ll ? Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / ll)) : 0;
      if (Math.hypot(px - a[0] - t * dx, py - a[1] - t * dy) < 5) return { kind: "feature", id: so.id };
    }
    if (faceHit && want.faces && faceHit.face >= 0) {
      const info = faceHit.b.data.faces[faceHit.face];
      const lp = faceHit.b.group.worldToLocal(faceHit.point.clone());
      return { kind: "face", index: faceHit.face, point: info ? info.center : [lp.x, lp.y, lp.z], normal: info?.normal ?? [faceHit.normal.x, faceHit.normal.y, faceHit.normal.z], comp: faceHit.b.compId, hit: [lp.x, lp.y, lp.z] };
    }
    if (want.axes) for (const a of this.axisObjs) { const L = Math.max(30, this.halfH * 0.6); const p0 = this.project(V(a.o).addScaledVector(V(a.d), -L)), p1 = this.project(V(a.o).addScaledVector(V(a.d), L)); const dx = p1[0] - p0[0], dy = p1[1] - p0[1]; const ll = dx * dx + dy * dy; const t = ll ? Math.max(0, Math.min(1, ((px - p0[0]) * dx + (py - p0[1]) * dy) / ll)) : 0; if (Math.hypot(px - p0[0] - t * dx, py - p0[1] - t * dy) < 5) return { kind: "axis", id: a.id, axis: { o: a.o, d: a.d } }; }
    if (want.origin) { const o = this.project([0, 0, 0]); if (Math.hypot(o[0] - px, o[1] - py) < 7) return { kind: "origin" }; }
    if (want.planes) {
      for (const po of this.planeObjs) {
        // hit on border region or inside
        const pt = this.planePoint(px, py, po.plane); if (!pt) continue;
        const edgeDist = Math.min(po.size - Math.abs(pt[0]), po.size - Math.abs(pt[1]));
        if (edgeDist >= 0 && (edgeDist < this.worldPerPixel() * 8 || Math.abs(new THREE.Vector3(...po.plane.n).dot(this.camAxes().f)) > 0.3)) return { kind: "plane", id: po.id, plane: po.plane };
      }
    }
    return null;
  }
  pickBox(x0: number, y0: number, x1: number, y1: number, crossing: boolean): Sel[] {
    const minx = Math.min(x0, x1), maxx = Math.max(x0, x1), miny = Math.min(y0, y1), maxy = Math.max(y0, y1);
    const inside = (p: Vec2) => p[0] >= minx && p[0] <= maxx && p[1] >= miny && p[1] <= maxy;
    const out: Sel[] = [];
    const bodies = [this.body, ...this.comps].filter(Boolean) as Body[];
    for (const b of bodies) {
      const L = b.data.lines; const mw = b.group.matrixWorld; const tmp = new THREE.Vector3();
      const status = new Map<number, { any: boolean; all: boolean }>();
      for (let s = 0; s < L.length / 3; s++) { const e = b.edgeOfSeg[Math.floor(s / 2)]; const p = this.project(tmp.set(L[s * 3], L[s * 3 + 1], L[s * 3 + 2]).applyMatrix4(mw)); const ins = inside(p); const st = status.get(e) || { any: false, all: true }; st.any ||= ins; st.all &&= ins; status.set(e, st); }
      for (const [e, st] of status) if (e >= 0 && (crossing ? st.any : st.all)) out.push({ kind: "edge", index: e, point: b.data.edges[e]?.mid || [0, 0, 0], comp: b.compId });
    }
    return out;
  }
  screenshot(): string { this.renderer.render(this.scene, this.camera); return this.renderer.domElement.toDataURL("image/png"); }
}
