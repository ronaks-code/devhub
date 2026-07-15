import { describe, expect, it } from "vitest";
import { resolveChatHostMode } from "./App.js";

/**
 * M6-T9-COMPOSE: the Chat tab's `ChatHost` mounts only when `taskHeaderSetup`,
 * `threadWorkspace`, and `composerSurface` ALL resolve `devhub` together — those
 * three slices bundle one inseparable region inside the legacy `ChatPane` that
 * can't be independently swapped without editing the user-owned file. An explicit
 * stored false on ANY ONE of the three flags must restore `ChatPane`, so the gate
 * is a strict AND, never an OR — this is the exact instant-rollback contract every
 * M6 slice flag makes, applied conservatively across the bundled region.
 */
describe("resolveChatHostMode", () => {
  it("mounts ChatHost only when all three bundled slices resolve devhub", () => {
    expect(resolveChatHostMode("devhub", "devhub", "devhub")).toBe("devhub");
  });

  it("keeps the legacy ChatPane when any single bundled slice is legacy", () => {
    expect(resolveChatHostMode("legacy", "devhub", "devhub")).toBe("legacy");
    expect(resolveChatHostMode("devhub", "legacy", "devhub")).toBe("legacy");
    expect(resolveChatHostMode("devhub", "devhub", "legacy")).toBe("legacy");
  });

  it("keeps the legacy ChatPane when every bundled slice is legacy (the shipping default)", () => {
    expect(resolveChatHostMode("legacy", "legacy", "legacy")).toBe("legacy");
  });
});
