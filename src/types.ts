// ───────────── Core document model ─────────────
export type Vec3 = [number, number, number];
export type Vec2 = [number, number];

export interface PlaneDef { origin: Vec3; x: Vec3; y: Vec3; n: Vec3; name?: string }

export interface SkPoint { id: string; x: number; y: number; fixed?: boolean }

export type SkEntity =
  | { id: string; type: "line"; p1: string; p2: string; construction?: boolean }
  | { id: string; type: "circle"; c: string; r: number; construction?: boolean }
  | { id: string; type: "arc"; c: string; p1: string; p2: string; construction?: boolean } // CCW p1 → p2
  | { id: string; type: "ellipse"; c: string; a: number; b: number; rot: number; construction?: boolean }
  | { id: string; type: "spline"; pts: string[]; construction?: boolean }
  | { id: string; type: "point"; p: string; construction?: boolean };

export type ConstraintType =
  | "coincident" | "horizontal" | "vertical" | "parallel" | "perpendicular" | "equal" | "tangent"
  | "concentric" | "midpoint" | "fix" | "pointOnLine" | "pointOnCircle" | "collinear" | "symmetric"
  | "hpoints" | "vpoints" | "coradial"
  // dimensions
  | "distance" | "hdistance" | "vdistance" | "pointLineDistance" | "lineLineDistance" | "radius" | "diameter" | "angle";

export interface Constraint {
  id: string;
  type: ConstraintType;
  refs: string[];          // entity or point ids
  value?: number;          // for dimensions
  sign?: number;           // for signed h/v distance
  pos?: Vec2;              // dimension text position (sketch coords)
  name?: string;           // D1, D2…
}

export interface Sketch {
  id: string;
  plane: PlaneDef;
  planeLabel: string;
  points: Record<string, SkPoint>;
  entities: SkEntity[];
  constraints: Constraint[];
}

export type EndCondition = "blind" | "throughAll" | "midPlane" | "upToSurface" | "upToVertex" | "throughAllBoth";

export interface GeoRef { kind: "face" | "edge"; index: number; point: Vec3; normal?: Vec3 }

export type FeatureType =
  | "sketch" | "extrude" | "cut" | "revolve" | "revolveCut" | "sweep" | "sweepCut" | "loft" | "loftCut"
  | "fillet" | "chamfer" | "shell" | "draft" | "hole" | "linearPattern" | "circularPattern" | "mirror"
  | "plane" | "axis" | "point" | "import";

export interface Feature {
  id: string;
  type: FeatureType;
  name: string;
  suppressed?: boolean;
  params: any;
  sketch?: Sketch;
}

export interface Appearance { color: string; metalness: number; roughness: number; opacity: number }

export interface Configuration {
  id: string; name: string;
  suppressed: Record<string, boolean>;
  overrides: Record<string, number>; // "featureId.param" -> value
}

export interface PartDoc {
  kind: "part";
  id: string; name: string;
  features: Feature[];
  rollback: number | null;   // index; features at idx >= rollback are rolled back
  material: string | null;
  appearance: Appearance;
  units: UnitSystem;
  configs: Configuration[];
  activeConfig: string;
  props: Record<string, string>;
  counters: Record<string, number>;
}

export interface Transform { p: Vec3; q: [number, number, number, number] } // position + quaternion (x,y,z,w)

export interface Component { id: string; partId: string; name: string; instance: number; t: Transform; fixed: boolean; hidden?: boolean; transparent?: boolean }

export type MateType = "coincident" | "parallel" | "perpendicular" | "concentric" | "distance" | "angle" | "tangent" | "lock";
export interface MateRef { comp: string; face: number; kind: "face" | "edge" }
export interface Mate { id: string; name: string; type: MateType; a: MateRef; b: MateRef; value?: number; flip?: boolean; suppressed?: boolean; status?: "ok" | "warn" | "error" }

export interface ExplodeStep { id: string; comps: string[]; dir: Vec3; dist: number }

export interface AssemblyDoc {
  kind: "assembly";
  id: string; name: string;
  components: Component[];
  mates: Mate[];
  explode: ExplodeStep[];
  exploded: boolean;
  units: UnitSystem;
  counters: Record<string, number>;
}

export type DrawViewOrient = "front" | "top" | "right" | "back" | "bottom" | "left" | "iso";
export interface DrawView {
  id: string; type: "model" | "projected" | "section" | "detail";
  label: string;
  orient: DrawViewOrient;
  x: number; y: number;       // sheet position (mm) of view center
  scale: number;
  style: "hlr" | "hlv" | "wire" | "shaded";
  parent?: string;
  section?: { a: Vec2; b: Vec2 };      // in parent view local coords (model units)
  detail?: { c: Vec2; r: number };
  flip?: boolean;
  hidden?: boolean; // show hidden lines
}
export interface DrawAnno {
  id: string; type: "dim" | "note" | "balloon" | "centerMark" | "surface" | "datum" | "gtol" | "bom";
  a: Vec2; b?: Vec2; pos: Vec2; text?: string; value?: number; view?: string; kind?: "h" | "v" | "a" | "r" | "d";
}
export interface DrawingDoc {
  kind: "drawing";
  id: string; name: string;
  sheet: "A4" | "A3" | "A2" | "A1" | "A0" | "Letter";
  scale: number;
  projection: "third" | "first";
  sourceId: string | null;
  views: DrawView[];
  annos: DrawAnno[];
  title: Record<string, string>;
  units: UnitSystem;
  counters: Record<string, number>;
}

export type Doc = PartDoc | AssemblyDoc | DrawingDoc;
export type UnitSystem = "MMGS" | "CGS" | "MKS" | "IPS";

// ───────────── Kernel results ─────────────
export interface FaceInfo { id: number; type: string; center: Vec3; normal: Vec3 | null; axis?: { o: Vec3; d: Vec3; r: number } ; area: number }
export interface EdgeInfo { id: number; type: string; mid: Vec3; circle?: { c: Vec3; n: Vec3; r: number }; a?: Vec3; b?: Vec3; length: number }
export interface MeshData {
  vertices: Float32Array; normals: Float32Array; triangles: Uint32Array;
  faceGroups: { start: number; count: number; faceId: number }[];
  lines: Float32Array; edgeGroups: { start: number; count: number; edgeId: number }[];
  faces: FaceInfo[]; edges: EdgeInfo[];
  bbox: [Vec3, Vec3] | null;
}
export interface MassProps { volume: number; area: number; com: Vec3; inertia?: number[] }
export interface BuildResult {
  key: string;
  main: MeshData | null;
  preview?: MeshData | null;
  previewTool?: boolean;
  errors: Record<string, string>;
  planes: Record<string, PlaneDef>;
  axes: Record<string, { o: Vec3; d: Vec3 }>;
  mass: MassProps | null;
  time: number;
}
