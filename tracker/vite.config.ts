import { defineConfig } from "vite";

// One file, no dependencies, for the sites' pages. The server wraps it per site and calls OAT.start() with its settings.
export default defineConfig({
  root: import.meta.dirname,
  build: {
    outDir: "../dist/tracker",
    emptyOutDir: true,
    target: "es2019",
    lib: { entry: "a.ts", formats: ["iife"], name: "OAT", fileName: () => "a.js" },
  },
});
