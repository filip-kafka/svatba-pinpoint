import { defineConfig } from "vite";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));

const backend = process.env.PINPOINT_BACKEND ?? "http://localhost:8000";

export default defineConfig({
  build: {
    outDir: resolve(root, "../backend/static"),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: resolve(root, "index.html"),
        host: resolve(root, "host.html"),
        admin: resolve(root, "admin.html"),
      },
    },
  },
  server: {
    host: true, // reachable from your phone on the same Wi-Fi during development
    proxy: {
      "/api": backend,
      "/media": backend,
      "/ws": { target: backend.replace(/^http/, "ws"), ws: true },
    },
  },
});
