import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, it, expect } from "vitest";

/**
 * GUARDRAIL — window dragging has FOUR load-bearing requirements, and each one, on its
 * own, silently breaks drag with NO user-facing error (an ACL denial is invisible). We
 * lost days to that. This test fails loudly in CI if any of them regress. If you're here
 * because this test failed, read the assertion message — it tells you exactly what broke
 * and why drag will be dead until you fix it.
 *
 * The single most important one is the REMOTE ORIGIN: our UI is served by the sidecar over
 * http://127.0.0.1:<port>, which Tauri treats as remote, and capabilities are local-only by
 * default — so without remote.urls, EVERY window IPC (drag included) is ACL-rejected.
 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const read = (rel: string) => readFileSync(path.join(repoRoot, rel), "utf8");

describe("window-drag contract (all four are load-bearing — see file header)", () => {
  const capText = read("apps/desktop/src-tauri/capabilities/default.json");
  const cap = JSON.parse(capText) as {
    remote?: { urls?: string[] };
    permissions?: string[];
  };

  it("1. capability whitelists the sidecar's REMOTE origin (else ALL window IPC is ACL-rejected)", () => {
    const urls = cap.remote?.urls ?? [];
    expect(
      urls.some((u) => /127\.0\.0\.1/.test(u) || /localhost/.test(u)),
      "capabilities/default.json needs remote.urls covering http://127.0.0.1:* — the UI is served from the sidecar (a remote origin) so window drag IPC is rejected without it",
    ).toBe(true);
  });

  it("2. capability grants the window drag + maximize permissions", () => {
    const perms = cap.permissions ?? [];
    expect(perms).toContain("core:window:allow-start-dragging");
    expect(perms).toContain("core:window:allow-toggle-maximize");
  });

  it("3. startDragging is called SYNCHRONOUSLY (no async import before it — macOS drops a deferred drag)", () => {
    const drag = read("apps/web/src/lib/windowDrag.ts");
    expect(
      drag.includes('import { getCurrentWindow } from "@tauri-apps/api/window"'),
      "windowDrag.ts must STATICALLY import getCurrentWindow so startDragging() runs synchronously in the mousedown handler",
    ).toBe(true);
    expect(
      /await\s+import\(["']@tauri-apps\/api\/window/.test(drag),
      "windowDrag.ts must NOT `await import(...)` before startDragging — that defers it past the live mouse gesture and macOS drops the drag",
    ).toBe(false);
  });

  it("4. the main window is created with accept_first_mouse so drag works on the first click when unfocused", () => {
    const libRs = read("apps/desktop/src-tauri/src/lib.rs");
    expect(
      /\.accept_first_mouse\(true\)/.test(libRs),
      "lib.rs must build the main window with .accept_first_mouse(true) or the first click on an unfocused window only focuses it (no drag)",
    ).toBe(true);
  });
});
