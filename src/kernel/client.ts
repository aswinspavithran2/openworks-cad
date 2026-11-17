import type { BuildResult, Feature } from "../types";

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, { res: (v: any) => void; rej: (e: any) => void }>();
export const kernelStatus = { ready: false, listeners: new Set<() => void>() };

function getWorker() {
  if (!worker) {
    worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (ev) => {
      const { id, ok, result, error } = ev.data; const p = pending.get(id); if (!p) return; pending.delete(id);
      ok ? p.res(result) : p.rej(new Error(error));
    };
    worker.onerror = (e) => { console.error("kernel worker error", e); };
    call("init", {}).then(() => { kernelStatus.ready = true; kernelStatus.listeners.forEach(l => l()); });
  }
  return worker;
}
export function call<T = any>(type: string, payload: any): Promise<T> {
  const w = getWorker(); const id = ++seq;
  return new Promise<T>((res, rej) => { pending.set(id, { res, rej }); w.postMessage({ id, type, payload }); });
}
export const kernel = {
  init: () => getWorker(),
  build: (features: Feature[], opts: { edit?: { index: number; feature: Feature }; mass?: boolean } = {}) => call<BuildResult>("build", { features, ...opts }),
  exportShape: (format: "stl" | "step", features: Feature[] | null, assembly?: any[]) => call<ArrayBuffer>("export", { format, features, assembly }),
  project: (payload: any) => call<Record<string, { visible: string[]; hidden: string[]; hatch?: string; bbox: number[] | null; error?: string }>>("project", payload),
  interference: (comps: any[]) => call<any[]>("interference", { comps }),
};
