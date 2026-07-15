import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  RAW_DIAGNOSTIC_MAX,
  THREAD_COPY,
  THREAD_GEOMETRY,
  ThreadWorkspace,
  type ThreadItem,
  boundRawDiagnostic,
  isThreadWorkspaceApplied,
  resolveThreadWorkspaceMode,
  sanitizeRequestActions,
} from "./ThreadWorkspace.js";
import { SHELL_GEOMETRY } from "./DevHubShell.js";

/** Count non-overlapping occurrences of a substring. */
function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function render(props: Parameters<typeof ThreadWorkspace>[0]): string {
  return renderToStaticMarkup(createElement(ThreadWorkspace, props));
}

/** Extract the composer container's opening tag (the geometry-bearing element). */
function composerTag(html: string): string {
  const start = html.indexOf('<div class="dh-thread-composer"');
  expect(start).toBeGreaterThanOrEqual(0);
  const end = html.indexOf(">", start);
  return html.slice(start, end + 1);
}

const richItems: ThreadItem[] = [
  { id: "u1", kind: "user", content: "Rewire the gateway" },
  { id: "a1", kind: "assistant", content: "Here is the plan and the reasoning behind it." },
  {
    id: "act1",
    kind: "activity",
    entries: [{ id: "e1", kind: "tool", label: "read_file", detail: "router.ts" }],
    plan: { steps: [{ id: "s1", label: "Locate transport", status: "running" }] },
  },
  { id: "r1", kind: "request", prompt: "Allow running tests?", actions: [{ id: "ok", label: "Allow once" }] },
];

describe("ThreadWorkspace — the transcript is the task", () => {
  it("renders completed and active work in one vertical narrative (not split panes)", () => {
    const html = render({ items: richItems });
    expect(html).toContain('data-dh-thread-workspace=""');
    expect(html).toContain('data-dh-thread-items=""');
    // Every item kind lives in the single ordered transcript list.
    expect(html).toContain('data-dh-assistant=""');
    expect(html).toContain('data-dh-user=""');
    expect(html).toContain('data-dh-activity-timeline=""');
    expect(html).toContain('data-dh-request=""');
    // No dashboard / progress board.
    expect(html).not.toContain("dashboard");
  });

  it("never renders a provider logo (no svg/img)", () => {
    const html = render({ items: richItems });
    expect(html).not.toContain("<svg");
    expect(html).not.toContain("<img");
  });

  it("mirrors the measured geometry from a single source of truth", () => {
    expect(THREAD_GEOMETRY.transcriptWidth).toBe(SHELL_GEOMETRY.transcriptWidth);
    expect(THREAD_GEOMETRY.composerWidth).toBe(SHELL_GEOMETRY.composerWidth);
    expect(THREAD_GEOMETRY.composerHeight).toBe(SHELL_GEOMETRY.composerHeight);
    expect(THREAD_GEOMETRY.composerBottomGutter).toBe(SHELL_GEOMETRY.composerBottomGutter);
    expect(THREAD_GEOMETRY.composerRadius).toBe(SHELL_GEOMETRY.composerRadius);
    expect(THREAD_GEOMETRY.userBubbleMax).toBe(SHELL_GEOMETRY.userBubbleMax);
    expect(Object.isFrozen(THREAD_GEOMETRY)).toBe(true);
  });
});

describe("ThreadWorkspace — unframed prose vs surfaced request separation", () => {
  it("leaves assistant prose and normal activity UNFRAMED (no surface)", () => {
    const html = render({
      items: [
        { id: "a1", kind: "assistant", content: "Prose" },
        {
          id: "act1",
          kind: "activity",
          entries: [{ id: "e1", kind: "commentary", label: "Thinking" }],
        },
      ],
    });
    // The ONLY surface in a prose+activity transcript is the always-present composer;
    // the assistant prose and the activity rows add no surface of their own.
    expect(count(html, 'data-dh-surface=""')).toBe(1);
    expect(html).toContain('data-dh-composer="" data-dh-surface=""');
    // The assistant block is explicitly marked unframed.
    expect(html).toContain('data-dh-assistant="" data-dh-unframed=""');
  });

  it("marks ONLY user bubbles, requests, and the composer as surfaces", () => {
    const html = render({ items: richItems });
    // Exactly three surfaces: the user bubble, the inline request, and the composer.
    expect(count(html, 'data-dh-surface=""')).toBe(3);
    // Each surface owner is one of the allowed kinds.
    expect(html).toContain('data-dh-user="" data-dh-surface=""');
    expect(html).toContain('data-dh-request="" data-dh-surface=""');
    expect(html).toContain('data-dh-composer="" data-dh-surface=""');
  });

  it("right-aligns the user bubble and caps it at the measured max width", () => {
    const html = render({ items: [{ id: "u1", kind: "user", content: "Hi" }] });
    expect(html).toContain('data-dh-user-wrap=""');
    expect(html).toContain(`data-dh-bubble-max="${THREAD_GEOMETRY.userBubbleMax}"`);
    expect(THREAD_GEOMETRY.userBubbleMax).toBe(566);
  });
});

