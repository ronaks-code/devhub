// @vitest-environment jsdom
import { createElement } from "react";
import { render as rtlRender, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  CROSS_PROVIDER_FORK_COPY,
  CROSS_PROVIDER_FORK_EXCLUDED_CATEGORIES,
  CrossProviderForkPanel,
  type CrossProviderForkPanelProps,
} from "./CrossProviderForkPanel.js";
import type {
  CrossProviderForkCommitResult,
  CrossProviderForkPreviewResult,
} from "../../../lib/provider-api.js";

const PREVIEW: CrossProviderForkPreviewResult = {
  previewId: "preview-1",
  preview: {
    sourceLocator: { version: 1, provider: "openai", homeFingerprint: "fp-source", nativeTaskId: "codex-1" },
    sourceContentHash: "a".repeat(64),
    targetProvider: "anthropic",
    targetModel: null,
    targetMode: "code",
    targetCwd: "/workspace/active/claude-ui",
    transferredContext: {
      messages: [
        { role: "user", text: "Please migrate the auth module." },
        { role: "assistant", text: "Sure, starting with the token refresh path." },
      ],
    },
  },
};

const COMMIT_RESULT: CrossProviderForkCommitResult = {
  targetTask: {
    key: { provider: "anthropic", home: "/Users/test/.claude", nativeTaskId: "claude-a84f" },
    title: "Migrate the auth module",
    cwd: "/workspace/active/claude-ui",
    model: null,
    status: "idle",
    createdAt: "2026-07-16T00:00:00.000Z",
    updatedAt: "2026-07-16T00:00:00.000Z",
    archived: false,
    source: "native",
    turns: [],
  },
  link: {
    sourceLocator: PREVIEW.preview.sourceLocator,
    targetLocator: { version: 1, provider: "anthropic", homeFingerprint: "fp-target", nativeTaskId: "claude-a84f" },
    sourceContentHash: PREVIEW.preview.sourceContentHash,
    createdAt: "2026-07-16T00:00:01.000Z",
    forSource: {
      relation: "handoff-source",
      self: PREVIEW.preview.sourceLocator,
      counterpart: { version: 1, provider: "anthropic", homeFingerprint: "fp-target", nativeTaskId: "claude-a84f" },
      sourceContentHash: PREVIEW.preview.sourceContentHash,
      createdAt: "2026-07-16T00:00:01.000Z",
    },
    forTarget: {
      relation: "handoff-target",
      self: { version: 1, provider: "anthropic", homeFingerprint: "fp-target", nativeTaskId: "claude-a84f" },
      counterpart: PREVIEW.preview.sourceLocator,
      sourceContentHash: PREVIEW.preview.sourceContentHash,
      createdAt: "2026-07-16T00:00:01.000Z",
    },
  },
};

function baseProps(overrides: Partial<CrossProviderForkPanelProps> = {}): CrossProviderForkPanelProps {
  return {
    enabled: true,
    source: { provider: "openai", title: "Migrate the auth module", nativeTaskId: "codex-1" },
    target: { provider: "anthropic", home: "/Users/test/.claude", cwd: "/workspace/active/claude-ui" },
    fetchPreview: vi.fn().mockResolvedValue(PREVIEW),
    commitPreview: vi.fn().mockResolvedValue(COMMIT_RESULT),
    ...overrides,
  };
}

