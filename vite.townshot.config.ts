import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev-only screenshot-harness build (task-6-design-inputs.md §1). Deliberately
// a SEPARATE config from `vite.config.ts` — the one `npm run build`/
// `tauri build` actually use, and which never lists `townshot.html` in any
// `rollupOptions.input` — with its own output directory
// (`dist-townshot/`, vs. the app's `dist/`). Between "not referenced by the
// app's own build config" and "written to a directory nothing packages",
// there is no path by which this reaches the shipped app bundle.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist-townshot",
    rollupOptions: { input: "townshot.html" },
  },
});
