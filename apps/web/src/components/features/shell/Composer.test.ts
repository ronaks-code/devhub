// @vitest-environment jsdom
import { createElement, useState } from "react";
import { render as rtlRender, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  COMPOSER_COPY,
  COMPOSER_GEOMETRY,
  Composer,
  appendSnippet,
  applyMentionInsert,
  applySlashInsert,
  composerFooterContext,
  computePickerState,
  computeSendDisabledReason,
  decideComposerKey,
  isComposerSurfaceApplied,
  resolveComposerSurfaceMode,
  resolveSendState,
} from "./Composer.js";
import { SHELL_GEOMETRY } from "./DevHubShell.js";

function render(props: Parameters<typeof Composer>[0]): string {
  return renderToStaticMarkup(createElement(Composer, props));
}

/** The geometry-bearing composer container opening tag (the stable-slot element). */
function composerTag(html: string): string {
  const start = html.indexOf('<div class="dh-composer"');
  expect(start).toBeGreaterThanOrEqual(0);
  const end = html.indexOf(">", start);
  return html.slice(start, end + 1);
}

describe("Composer — measured geometry (stable slot)", () => {
  it("mirrors the shell's composer geometry from a single frozen source", () => {
    expect(COMPOSER_GEOMETRY.width).toBe(SHELL_GEOMETRY.composerWidth);
    expect(COMPOSER_GEOMETRY.height).toBe(SHELL_GEOMETRY.composerHeight);
    expect(COMPOSER_GEOMETRY.bottomGutter).toBe(SHELL_GEOMETRY.composerBottomGutter);
    expect(COMPOSER_GEOMETRY.radius).toBe(SHELL_GEOMETRY.composerRadius);
    expect(COMPOSER_GEOMETRY.width).toBe(736);
    expect(COMPOSER_GEOMETRY.height).toBe(98);
    expect(COMPOSER_GEOMETRY.bottomGutter).toBe(16);
    expect(Object.isFrozen(COMPOSER_GEOMETRY)).toBe(true);
  });

  it("writes the measured 736x98 / 16 gutter / 21 radius as constant data attrs", () => {
    const tag = composerTag(render({}));
    expect(tag).toContain(`data-dh-composer-width="${COMPOSER_GEOMETRY.width}"`);
    expect(tag).toContain(`data-dh-composer-height="${COMPOSER_GEOMETRY.height}"`);
    expect(tag).toContain(`data-dh-composer-gutter="${COMPOSER_GEOMETRY.bottomGutter}"`);
    expect(tag).toContain(`data-dh-composer-radius="${COMPOSER_GEOMETRY.radius}"`);
    // The composer is the surfaced control (`#2d2d2d` fill via --dh-surface).
    expect(tag).toContain("data-dh-surface");
  });

  it("renders no provider logo (no svg/img)", () => {
    const html = render({ provider: "openai", footer: { model: "gpt-5-codex", permissionMode: "workspace-write" } });
    expect(html).not.toContain("<svg");
    expect(html).not.toContain("<img");
  });
});

describe("Composer — stable slot across send/stop and draft changes", () => {
  it("keeps the composer container tag byte-identical when Send becomes Stop", () => {
    const send = render({ sendState: "send" });
    const stop = render({ sendState: "stop" });
    // The geometry-bearing container is identical; only the button label/state changes.
    expect(composerTag(send)).toBe(composerTag(stop));
    expect(send).toContain(`>${COMPOSER_COPY.sendLabel}<`);
    expect(stop).toContain(`>${COMPOSER_COPY.stopLabel}<`);
    expect(stop).toContain('data-dh-send-state="stop"');
    expect(send).toContain('data-dh-send-state="send"');
  });

  it("keeps the composer container tag byte-identical across draft content and disabled state", () => {
    const empty = render({ draft: "" });
    const typed = render({ draft: "rewire the gateway", disabledReason: null });
    const blocked = render({ draft: "", disabledReason: COMPOSER_COPY.disabledReason.empty });
    expect(composerTag(empty)).toBe(composerTag(typed));
    expect(composerTag(empty)).toBe(composerTag(blocked));
  });

  it("Stop is honestly gated: a running Claude turn without a native interrupt stays Send", () => {
    // persistentClaude / native interrupt is false for Claude until M4, so even a running
    // turn must NOT show Stop — the honest gated state is proven.
    expect(resolveSendState({ turnRunning: true, nativeInterruptEnabled: false })).toBe("send");
    expect(resolveSendState({ turnRunning: true, nativeInterruptEnabled: true })).toBe("stop");
    expect(resolveSendState({ turnRunning: false, nativeInterruptEnabled: true })).toBe("send");
    expect(resolveSendState({})).toBe("send");
  });
});

