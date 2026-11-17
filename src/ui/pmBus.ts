// Small bus so viewport can route picks to the active PropertyManager without circular imports
import type { Sel } from "../store";
import type { Engine } from "../viewport/engine";
export const pmBus: { pick: ((s: Sel, additive: boolean) => boolean) | null; engine: Engine | null; dragComp: ((compId: string, dx: number, dy: number, mode: "move" | "rotate") => void) | null; dragEnd: (() => void) | null; sketchApi: any } = { pick: null, engine: null, dragComp: null, dragEnd: null, sketchApi: null };
if (import.meta.env.DEV) (window as any).__pm = pmBus;
