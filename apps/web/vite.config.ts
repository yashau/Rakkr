import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@rakkr/shared": path.resolve(__dirname, "../../packages/shared/src"),
    },
  },
  server: {
    port: 5173,
    proxy: {
      // 127.0.0.1 (not localhost): on Windows the dev proxy can resolve
      // localhost to IPv6 (::1) and hang when the API is published from Docker.
      "/api": "http://127.0.0.1:8787",
      "/healthz": "http://127.0.0.1:8787",
      "/metrics": "http://127.0.0.1:8787",
    },
  },
});