describe("Composer — accessible label and placeholder", () => {
  it("gives the textarea an explicit label element (not placeholder-only)", () => {
    const html = render({});
    // A real <label htmlFor> tied to the textarea id, plus the copy present.
    expect(html).toContain(`for="dh-composer-textarea"`);
    expect(html).toContain(`>${COMPOSER_COPY.textareaLabel}<`);
    expect(html).toContain('id="dh-composer-textarea"');
    expect(html).toContain('data-dh-composer-input=""');
  });

  it("uses the outcome-oriented placeholder on a new task", () => {
    const html = render({ isNewTask: true });
    expect(html).toContain(COMPOSER_COPY.newTaskPlaceholder);
    expect(COMPOSER_COPY.newTaskPlaceholder).toBe("Describe the outcome or change…");
  });

  it("preserves a passed draft as the textarea value", () => {
    const html = render({ draft: "keep this draft" });
    expect(html).toContain("keep this draft");
  });
});

describe("Composer — provider-native footer context (never cross-mapped)", () => {
  it("labels Codex permission as Permissions and Claude as Permission mode", () => {
    const codex = composerFooterContext("openai", { permissionMode: "workspace-write", model: "gpt-5-codex" });
    const claude = composerFooterContext("anthropic", { permissionMode: "plan", model: "claude-sonnet" });
    expect(codex.permissionLabel).toBe("Permissions");
    expect(claude.permissionLabel).toBe("Permission mode");
    // Claude never renders the Codex-native `Workspace` label.
    expect(claude.permissionLabel).not.toBe("Workspace");
  });

  it("passes provider-native permission/mode strings through verbatim (no equality cross-map)", () => {
    // A Codex-native value handed to a Claude task is NOT remapped to a Claude term,
    // and vice versa — the raw provider string is shown unchanged.
    const claude = composerFooterContext("anthropic", { permissionMode: "workspace-write", mode: "acceptEdits" });
    expect(claude.permissionValue).toBe("workspace-write");
    expect(claude.modeValue).toBe("acceptEdits");
    const codex = composerFooterContext("openai", { permissionMode: "plan", mode: "Default" });
    expect(codex.permissionValue).toBe("plan");
    expect(codex.modeValue).toBe("Default");
  });

  it("renders the provider identity as quiet text and the footer context compactly", () => {
    const html = render({
      provider: "anthropic",
      footer: { model: "claude-sonnet-4", mode: "default", permissionMode: "plan", folder: "~/proj" },
    });
    expect(html).toContain("Anthropic · Claude");
    expect(html).toContain("Permission mode");
    expect(html).toContain("plan");
    expect(html).toContain("claude-sonnet-4");
    expect(html).toContain('data-dh-composer-footer=""');
  });

  it("never exposes credentials or an unsandboxed shell fallback", () => {
    const html = render({
      provider: "openai",
      footer: { model: "gpt-5-codex", permissionMode: "workspace-write", folder: "~/proj" },
    });
    for (const banned of ["credential", "apiKey", "api_key", "sk-", "unsandboxed", "danger", "bypassPermissions"]) {
      expect(html.toLowerCase()).not.toContain(banned.toLowerCase());
    }
  });
});

describe("Composer — send disabled reasons (accessible)", () => {
  it("returns a distinct accessible reason for each blocking condition", () => {
    const R = COMPOSER_COPY.disabledReason;
    expect(computeSendDisabledReason({ draft: "", taskState: "pending-creation" })).toBe(R.pendingCreation);
    expect(computeSendDisabledReason({ draft: "hi", sendSupported: false })).toBe(R.unsupported);
    expect(computeSendDisabledReason({ draft: "hi", connection: "disconnected" })).toBe(R.disconnectedStale);
    expect(computeSendDisabledReason({ draft: "hi", connection: "stale" })).toBe(R.disconnectedStale);
    expect(computeSendDisabledReason({ draft: "hi", hasWriterLease: false })).toBe(R.missingWriterLease);
    expect(computeSendDisabledReason({ draft: "hi", hasBlockingRequest: true })).toBe(R.blockingRequest);
    expect(computeSendDisabledReason({ draft: "   " })).toBe(R.empty);
    // A ready, connected, leased, unblocked, non-empty draft is sendable.
    expect(computeSendDisabledReason({ draft: "ship it" })).toBeNull();
  });

  it("wires the disabled reason to the send button via aria-describedby", () => {
    const html = render({ draft: "", disabledReason: COMPOSER_COPY.disabledReason.empty });
    expect(html).toContain("disabled");
    expect(html).toContain('aria-describedby="dh-composer-send-reason"');
    expect(html).toContain('id="dh-composer-send-reason"');
    expect(html).toContain(COMPOSER_COPY.disabledReason.empty);
  });

  it("uses the same reconnect copy for the disconnected send-disabled reason", () => {
    // Single source: the disconnected/stale disabled reason IS the reconnect note.
    expect(COMPOSER_COPY.disabledReason.disconnectedStale).toBe(COMPOSER_COPY.reconnectNote);
  });
});

