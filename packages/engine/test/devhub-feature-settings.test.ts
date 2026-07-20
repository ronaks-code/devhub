import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { SettingsStore } from "../src/settings.js";
import { DEFAULT_SETTINGS } from "../src/types.js";
import { DEFAULT_DEVHUB_FEATURE_FLAGS } from "../src/providers/feature-flags.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

describe("DevHub feature settings", () => {
  it("defaults new task mechanics to Claude and persists a Codex preference", () => {
    expect(DEFAULT_SETTINGS.defaultMechanics).toBe("claude");

    const db = new DatabaseSync(":memory:");
    const store = new SettingsStore(db);
    expect(store.get("defaultMechanics")).toBe("claude");

    store.set("defaultMechanics", "codex");
    expect(store.getAll().defaultMechanics).toBe("codex");
    db.close();
  });

  it("stores all six feature requests as one complete false-by-default setting", () => {
    expect(DEFAULT_SETTINGS.devHubFeatures).toEqual(DEFAULT_DEVHUB_FEATURE_FLAGS);

    const db = new DatabaseSync(":memory:");
    const store = new SettingsStore(db);
    expect(store.get("devHubFeatures")).toEqual(DEFAULT_DEVHUB_FEATURE_FLAGS);

    const requested = {
      ...DEFAULT_DEVHUB_FEATURE_FLAGS,
      nativeCodex: true,
      unifiedTaskIndex: true,
    };
    store.set("devHubFeatures", requested);
    expect(store.get("devHubFeatures")).toEqual(requested);
    expect(store.getAll().devHubFeatures).toEqual(requested);
    db.close();
  });

  it("does not let a caller mutate the shared nested defaults through getAll", () => {
    const db = new DatabaseSync(":memory:");
    const store = new SettingsStore(db);
    const first = store.getAll();
    first.devHubFeatures!.nativeCodex = true;

    expect(store.getAll().devHubFeatures).toEqual(DEFAULT_DEVHUB_FEATURE_FLAGS);
    expect(DEFAULT_SETTINGS.devHubFeatures).toEqual(DEFAULT_DEVHUB_FEATURE_FLAGS);
    db.close();
  });
});
