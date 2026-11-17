import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Behind an HTTPS reverse proxy (cloud IDE / preview host) set HMR_CLIENT_PORT=443; locally it is not needed.
const hmrPort = process.env.HMR_CLIENT_PORT ? Number(process.env.HMR_CLIENT_PORT) : undefined;
export default defineConfig({
  plugins: [react()],
  server: { host: "0.0.0.0", port: 5173, allowedHosts: true, hmr: hmrPort ? { clientPort: hmrPort } : true },
  preview: { host: "0.0.0.0", port: 4173, allowedHosts: true },
  optimizeDeps: { exclude: ["replicad-opencascadejs"] },
  worker: { format: "es" },
  build: { target: "es2022", chunkSizeWarningLimit: 4000 },
});
