import { defineConfig } from "vitest/config";

// Vite (used by vitest) doesn't recognize the newer `node:sqlite` builtin and tries
// to bundle it as "sqlite". Force it external so Node resolves it natively at runtime.
export default defineConfig({
  plugins: [
    {
      name: "externalize-node-sqlite",
      enforce: "pre",
      resolveId(id) {
        if (id === "node:sqlite" || id === "sqlite") {
          return { id: "node:sqlite", external: true };
        }
        return null;
      },
    },
  ],
});