describe("CrossProviderForkPanel (M7 concept 06)", () => {
  it("flag-off hides the entry point entirely — no button, no way to open the dialog", () => {
    const fetchPreview = vi.fn();
    rtlRender(createElement(CrossProviderForkPanel, baseProps({ enabled: false, fetchPreview })));
    expect(screen.queryByText(CROSS_PROVIDER_FORK_COPY.entryLabel)).toBeNull();
    expect(document.querySelector("[data-cpf-entry]")).toBeNull();
    expect(document.querySelector("[data-cpf-dialog]")).toBeNull();
    expect(fetchPreview).not.toHaveBeenCalled();
  });

  it("opens the reviewed handoff preview on click, rendering target/permission/transferred-context/excluded per concept 06", async () => {
    const user = userEvent.setup();
    const fetchPreview = vi.fn().mockResolvedValue(PREVIEW);
    rtlRender(createElement(CrossProviderForkPanel, baseProps({ fetchPreview })));

    await user.click(screen.getByText(CROSS_PROVIDER_FORK_COPY.entryLabel));
    expect(fetchPreview).toHaveBeenCalledTimes(1);

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("OpenAI · Codex");
    expect(dialog).toHaveTextContent("Anthropic · Claude");
    expect(dialog).toHaveTextContent(CROSS_PROVIDER_FORK_COPY.runtimeDefaultModel);
    expect(dialog).toHaveTextContent("/workspace/active/claude-ui");
    // Claude target: `Permission mode`, NEVER `Permissions`/`Workspace`.
    expect(dialog).toHaveTextContent("Permission mode");
    expect(dialog).not.toHaveTextContent("Workspace");

    // Attributed handoff body, never the raw excluded content.
    const body = document.querySelector("[data-cpf-handoff-body]");
    expect(body?.textContent).toContain("Handoff from OpenAI · Codex task codex-1");
    expect(body?.textContent).toContain("Please migrate the auth module.");

    // Excluded categories are locked/non-interactive plain text, never selectable.
    const excluded = document.querySelector("[data-cpf-excluded]");
    for (const category of CROSS_PROVIDER_FORK_EXCLUDED_CATEGORIES) {
      expect(excluded?.textContent).toContain(category);
    }
    expect(excluded?.querySelector("input, button, select")).toBeNull();

    expect(dialog).toHaveTextContent(CROSS_PROVIDER_FORK_COPY.disclosureUnchanged);
    expect(dialog).toHaveTextContent(CROSS_PROVIDER_FORK_COPY.disclosureLocal);
  });

  it("confirming Create fork calls commitPreview with the previewId and renders the new native target", async () => {
    const user = userEvent.setup();
    const commitPreview = vi.fn().mockResolvedValue(COMMIT_RESULT);
    const onCommitted = vi.fn();
    rtlRender(createElement(CrossProviderForkPanel, baseProps({ commitPreview, onCommitted })));

    await user.click(screen.getByText(CROSS_PROVIDER_FORK_COPY.entryLabel));
    await screen.findByRole("dialog");
    await user.click(screen.getByText(CROSS_PROVIDER_FORK_COPY.createFork));

    await waitFor(() => expect(commitPreview).toHaveBeenCalledWith("preview-1"));
    expect(onCommitted).toHaveBeenCalledWith(COMMIT_RESULT);

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Anthropic · Claude");
    expect(dialog).toHaveTextContent("claude-a84f");
    expect(dialog).toHaveTextContent(`${CROSS_PROVIDER_FORK_COPY.forkedFromPrefix} OpenAI · Codex`);
    expect(dialog).toHaveTextContent(CROSS_PROVIDER_FORK_COPY.linkedByDevHub);

    await user.click(screen.getByText(CROSS_PROVIDER_FORK_COPY.done));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("cancelling the preview discards it without ever calling commitPreview", async () => {
    const user = userEvent.setup();
    const commitPreview = vi.fn();
    rtlRender(createElement(CrossProviderForkPanel, baseProps({ commitPreview })));

    await user.click(screen.getByText(CROSS_PROVIDER_FORK_COPY.entryLabel));
    await screen.findByRole("dialog");
    await user.click(screen.getByText(CROSS_PROVIDER_FORK_COPY.cancel));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(commitPreview).not.toHaveBeenCalled();
  });

  it("Escape closes an open preview without committing", async () => {
    const user = userEvent.setup();
    const commitPreview = vi.fn();
    rtlRender(createElement(CrossProviderForkPanel, baseProps({ commitPreview })));

    await user.click(screen.getByText(CROSS_PROVIDER_FORK_COPY.entryLabel));
    await screen.findByRole("dialog");
    await user.keyboard("{Escape}");

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(commitPreview).not.toHaveBeenCalled();
  });
});
