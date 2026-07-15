import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TaskHeader } from "./TaskHeader.js";
import {
  TASK_HEADER_COPY,
  resolveClaudeModelDisclosure,
} from "../providers/provider-capabilities.js";

/** Count non-overlapping occurrences of a substring. */
function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function render(props: Parameters<typeof TaskHeader>[0]): string {
  return renderToStaticMarkup(createElement(TaskHeader, props));
}

describe("TaskHeader — provider is immutable after creation (design-lock §3)", () => {
  it("shows the quiet read-only provider identity as text, not an editable control", () => {
    const html = render({ title: "Wire the gateway", provider: "openai" });
    expect(html).toContain('data-dh-task-header=""');
    expect(html).toContain('data-dh-provider-identity=""');
    expect(html).toContain('data-dh-provider-immutable="true"');
    expect(html).toContain("OpenAI · Codex");
  });

  it("renders NO in-task provider picker (no select/toggle to change provider)", () => {
    const html = render({ title: "Refactor the store", provider: "anthropic" });
    // A capability-changing provider control must not exist anywhere in an existing task.
    expect(html).not.toContain("<select");
    expect(html).not.toContain('data-dh-provider-picker=""');
    expect(html).toContain("Anthropic · Claude");
  });

  it("offers provider change ONLY as a cross-provider fork (source unchanged)", () => {
    const html = render({ title: "Task", provider: "openai" });
    expect(html).toContain('data-dh-fork-provider=""');
    expect(html).toContain(TASK_HEADER_COPY.forkAction);
    expect(html).toContain(TASK_HEADER_COPY.providerFixedNote);
  });

  it("truncates the title via a title attribute for overflow", () => {
    const long = "A very long task title that would overflow the compact 46-high header bar";
    const html = render({ title: long, provider: "openai" });
    expect(html).toContain('data-dh-task-title=""');
    expect(html).toContain(`title="${long}"`);
  });

  it("renders no provider logo (identity is quiet text, never a logo)", () => {
    const html = render({ title: "Task", provider: "anthropic" });
    expect(count(html, "<svg")).toBe(0);
    expect(count(html, "<img")).toBe(0);
  });
});

describe("Claude model divergence (design-lock §5) — never claims the requested model ran", () => {
  it("states 'Model differs from request' and lists all three observed models on divergence", () => {
    const html = render({
      title: "Claude task",
      provider: "anthropic",
      claudeModel: {
        requested: "claude-opus-4-8",
        sessionReported: "claude-sonnet-4-5",
        responseUsed: "claude-sonnet-4-5",
      },
    });
    expect(html).toContain('data-dh-model-divergence=""');
    expect(html).toContain(TASK_HEADER_COPY.modelDiffersFromRequest);
    // Each observed value under its own label; requested is NOT relabeled as used.
    expect(html).toContain(TASK_HEADER_COPY.requestedLabel);
    expect(html).toContain(TASK_HEADER_COPY.sessionReportedLabel);
    expect(html).toContain(TASK_HEADER_COPY.responseUsedLabel);
    expect(html).toContain("claude-opus-4-8");
    expect(html).toContain("claude-sonnet-4-5");
  });

  it("shows no divergence copy when the requested model matches what ran", () => {
    const html = render({
      title: "Claude task",
      provider: "anthropic",
      claudeModel: {
        requested: "claude-opus-4-8",
        sessionReported: "claude-opus-4-8",
        responseUsed: "claude-opus-4-8",
      },
    });
    expect(html).not.toContain('data-dh-model-divergence=""');
    expect(html).not.toContain(TASK_HEADER_COPY.modelDiffersFromRequest);
  });

  it("never renders Claude divergence copy beside a Codex task (rejected design)", () => {
    const html = render({
      title: "Codex task",
      provider: "openai",
      // Even if divergence-shaped data is passed, a Codex task shows nothing Claude-y.
      claudeModel: {
        requested: "gpt-5-codex",
        sessionReported: "gpt-5",
        responseUsed: "gpt-5",
      },
    });
    expect(html).not.toContain('data-dh-model-divergence=""');
    expect(html).not.toContain(TASK_HEADER_COPY.modelDiffersFromRequest);
  });
});

describe("resolveClaudeModelDisclosure — pure divergence logic", () => {
  it("diverges when session-reported or response-used differs from requested", () => {
    const d = resolveClaudeModelDisclosure({
      requested: "opus",
      sessionReported: "sonnet",
      responseUsed: "sonnet",
    });
    expect(d.diverges).toBe(true);
    expect(d.message).toBe("Model differs from request");
    // Preserves each value distinctly — never collapses to a single "ran" model.
    expect(d.requested).toBe("opus");
    expect(d.responseUsed).toBe("sonnet");
  });

  it("does not diverge when all known values equal the requested model", () => {
    const d = resolveClaudeModelDisclosure({
      requested: "opus",
      sessionReported: "opus",
      responseUsed: "opus",
    });
    expect(d.diverges).toBe(false);
    expect(d.message).toBeNull();
  });

  it("does not fabricate divergence from unknown (null) observations", () => {
    const d = resolveClaudeModelDisclosure({ requested: "opus" });
    expect(d.diverges).toBe(false);
    expect(d.message).toBeNull();
    expect(d.sessionReported).toBeNull();
    expect(d.responseUsed).toBeNull();
  });
});
