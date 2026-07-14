import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type {
  NativeTask,
  ProviderDescriptorCensus,
  ProviderEvent,
} from "../lib/provider-api.js";
import {
  CLAUDE_MODEL_DISCLOSURE,
  CodexNativePane,
  PROVIDER_LOCK_DISCLOSURE,
  descriptorSupportsNativeHistory,
  nativeProviderPresentation,
  providerEventAnnouncement,
  taskMatchesSelection,
} from "./CodexNativePane.js";

const HOME = "/Users/test/.claude";
const SESSION = "019f5b78-18c0-7b60-8f0c-6afc120ecd7d";

describe("provider-native pane Anthropic presentation", () => {
  it("defines restrained provider identity and native permission choices without Codex vocabulary", () => {
    expect(nativeProviderPresentation("anthropic")).toEqual({
      provider: "anthropic",
      product: "Claude",
      providerLabel: "Anthropic · Claude",
      homeLabel: "Claude home",
      taskLabel: "Claude task",
      draftNamespace: "native-claude",
      permissionModes: [
        { value: "manual", label: "Manual" },
        { value: "acceptEdits", label: "Accept edits" },
        { value: "plan", label: "Plan" },
      ],
    });
  });

  it("uses the approved exact capability and provider-lock disclosures", () => {
    expect(CLAUDE_MODEL_DISCLOSURE)
      .toBe("Claude model selection unavailable until runtime support is verified.");
    expect(PROVIDER_LOCK_DISCLOSURE)
      .toBe("Provider is fixed after creation. Fork to another provider to continue there.");
  });

  it("renders the Claude loading state without presenting OpenAI or Codex identity", () => {
    const html = renderToStaticMarkup(createElement(CodexNativePane, {
      provider: "anthropic",
    }));
    expect(html).toContain("Checking native Claude runtime");
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).not.toContain("OpenAI");
    expect(html).not.toContain("Codex");
  });

  it("matches Anthropic descriptors and selections only within the selected provider", () => {
    const descriptor = {
      provider: "anthropic",
      home: HOME,
      status: "available",
      capabilities: {
        list: true,
        read: true,
      },
    } as ProviderDescriptorCensus;
    expect(descriptorSupportsNativeHistory(descriptor, "anthropic")).toBe(true);
    expect(descriptorSupportsNativeHistory(descriptor)).toBe(false);

    const task = {
      key: { provider: "anthropic", home: HOME, nativeTaskId: SESSION },
    } as NativeTask;
    expect(taskMatchesSelection(task, HOME, SESSION, "anthropic")).toBe(true);
    expect(taskMatchesSelection(task, HOME, SESSION)).toBe(false);
  });

  it("announces the actual provider rather than reusing Codex copy", () => {
    const event = {
      provider: "anthropic",
      key: { provider: "anthropic", home: HOME, nativeTaskId: SESSION },
      occurredAt: "2026-07-13T17:00:00.000Z",
      type: "status",
      scope: "turn",
      status: "success",
      nativeId: "turn-1",
    } as ProviderEvent;
    expect(providerEventAnnouncement(event, "Claude")).toBe("Claude turn status: success.");
  });
});