describe("Composer — disconnect keeps the draft editable", () => {
  it("keeps the textarea enabled and shows the reconnect note while disconnected", () => {
    const html = render({ draft: "unsent work", connection: "disconnected", disabledReason: COMPOSER_COPY.reconnectNote });
    // The textarea is NOT disabled — the draft stays editable and saved.
    expect(html).toContain("unsent work");
    const taStart = html.indexOf('data-dh-composer-input=""');
    const taTag = html.slice(html.lastIndexOf("<textarea", taStart), html.indexOf(">", taStart) + 1);
    expect(taTag).not.toContain("disabled");
    // The reconnect note is shown.
    expect(html).toContain(COMPOSER_COPY.reconnectNote);
    expect(COMPOSER_COPY.reconnectNote).toBe("Reconnect to send. Your draft is saved.");
  });
});

describe("Composer — keyboard contract (textarea ownership)", () => {
  const idle = { picker: "none" as const, pickerCount: 0, caretAtStart: false, caretAtEnd: false, turnRunning: false, historyNavigating: false };

  it("Enter sends; Shift+Enter inserts a newline", () => {
    expect(decideComposerKey({ ...idle, key: "Enter", shiftKey: false }).action.type).toBe("send");
    expect(decideComposerKey({ ...idle, key: "Enter", shiftKey: false }).preventDefault).toBe(true);
    const nl = decideComposerKey({ ...idle, key: "Enter", shiftKey: true });
    expect(nl.action.type).toBe("newline");
    expect(nl.preventDefault).toBe(false);
  });

  it("boundary Up/Down navigate history only while idle and at the caret boundary", () => {
    // ArrowUp at the very start recalls the previous prompt.
    expect(decideComposerKey({ ...idle, key: "ArrowUp", shiftKey: false, caretAtStart: true }).action.type).toBe("history-prev");
    // ArrowUp mid-text does nothing special (caret moves normally).
    expect(decideComposerKey({ ...idle, key: "ArrowUp", shiftKey: false, caretAtStart: false }).action.type).toBe("none");
    // ArrowDown at the very end recalls the next only while navigating.
    expect(decideComposerKey({ ...idle, key: "ArrowDown", shiftKey: false, caretAtEnd: true, historyNavigating: true }).action.type).toBe("history-next");
    expect(decideComposerKey({ ...idle, key: "ArrowDown", shiftKey: false, caretAtEnd: true, historyNavigating: false }).action.type).toBe("none");
    // While a turn is running, history is disabled entirely.
    expect(decideComposerKey({ ...idle, key: "ArrowUp", shiftKey: false, caretAtStart: true, turnRunning: true }).action.type).toBe("none");
  });

  it("an open picker owns arrows/Enter/Tab/Escape (focus never leaves the textarea)", () => {
    const open = { ...idle, picker: "slash" as const, pickerCount: 3 };
    expect(decideComposerKey({ ...open, key: "ArrowDown", shiftKey: false }).action.type).toBe("picker-next");
    expect(decideComposerKey({ ...open, key: "ArrowUp", shiftKey: false }).action.type).toBe("picker-prev");
    expect(decideComposerKey({ ...open, key: "Enter", shiftKey: false }).action.type).toBe("picker-accept");
    expect(decideComposerKey({ ...open, key: "Tab", shiftKey: false }).action.type).toBe("picker-accept");
    expect(decideComposerKey({ ...open, key: "Escape", shiftKey: false }).action.type).toBe("picker-dismiss");
    // Picker actions are swallowed so the caret/selection stays put.
    expect(decideComposerKey({ ...open, key: "Enter", shiftKey: false }).preventDefault).toBe(true);
    // With zero matches, Enter falls through to send (picker doesn't trap an empty list).
    expect(decideComposerKey({ ...idle, picker: "mention", pickerCount: 0, key: "Enter", shiftKey: false }).action.type).toBe("send");
  });
});

