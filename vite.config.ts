import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  root: path.resolve(process.cwd(), "frontend"),
  plugins: [react()],
  server: {
    port: 5173,
    host: true,
    allowedHosts: ["0b0b-82-129-110-116.ngrok-free.app"],
    proxy: {
      "/api": "http://127.0.0.1:4010",
      "/health": "http://127.0.0.1:4010"
    }
  },
  build: {
    outDir: path.resolve(process.cwd(), "frontend-dist"),
    emptyOutDir: true
  }
});
