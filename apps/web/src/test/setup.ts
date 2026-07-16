import { afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";

// Auto-cleanup the mounted DOM after each test that ran under the `jsdom`
// environment (interaction tests opt in per-file via `// @vitest-environment
// jsdom`). Guarded so this stays a no-op for the far more common `node`-env
// pure-logic/renderToStaticMarkup tests, where `document` does not exist.
afterEach(async () => {
  if (typeof document === "undefined") return;
  const { cleanup } = await import("@testing-library/react");
  cleanup();
});
