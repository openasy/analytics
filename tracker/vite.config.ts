import { defineConfig } from "vite";

// Three files for the sites' pages, each built on its own (an IIFE takes one entry):
// - a.js, small and with no dependencies: the server wraps it per site and calls OAT.start() with its settings;
// - replay.js (--mode replay), the rrweb recorder, loaded only for the share of visits a site records;
// - heatmap.js (--mode heatmap), the overlay, loaded only when Analytics frames the page to draw a heatmap.
const ENTRIES = {
  production: { entry: "a.ts", name: "OAT", file: "a.js" },
  replay: { entry: "replay.ts", name: "OARecorder", file: "replay.js" },
  heatmap: { entry: "heatmap.ts", name: "OAHeatmap", file: "heatmap.js" },
} as const;

export default defineConfig(({ mode }) => {
  const e = ENTRIES[mode as keyof typeof ENTRIES] ?? ENTRIES.production;
  return {
    root: import.meta.dirname,
    build: {
      outDir: "../dist/tracker",
      // The first build empties the folder; the others add to it.
      emptyOutDir: e.file === "a.js",
      target: "es2019",
      lib: { entry: e.entry, formats: ["iife"], name: e.name, fileName: () => e.file },
    },
  };
});
