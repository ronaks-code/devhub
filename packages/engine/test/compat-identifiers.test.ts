/**
 * Hermetic tests for the DEVHUB_* / CLAUDE_UI_* environment-compat layer.
 *
 * Contract under test (M5 Task 8):
 *   - `resolveCompatEnv` PREFERS the DevHub form, ACCEPTS the exact CLAUDE_UI_* alias
 *     only when the DevHub form is absent, and on a differing conflict USES the DevHub
 *     value while emitting only a VALUE-FREE diagnostic (never the secret value).
 *   - `resolveAppDataDir` routes DEVHUB_DATA + CLAUDE_UI_DATA through the ONE resolver
 *     and KEEPS the existing legacy default data dir (`~/.claude-ui`) — no on-disk
 *     migration in M5 (that is M8).
 *   - `isDevHubNamespaceKey` recognises BOTH namespaces (used by child-provider env
 *     scrubbing so a single tested predicate removes both).
 *
 * No process.env is mutated: every case passes an explicit env object.
 */
import { describe, it, expect } from "vitest";
import path from "node:path";
import {
  resolveCompatEnv,
  resolveAppDataDir,
  isDevHubNamespaceKey,
  DEVHUB_ENV_PREFIX,
  CLAUDE_UI_ENV_PREFIX,
  LEGACY_APP_DATA_DIRNAME,
} from "../src/compat-identifiers.js";

describe("resolveCompatEnv — DEVHUB_* preferred, CLAUDE_UI_* alias", () => {
  it("prefers the DevHub form when present (alias ignored)", () => {
    const diagnostics: string[] = [];
    const out = resolveCompatEnv(
      "DEVHUB_DATA",
      "CLAUDE_UI_DATA",
      { DEVHUB_DATA: "/dev/hub", CLAUDE_UI_DATA: "/legacy" },
      (m) => diagnostics.push(m),
    );
    expect(out.value).toBe("/dev/hub");
    expect(out.source).toBe("devhub");
    expect(out.conflict).toBe(true);
    // A conflict emits EXACTLY one value-free diagnostic.
    expect(diagnostics).toHaveLength(1);
  });

  it("on conflict emits a diagnostic that names the keys but NEVER the values", () => {
    const diagnostics: string[] = [];
    resolveCompatEnv(
      "DEVHUB_TOKEN",
      "CLAUDE_UI_TOKEN",
      { DEVHUB_TOKEN: "super-secret-devhub", CLAUDE_UI_TOKEN: "super-secret-legacy" },
      (m) => diagnostics.push(m),
    );
    expect(diagnostics).toHaveLength(1);
    const msg = diagnostics[0]!;
    expect(msg).toContain("DEVHUB_TOKEN");
    expect(msg).toContain("CLAUDE_UI_TOKEN");
    // No secret value ever appears in the diagnostic.
    expect(msg).not.toContain("super-secret-devhub");
    expect(msg).not.toContain("super-secret-legacy");
  });

  it("does NOT flag a conflict (or emit) when both are set to the SAME value", () => {
    const diagnostics: string[] = [];
    const out = resolveCompatEnv(
      "DEVHUB_DATA",
      "CLAUDE_UI_DATA",
      { DEVHUB_DATA: "/same", CLAUDE_UI_DATA: "/same" },
      (m) => diagnostics.push(m),
    );
    expect(out.value).toBe("/same");
    expect(out.source).toBe("devhub");
    expect(out.conflict).toBe(false);
    expect(diagnostics).toHaveLength(0);
  });

  it("accepts the alias only when the DevHub form is absent", () => {
    const diagnostics: string[] = [];
    const out = resolveCompatEnv(
      "DEVHUB_DATA",
      "CLAUDE_UI_DATA",
      { CLAUDE_UI_DATA: "/legacy" },
      (m) => diagnostics.push(m),
    );
    expect(out.value).toBe("/legacy");
    expect(out.source).toBe("claude-ui");
    expect(out.conflict).toBe(false);
    expect(diagnostics).toHaveLength(0);
  });

  it("treats blank/whitespace as absent and trims the winner", () => {
    // Blank DevHub form → fall through to the alias.
    expect(
      resolveCompatEnv("DEVHUB_DATA", "CLAUDE_UI_DATA", {
        DEVHUB_DATA: "   ",
        CLAUDE_UI_DATA: "  /legacy  ",
      }).value,
    ).toBe("/legacy");
    // Present DevHub form is trimmed.
    expect(
      resolveCompatEnv("DEVHUB_DATA", "CLAUDE_UI_DATA", { DEVHUB_DATA: "  /dev/hub  " }).value,
    ).toBe("/dev/hub");
  });

  it("returns source 'none' with no value when neither is set", () => {
    const out = resolveCompatEnv("DEVHUB_DATA", "CLAUDE_UI_DATA", {});
    expect(out.value).toBeUndefined();
    expect(out.source).toBe("none");
    expect(out.conflict).toBe(false);
  });

  it("does not throw when no diagnostic sink is provided on a conflict", () => {
    expect(() =>
      resolveCompatEnv("DEVHUB_DATA", "CLAUDE_UI_DATA", {
        DEVHUB_DATA: "/a",
        CLAUDE_UI_DATA: "/b",
      }),
    ).not.toThrow();
  });
});

describe("resolveAppDataDir — one function, legacy default kept (M5)", () => {
  const home = "/home/dev";

  it("keeps the legacy default data dir when neither env is set", () => {
    expect(resolveAppDataDir({}, home)).toBe(path.join(home, LEGACY_APP_DATA_DIRNAME));
    // The legacy dir name is unchanged this milestone (M8 owns the on-disk rename).
    expect(LEGACY_APP_DATA_DIRNAME).toBe(".claude-ui");
  });

  it("honors DEVHUB_DATA over CLAUDE_UI_DATA", () => {
    expect(
      resolveAppDataDir({ DEVHUB_DATA: "/data/devhub", CLAUDE_UI_DATA: "/data/legacy" }, home),
    ).toBe("/data/devhub");
  });

  it("falls back to CLAUDE_UI_DATA when DEVHUB_DATA is absent", () => {
    expect(resolveAppDataDir({ CLAUDE_UI_DATA: "/data/legacy" }, home)).toBe("/data/legacy");
  });
});

describe("isDevHubNamespaceKey — both namespaces recognised", () => {
  it("matches DEVHUB_* and CLAUDE_UI_* only", () => {
    expect(DEVHUB_ENV_PREFIX).toBe("DEVHUB_");
    expect(CLAUDE_UI_ENV_PREFIX).toBe("CLAUDE_UI_");
    expect(isDevHubNamespaceKey("DEVHUB_TOKEN")).toBe(true);
    expect(isDevHubNamespaceKey("CLAUDE_UI_TOKEN")).toBe(true);
    expect(isDevHubNamespaceKey("ANTHROPIC_API_KEY")).toBe(false);
    expect(isDevHubNamespaceKey("PATH")).toBe(false);
    expect(isDevHubNamespaceKey("DEVHUB")).toBe(false); // prefix requires the underscore
  });
});
