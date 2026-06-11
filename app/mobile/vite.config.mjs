import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  base: "/mobile-app/",
  root: path.resolve("app/mobile"),
  server: {
    host: "127.0.0.1",
    port: 4174,
  },
  build: {
    outDir: path.resolve("dist/mobile"),
    emptyOutDir: true,
  },
});
