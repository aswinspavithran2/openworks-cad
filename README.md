# OpenWorks CAD

A browser-based parametric 3D CAD modeler modelled on the SolidWorks workflow. It has Part, Assembly and Drawing documents and runs on a real B-rep kernel: OpenCascade, compiled to WebAssembly via replicad, running in a Web Worker.

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # production bundle in dist/
npm run typecheck
```

## Stack
- React 18 + TypeScript + Zustand for the UI and state. Styling is plain CSS (`src/ui/styles.css`), not Tailwind.
- Three.js for the viewport: custom orbit/pan/zoom-to-cursor, picking, section capping, and the triad.
- OpenCascade (replicad + replicad-opencascadejs) for modeling, meshing, HLR drawing projection, STEP/STL export and mass properties.
- An in-house 2D constraint solver (Newton plus rank analysis) for sketches.

## Layout
| Path | Purpose |
|---|---|
| `src/kernel/worker.ts` | OCCT worker: feature rebuild, export, drawing projection, interference, mass |
| `src/sketch/` | Sketch solver, geometry (trim/extend/offset/profiles), interactive tools |
| `src/viewport/` | Three.js engine and React wrapper |
| `src/assembly/solver.ts` | Mate solver, exploded views |
| `src/ui/` | Menu bar, CommandManager, FeatureManager, PropertyManager, dialogs, task pane |
| `src/drawing/DrawingSheet.tsx` | Drawing sheets, views, annotations, BOM, SVG/DXF/PDF export |

## Verified workflows (headless Chromium, real UI input)
- **Bracket:** Top Plane → Sketch → corner rectangle → Smart Dimension 100 × 60 → Extruded Boss 20 → Fillet R5 on 4 vertical edges (with an orbit to reach the hidden one) → sketch on the top face → Ø15 circle → Extruded Cut Through All → Ctrl+S → Save As `.cpart` → STL export (valid binary STL, bbox 100×20×60).
- **Assembly:** sample Plate + Pin → Mate → pick the cylinder and the hole → Concentric is auto-suggested → the pin moves onto the hole axis.
- **Drawing:** Make Drawing from Part → Standard 3 View (third angle, auto scale) → Model Items dimensions → SVG/DXF export.
- **Kernel:** all feature types build without errors, and the resulting volumes match hand calculations.

## Known limitations
- IGES is not in this OCCT build, so exporting IGES falls back to STEP and shows a notice.
- PDF export uses the browser's print dialog.