describe("Composer — registry-backed picker state and inserts", () => {
  it("detects slash mode from a single leading-'/' token while idle", () => {
    const cmds = ["compact", "clear", "model"];
    const s = computePickerState("/co", 3, cmds);
    expect(s.picker).toBe("slash");
    expect(s.matches).toEqual(["compact"]);
    // A message that merely starts with '/path ' is NOT slash mode.
    expect(computePickerState("/path to file", 13, cmds).picker).toBe("none");
  });

  it("detects an @-mention token via the shared detector", () => {
    const s = computePickerState("look at @src/ro", 15, []);
    expect(s.picker).toBe("mention");
    expect(s.mention?.query).toBe("src/ro");
    // An email-like 'a@b' never triggers a mention.
    expect(computePickerState("mail a@b now", 8, []).picker).toBe("none");
  });

  it("inserts a slash command and a mention against the registry positions", () => {
    expect(applySlashInsert("compact")).toBe("/compact ");
    const mention = applyMentionInsert("look at @src/ro", { query: "src/ro", start: 8, end: 15 }, "src/router.ts");
    expect(mention).toBe("look at @src/router.ts ");
  });

  it("appends a snippet after the existing draft with a separating blank line", () => {
    expect(appendSnippet("", "template body")).toBe("template body");
    expect(appendSnippet("partial message", "template body")).toBe("partial message\n\ntemplate body");
  });
});

describe("composerSurface slice-flag gate", () => {
  it("defaults to the DevHub composer; only an explicit false composerSurface flag selects legacy", () => {
    expect(resolveComposerSurfaceMode({ devHubFeatures: { composerSurface: true } })).toBe("devhub");
    expect(resolveComposerSurfaceMode({ devHubFeatures: { composerSurface: false } })).toBe("legacy");
    // Missing settings default to the new composer (no legacy first-paint flash).
    expect(resolveComposerSurfaceMode({ devHubFeatures: {} })).toBe("devhub");
    expect(resolveComposerSurfaceMode({})).toBe("devhub");
    expect(resolveComposerSurfaceMode(null)).toBe("devhub");
    expect(resolveComposerSurfaceMode(undefined)).toBe("devhub");
  });

  it("reports applied only when composerSurface is explicitly true", () => {
    expect(isComposerSurfaceApplied({ composerSurface: true })).toBe(true);
    expect(isComposerSurfaceApplied({ composerSurface: false })).toBe(false);
    expect(isComposerSurfaceApplied({})).toBe(false);
    expect(isComposerSurfaceApplied(undefined)).toBe(false);
  });
});

/** A fully-wired, controlled harness — the shape a real host provides. */
function ControlledComposer(props: {
  onSend: () => void;
  disabledReason?: string | null;
  sendState?: "send" | "stop";
}) {
  const [draft, setDraft] = useState("");
  return createElement(Composer, {
    draft,
    onDraftChange: setDraft,
    onSend: props.onSend,
    disabledReason: draft.trim() === "" ? (props.disabledReason ?? COMPOSER_COPY.disabledReason.empty) : null,
    sendState: props.sendState,
    onKeyDown: (e) => {
      const decision = decideComposerKey({
        key: e.key,
        shiftKey: e.shiftKey,
        picker: "none",
        pickerCount: 0,
        caretAtStart: false,
        caretAtEnd: false,
        turnRunning: false,
        historyNavigating: false,
      });
      if (decision.preventDefault) e.preventDefault();
      if (decision.action.type === "send") props.onSend();
    },
  });
}

describe("Composer — live interaction (mounted DOM)", () => {
  it("typing a draft enables Send, and clicking Send invokes onSend", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    rtlRender(createElement(ControlledComposer, { onSend }));

    const textarea = screen.getByLabelText(COMPOSER_COPY.textareaLabel);
    const send = screen.getByRole("button", { name: COMPOSER_COPY.sendLabel });
    expect(send).toBeDisabled();

    await user.type(textarea, "Ship it");
    expect(send).toBeEnabled();
    await user.click(send);
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it("Enter (no shift) sends via the wired keyboard decision, Shift+Enter does not", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    rtlRender(createElement(ControlledComposer, { onSend }));
    const textarea = screen.getByLabelText(COMPOSER_COPY.textareaLabel);

    await user.type(textarea, "Draft one{Shift>}{Enter}{/Shift}");
    expect(onSend).not.toHaveBeenCalled();

    await user.type(textarea, "{Enter}");
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it("a real native interrupt (Stop) is always actionable and never carries a disabled reason", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    rtlRender(createElement(ControlledComposer, { onSend, sendState: "stop" }));
    const stop = screen.getByRole("button", { name: COMPOSER_COPY.stopLabel });
    expect(stop).toBeEnabled();
    await user.click(stop);
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it("an empty draft keeps Send disabled with the exact accessible reason wired via aria-describedby", () => {
    rtlRender(createElement(ControlledComposer, { onSend: vi.fn() }));
    const send = screen.getByRole("button", { name: COMPOSER_COPY.sendLabel });
    expect(send).toBeDisabled();
    expect(send).toHaveAccessibleDescription(COMPOSER_COPY.disabledReason.empty);
  });
});
