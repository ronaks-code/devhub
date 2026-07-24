import { describe, it, expect } from "vitest";
import { attentionPillLabel } from "./sessionStatus.js";

describe("attentionPillLabel (exited-vs-stale from data, not reason text)", () => {
  it("labels a waiting run 'Needs you'", () => {
    expect(attentionPillLabel("waiting", false)).toBe("Needs you");
    expect(attentionPillLabel("waiting", true)).toBe("Needs you");
  });

  it("labels a failed+exited run 'Exited' and a failed+stale run 'No response'", () => {
    // The whole point of the de-fragilize: the distinction now rides the `exited`
    // boolean (m6-compose isRunExited off the run's real `alive` flag), so a
    // reworded reason line can't silently flip the label.
    expect(attentionPillLabel("failed", true)).toBe("Exited");
    expect(attentionPillLabel("failed", false)).toBe("No response");
    // Absent signal defaults to the stale reading, same as before.
    expect(attentionPillLabel("failed", undefined)).toBe("No response");
  });

  it("badges nothing for running/idle/undefined (no attention-worthy state)", () => {
    expect(attentionPillLabel("running", false)).toBeNull();
    expect(attentionPillLabel("idle", false)).toBeNull();
    expect(attentionPillLabel(undefined, true)).toBeNull();
  });
});