describe("ThreadWorkspace — stable composer invariant", () => {
  it("keeps composer geometry identical when Send becomes Stop", () => {
    const sendHtml = render({ items: richItems, sendState: "send" });
    const stopHtml = render({ items: richItems, sendState: "stop" });
    // The geometry-bearing composer container tag is byte-identical across the swap.
    expect(composerTag(sendHtml)).toBe(composerTag(stopHtml));
    // Only the button LABEL/state changes.
    expect(sendHtml).toContain(`>${THREAD_COPY.sendLabel}<`);
    expect(stopHtml).toContain(`>${THREAD_COPY.stopLabel}<`);
    expect(stopHtml).toContain('data-dh-send-state="stop"');
  });

  it("keeps composer geometry identical when activity appends (item count changes)", () => {
    const emptyHtml = render({ items: [] });
    const fullHtml = render({ items: richItems });
    expect(composerTag(emptyHtml)).toBe(composerTag(fullHtml));
    // The fixed measured dimensions are present.
    expect(composerTag(fullHtml)).toContain(`data-dh-composer-width="${THREAD_GEOMETRY.composerWidth}"`);
    expect(composerTag(fullHtml)).toContain(`data-dh-composer-height="${THREAD_GEOMETRY.composerHeight}"`);
    expect(composerTag(fullHtml)).toContain(`data-dh-composer-gutter="${THREAD_GEOMETRY.composerBottomGutter}"`);
    expect(composerTag(fullHtml)).toContain(`data-dh-composer-radius="${THREAD_GEOMETRY.composerRadius}"`);
  });

  it("gives the composer textarea an explicit accessible label (not placeholder-only)", () => {
    const html = render({ items: [] });
    expect(html).toContain(`>${THREAD_COPY.composerLabel}<`);
    expect(html).toContain('data-dh-composer-input=""');
    expect(html).toContain(THREAD_COPY.placeholder);
  });
});

describe("ThreadWorkspace — empty task has no hero", () => {
  it("renders a blank transcript (zero children/svg) while the composer still renders", () => {
    const html = render({ items: [] });
    // The transcript region exists but contains NO items and NO hero/suggestions.
    expect(html).toContain('data-dh-transcript=""');
    expect(html).not.toContain('data-dh-thread-items=""');
    expect(html).not.toContain('data-dh-thread-item=""');
    expect(html).not.toContain("<svg");
    // The composer still renders on an empty task.
    expect(html).toContain('data-dh-composer=""');
  });
});

