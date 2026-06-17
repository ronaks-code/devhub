import { defineConfig } from "vitest/config";

// Web unit tests target pure-logic modules under src/lib (e.g. transcript
// tool-result pairing), so they run in the lightweight `node` environment — no
// jsdom needed. Kept separate from vite.config.ts (the app build) so the React
// plugin / Tailwind aren't pulled into the test run.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
