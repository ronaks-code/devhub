// @vitest-environment jsdom
import { createElement } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  IndexedProviderEvent,
  ProviderCapabilities,
  ProviderTaskLocator,
} from "@devhub/engine/providers";
import type {
  ProviderIndexApiClient,
  PublicProviderHome,
} from "../lib/provider-index-api.js";
import {
  EMPTY_INDEXED_APPROVAL_STATE,
  IndexedApprovalInbox,
  reduceIndexedApprovalState,
} from "./CodexApprovalCard.js";

const LOCATOR: ProviderTaskLocator = {
  version: 1,
  provider: "openai",
  homeFingerprint: "a".repeat(64),
  nativeTaskId: "thread-1",
};

const IDENTITY = {
  locator: LOCATOR,
  generation: 4,
  turnId: "turn-1",
  requestId: 7,
  itemId: "item-1",
  approvalId: "approval-1",
} as const;

const BASE = {
  provider: "openai" as const,
  locator: LOCATOR,
  occurredAt: "2026-07-17T00:00:00.000Z",
};

function capabilities(): ProviderCapabilities {
  return {
    list: true,
    read: true,
    start: true,
    resume: true,
    fork: true,
    send: true,
    steer: false,
    interrupt: true,
    subscribe: true,
    approveCommand: true,
    approveFileChange: true,
    approvePermissions: false,
    requestUserInput: false,
    mcpElicitation: false,
    archive: true,
    rename: true,
    skills: false,
    plugins: false,
    hooks: false,
    mcp: false,
    backgroundWork: false,
  };
}

const HOME: PublicProviderHome = {
  provider: "openai",
  homeFingerprint: LOCATOR.homeFingerprint,
  status: "available",
  capabilities: capabilities(),
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("indexed Codex approval UI", () => {
  it("correlates command detail, pending request, and exact resolution identity", () => {
    const activity: IndexedProviderEvent = {
      ...BASE,
      type: "activity",
      turnId: "turn-1",
      itemId: "item-1",
      activity: "commandApproval",
      status: "waitingOnApproval",
      message: "pnpm test",
    };
    const request: IndexedProviderEvent = {
      ...BASE,
      type: "request",
      request: { kind: "command-approval", identity: IDENTITY },
    };
    const resolved: IndexedProviderEvent = {
      ...BASE,
      type: "request-resolved",
      identity: IDENTITY,
    };

    const pending = reduceIndexedApprovalState(
      reduceIndexedApprovalState(EMPTY_INDEXED_APPROVAL_STATE, activity),
      request,
    );
    expect(pending.pending).toHaveLength(1);
    expect(pending.pending[0]).toMatchObject({ detail: "pnpm test" });
    expect(reduceIndexedApprovalState(pending, resolved).pending).toEqual([]);
  });

  it("posts an explicit allow for the exact locator and disables ambiguity", async () => {
    let emit: ((frame: Parameters<Parameters<ProviderIndexApiClient["subscribe"]>[1]>[0]) => void)
      | undefined;
    const respond = vi.fn<ProviderIndexApiClient["respond"]>().mockResolvedValue(undefined);
    const client = {
      list: vi.fn().mockResolvedValue({
        items: [{ locator: LOCATOR, status: "active" }],
        nextCursor: null,
      }),
      subscribe: vi.fn(async (_locator, sink) => {
        emit = sink;
        return { closed: new Promise<void>(() => undefined), unsubscribe: vi.fn() };
      }),
      respond,
    } as unknown as ProviderIndexApiClient;
    render(createElement(IndexedApprovalInbox, { home: HOME, client }));
    await waitFor(() => expect(client.subscribe).toHaveBeenCalledWith(
      LOCATOR,
      expect.any(Function),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    ));

    emit?.({
      type: "event",
      event: {
        ...BASE,
        type: "activity",
        turnId: "turn-1",
        itemId: "item-1",
        activity: "commandApproval",
        status: "waitingOnApproval",
        message: "pnpm test",
      },
    });
    emit?.({
      type: "event",
      event: {
        ...BASE,
        type: "request",
        request: { kind: "command-approval", identity: IDENTITY },
      },
    });

    expect(await screen.findByText("pnpm test")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Approve command" }));
    await waitFor(() => expect(respond).toHaveBeenCalledWith(LOCATOR, {
      kind: "command-approval",
      identity: {
        generation: 4,
        turnId: "turn-1",
        requestId: 7,
        itemId: "item-1",
        approvalId: "approval-1",
      },
      decision: "allow",
    }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Approve command" }))
      .toBeNull());
  });
});