describe("ThreadWorkspace — inline request honesty (capability-gated presentation)", () => {
  it("renders requests inline as a group, never a modal dialog", () => {
    const html = render({
      items: [{ id: "r1", kind: "request", prompt: "Allow?", actions: [{ id: "a", label: "Allow" }] }],
    });
    expect(html).toContain('role="group"');
    expect(html).not.toContain('role="dialog"');
    expect(html).not.toContain("aria-modal");
  });

  it("never offers an Always allow action", () => {
    const html = render({
      items: [
        {
          id: "r1",
          kind: "request",
          prompt: "Allow?",
          actions: [
            { id: "once", label: "Allow once" },
            { id: "always", label: "Always allow" },
            { id: "deny", label: "Deny" },
          ],
        },
      ],
    });
    expect(html).toContain(">Allow once<");
    expect(html).toContain(">Deny<");
    expect(html).not.toContain("Always allow");
    // sanitizeRequestActions is the single source of the filter.
    expect(
      sanitizeRequestActions([
        { id: "1", label: "Allow once" },
        { id: "2", label: "Always allow" },
      ]).map((a) => a.label),
    ).toEqual(["Allow once"]);
  });

  it("shows the terminal expiry copy and no actions on an expired request", () => {
    const html = render({
      items: [{ id: "r1", kind: "request", prompt: "Allow?", actions: [{ id: "a", label: "Allow" }], state: "expired" }],
    });
    expect(html).toContain(THREAD_COPY.requestExpired);
    expect(html).not.toContain('data-dh-request-action=""');
  });

  it("shows the independent cancellation copy on a cancelled request", () => {
    const html = render({
      items: [{ id: "r1", kind: "request", prompt: "Allow?", state: "cancelled" }],
    });
    expect(html).toContain(THREAD_COPY.cancelledByYou);
    // Cancellation and expiry are distinct terminal states.
    expect(html).not.toContain(THREAD_COPY.requestExpired);
  });
});

describe("ThreadWorkspace — streaming and unknown events", () => {
  it("renders exactly one polite live region carrying the Working-for status", () => {
    const html = render({
      items: [{ id: "s1", kind: "streaming", content: "partial…", elapsedLabel: "12s" }],
    });
    expect(count(html, 'aria-live="polite"')).toBe(1);
    expect(html).toContain(`${THREAD_COPY.workingPrefix} 12s`);
    // The streaming block itself is unframed and carries no live region.
    expect(html).toContain('data-dh-streaming="" data-dh-unframed=""');
  });

  it("keeps a single live region (empty) when nothing is streaming", () => {
    const html = render({ items: [{ id: "a1", kind: "assistant", content: "done" }] });
    expect(count(html, 'aria-live="polite"')).toBe(1);
    expect(html).not.toContain(THREAD_COPY.workingPrefix);
  });

  it("renders unknown native events as a bounded raw diagnostic, never a fabricated tool", () => {
    const html = render({ items: [{ id: "x1", kind: "raw", raw: "unknown.event {…}" }] });
    expect(html).toContain('data-dh-raw="" data-dh-unframed=""');
    expect(html).toContain("unknown.event");
  });

  it("bounds and strips control chars from raw diagnostics", () => {
    const nul = String.fromCharCode(0);
    const del = String.fromCharCode(0x7f);
    expect(boundRawDiagnostic(`a${nul}b${del}c`)).toBe("abc");
    // Tab/newline are preserved for readability.
    expect(boundRawDiagnostic("a\tb\nc")).toBe("a\tb\nc");
    // Hard length cap.
    expect(boundRawDiagnostic("x".repeat(RAW_DIAGNOSTIC_MAX + 500)).length).toBe(RAW_DIAGNOSTIC_MAX);
  });

  it("emits no NUL in the rendered markup for a hostile raw event", () => {
    const nul = String.fromCharCode(0);
    const html = render({ items: [{ id: "x1", kind: "raw", raw: `evt${nul}data` }] });
    expect(html).not.toContain(nul);
    expect(html).toContain("evtdata");
  });
});

describe("threadWorkspace slice-flag gate", () => {
  it("mounts ThreadWorkspace only for a resolved true threadWorkspace flag", () => {
    expect(resolveThreadWorkspaceMode({ devHubFeatures: { threadWorkspace: true } })).toBe("devhub");
    expect(resolveThreadWorkspaceMode({ devHubFeatures: { threadWorkspace: false } })).toBe("legacy");
    expect(resolveThreadWorkspaceMode({ devHubFeatures: {} })).toBe("legacy");
    expect(resolveThreadWorkspaceMode({})).toBe("legacy");
    expect(resolveThreadWorkspaceMode(null)).toBe("legacy");
    expect(resolveThreadWorkspaceMode(undefined)).toBe("legacy");
  });

  it("reports applied only when threadWorkspace is explicitly true", () => {
    expect(isThreadWorkspaceApplied({ threadWorkspace: true })).toBe(true);
    expect(isThreadWorkspaceApplied({ threadWorkspace: false })).toBe(false);
    expect(isThreadWorkspaceApplied({})).toBe(false);
    expect(isThreadWorkspaceApplied(undefined)).toBe(false);
  });
});
