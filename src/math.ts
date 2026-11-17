import type { Vec3, Vec2, PlaneDef } from "./types";

export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const mul = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
export const norm = (a: Vec3): Vec3 => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
export const dist3 = (a: Vec3, b: Vec3) => len(sub(a, b));
export const d2 = (a: Vec2, b: Vec2) => Math.hypot(a[0] - b[0], a[1] - b[1]);

export const PLANES: Record<string, PlaneDef> = {
  Front: { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], n: [0, 0, 1], name: "Front Plane" },
  Top: { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 0, -1], n: [0, 1, 0], name: "Top Plane" },
  Right: { origin: [0, 0, 0], x: [0, 0, -1], y: [0, 1, 0], n: [1, 0, 0], name: "Right Plane" },
};

export const toWorld = (pl: PlaneDef, u: number, v: number): Vec3 => [
  pl.origin[0] + pl.x[0] * u + pl.y[0] * v,
  pl.origin[1] + pl.x[1] * u + pl.y[1] * v,
  pl.origin[2] + pl.x[2] * u + pl.y[2] * v,
];
export const toLocal = (pl: PlaneDef, p: Vec3): Vec2 => { const r = sub(p, pl.origin); return [dot(r, pl.x), dot(r, pl.y)]; };

/** Build a plane from origin + normal, choosing a sensible x direction (SolidWorks-like). */
export function planeFromNormal(origin: Vec3, n: Vec3, name?: string): PlaneDef {
  n = norm(n);
  let x: Vec3;
  if (Math.abs(n[1]) > 0.9) x = [1, 0, 0];
  else x = norm(cross([0, 1, 0], n));
  const y = norm(cross(n, x));
  return { origin, x, y, n, name };
}
export function offsetPlane(pl: PlaneDef, d: number, flip = false, name?: string): PlaneDef {
  const n = flip ? mul(pl.n, -1) : pl.n;
  const x = flip ? mul(pl.x, -1) : pl.x;
  return { origin: add(pl.origin, mul(pl.n, d)), x, y: pl.y, n, name };
}
export function rotateAround(v: Vec3, axis: Vec3, ang: number): Vec3 {
  const k = norm(axis), c = Math.cos(ang), s = Math.sin(ang);
  return add(add(mul(v, c), mul(cross(k, v), s)), mul(k, dot(k, v) * (1 - c)));
}

// Quaternion helpers (x,y,z,w)
export type Quat = [number, number, number, number];
export const qIdent: Quat = [0, 0, 0, 1];
export function qMul(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a, [bx, by, bz, bw] = b;
  return [aw * bx + ax * bw + ay * bz - az * by, aw * by - ax * bz + ay * bw + az * bx, aw * bz + ax * by - ay * bx + az * bw, aw * bw - ax * bx - ay * by - az * bz];
}
export function qFromAxisAngle(axis: Vec3, ang: number): Quat { const k = norm(axis), s = Math.sin(ang / 2); return [k[0] * s, k[1] * s, k[2] * s, Math.cos(ang / 2)]; }
export function qRotate(q: Quat, v: Vec3): Vec3 {
  const [x, y, z, w] = q; const u: Vec3 = [x, y, z];
  const t = mul(cross(u, v), 2);
  return add(add(v, mul(t, w)), cross(u, t));
}
export function qFromTo(a: Vec3, b: Vec3): Quat {
  a = norm(a); b = norm(b); const d = dot(a, b);
  if (d > 0.999999) return [0, 0, 0, 1];
  if (d < -0.999999) { let ax = cross([1, 0, 0], a); if (len(ax) < 1e-6) ax = cross([0, 1, 0], a); return qFromAxisAngle(ax, Math.PI); }
  const c = cross(a, b); const q: Quat = [c[0], c[1], c[2], 1 + d]; const l = Math.hypot(...q); return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}
export function qToAxisAngle(q: Quat): { axis: Vec3; angle: number } {
  const w = Math.max(-1, Math.min(1, q[3])); const angle = 2 * Math.acos(w); const s = Math.sqrt(1 - w * w);
  if (s < 1e-9) return { axis: [1, 0, 0], angle: 0 };
  return { axis: [q[0] / s, q[1] / s, q[2] / s], angle };
}
export const applyT = (t: { p: Vec3; q: Quat }, v: Vec3): Vec3 => add(qRotate(t.q, v), t.p);
export const applyR = (t: { p: Vec3; q: Quat }, v: Vec3): Vec3 => qRotate(t.q, v);

export const uid = (() => { let n = Date.now() % 100000; return (p = "id") => `${p}${(n++).toString(36)}${Math.random().toString(36).slice(2, 5)}`; })();

/** evaluate arithmetic expression in a numeric field: "25.4*2", "100/3", "sqrt(2)*10" */
export function evalExpr(s: string, vars: Record<string, number> = {}): number | null {
  const t = s.trim(); if (!t) return null;
  if (!/^[0-9+\-*/().,\s a-zA-Z_^]*$/.test(t)) return null;
  try {
    const names = Object.keys(vars);
    const body = t.replace(/\^/g, "**").replace(/\b(sin|cos|tan|sqrt|abs|pi|PI|asin|acos|atan|min|max|round|floor|ceil)\b/g, m => m === "pi" ? "Math.PI" : `Math.${m}`);
    // eslint-disable-next-line no-new-func
    const v = Function(...names, `"use strict";return (${body});`)(...names.map(n => vars[n]));
    return typeof v === "number" && isFinite(v) ? v : null;
  } catch { return null; }
}

export const fmt = (v: number, dp = 2) => { const r = Number(v.toFixed(dp)); return Object.is(r, -0) ? "0" : String(r); };
