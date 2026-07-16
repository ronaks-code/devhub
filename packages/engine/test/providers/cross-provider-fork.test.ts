import { describe, expect, it } from "vitest";
import {
  buildCrossProviderHandoffPreview,
  buildTransferredContext,
  commitCrossProviderHandoff,
  CrossProviderForkDisabledError,
  sourceTaskContentHash,
  SourceTaskMutatedError,
} from "../../src/providers/cross-provider-fork.js";
import { defineDevHubFeatureFlags } from "../../src/providers/feature-flags.js";
import { defineProviderCapabilities } from "../../src/providers/capabilities.js";
import { ProviderRegistry } from "../../src/providers/registry.js";
import { createNativeTaskKey } from "../../src/providers/task-key.js";
import type {
  NativeTask,
  ProviderAdapter,
  ProviderId,
} from "../../src/providers/types.js";
import type { ProviderEvent } from "../../src/providers/events.js";

const SOURCE_HOME = "/tmp/cross-fork-source";
const TARGET_HOME = "/tmp/cross-fork-target";

function messageEvent(
  key: ReturnType<typeof createNativeTaskKey>,
  role: "user" | "assistant" | "system",
  text: string,
): ProviderEvent {
  return {
    provider: key.provider,
    key,
    occurredAt: "2026-01-01T00:00:00.000Z",
    type: "message",
    role,
    text,
    turnId: "turn-1",
    itemId: null,
  };
}

function requestEvent(key: ReturnType<typeof createNativeTaskKey>): ProviderEvent {
  return {
    provider: key.provider,
    key,
    occurredAt: "2026-01-01T00:00:01.000Z",
    type: "request",
    request: {
      kind: "command-approval",
      identity: {
        key,
        generation: null,
        turnId: "turn-1",
        requestId: "req-1",
        itemId: null,
        approvalId: "approval-credential-xyz",
      },
    },
  };
}

/** A source task with adversarial content: secrets, auth, hidden reasoning, an
 * approval-credential-carrying request, and an in-flight (unreviewed) turn. */
function adversarialSourceTask(provider: ProviderId): NativeTask {
  const key = createNativeTaskKey(provider, SOURCE_HOME, "source-task-1");
  return {
    key,
    title: "Adversarial source",
    cwd: "/work/source",
    model: "test-model",
    status: "idle",
    createdAt: null,
    updatedAt: null,
    archived: false,
    source: "native",
    turns: [
      {
        id: "turn-1",
        status: "completed",
        startedAt: null,
        completedAt: null,
        events: [
          messageEvent(key, "user", "Please deploy using sk-proj-abcdefghijklmnopqrstuvwx and Bearer zzzzzzzzzzzzzzzzzzzz"),
          messageEvent(key, "assistant", "Done. My internal reasoning: chain-of-thought secret plan is X."),
          messageEvent(key, "system", "system prompt: auth=super-secret-value"),
          requestEvent(key),
          messageEvent(key, "assistant", "The deploy finished cleanly."),
        ],
      },
      {
        id: "turn-2",
        status: "running",
        startedAt: null,
        completedAt: null,
        events: [
          messageEvent(key, "assistant", "unreviewed in-flight output that should never transfer"),
        ],
      },
    ],
  };
}

function fakeAdapter(
  provider: ProviderId,
  overrides: Partial<ProviderAdapter> = {},
): ProviderAdapter {
  const unsupported = async () => {
    throw new Error("unexpected adapter invocation");
  };
  return {
    provider,
    capabilities: async () => defineProviderCapabilities({ read: true, start: true }),
    listTasks: unsupported,
    readTask: unsupported,
    startTask: unsupported,
    resumeTask: unsupported,
    forkTask: unsupported,
    send: unsupported,
    steer: unsupported,
    interrupt: unsupported,
    respond: unsupported,
    archive: unsupported,
    rename: unsupported,
    subscribe: unsupported,
    ...overrides,
  };
}

function buildRegistry(sourceTask: NativeTask, targetProvider: ProviderId) {
  const registry = new ProviderRegistry();
  let currentSourceTask = sourceTask;
  registry.register(SOURCE_HOME, fakeAdapter(sourceTask.key.provider, {
    readTask: async () => currentSourceTask,
  }));
  registry.register(TARGET_HOME, fakeAdapter(targetProvider, {
    startTask: async (input) => ({
      key: createNativeTaskKey(targetProvider, TARGET_HOME, "target-task-1"),
      title: "Target",
      cwd: input.cwd,
      model: input.model ?? null,
      status: "idle",
      createdAt: null,
      updatedAt: null,
      archived: false,
      source: "native",
      turns: [],
    }),
  }));
  return {
    registry,
    mutateSource: (task: NativeTask) => {
      currentSourceTask = task;
    },
  };
}

describe("cross-provider fork handoff (crossProviderFork flag)", () => {
  it("rejects when the flag is explicitly false, even though it is the M7 requested default", () => {
    // M7 fork cutover flipped the requested default to true, but the server still clamps
    // the resolved value to real availability (a genuine handoff target); an explicit
    // stored false — modeled directly here — is the immediate, non-destructive rollback.
    const offFlags = defineDevHubFeatureFlags({ crossProviderFork: false });
    expect(offFlags.crossProviderFork).toBe(false);
    const source = adversarialSourceTask("anthropic");
    expect(() =>
      buildCrossProviderHandoffPreview(offFlags, source, {
        provider: "openai",
        home: TARGET_HOME,
        cwd: "/work/target",
      })
    ).toThrow(CrossProviderForkDisabledError);
  });

  it("redacts secrets/auth, strips hidden reasoning, excludes approval-credential requests, and excludes unreviewed turn output", () => {
    const flags = defineDevHubFeatureFlags({ crossProviderFork: true });
    const source = adversarialSourceTask("anthropic");
    const context = buildTransferredContext(source);
    const allText = context.messages.map((m) => m.text).join("\n");

    // secrets/auth redacted
    expect(allText).not.toContain("sk-proj-abcdefghijklmnopqrstuvwx");
    expect(allText).not.toContain("zzzzzzzzzzzzzzzzzzzz");
    expect(allText).not.toContain("super-secret-value");
    // hidden reasoning stripped entirely (message dropped)
    expect(allText).not.toContain("chain-of-thought secret plan");
    // approval-credential-carrying request never became a message at all
    expect(allText).not.toContain("approval-credential-xyz");
    // system-role message excluded
    expect(allText).not.toContain("system prompt");
    // unreviewed (in-flight) turn output excluded
    expect(allText).not.toContain("unreviewed in-flight output");

    // the legitimate, reviewed, non-sensitive messages DO survive
    expect(allText).toContain("The deploy finished cleanly.");
    expect(context.messages.every((m) => m.role === "user" || m.role === "assistant")).toBe(true);

    const preview = buildCrossProviderHandoffPreview(flags, source, {
      provider: "openai",
      home: TARGET_HOME,
      cwd: "/work/target",
      model: "gpt-5.6-sol",
      mode: "code",
    });
    expect(preview.targetProvider).toBe("openai");
    expect(preview.targetModel).toBe("gpt-5.6-sol");
    expect(preview.targetMode).toBe("code");
    expect(preview.targetCwd).toBe("/work/target");
    // locator-only: no raw home string anywhere in the preview
    expect(JSON.stringify(preview)).not.toContain(SOURCE_HOME);
    expect(JSON.stringify(preview)).not.toContain(TARGET_HOME);
  });

  it("rejects a mutated source at commit time (source is immutable for a handoff)", async () => {
    const flags = defineDevHubFeatureFlags({ crossProviderFork: true });
    const source = adversarialSourceTask("anthropic");
    const { registry, mutateSource } = buildRegistry(source, "openai");

    const readSource = await registry.readTask(source.key, true);
    const preview = buildCrossProviderHandoffPreview(flags, readSource, {
      provider: "openai",
      home: TARGET_HOME,
      cwd: "/work/target",
    });

    // Simulate a mutation attempt on the source between preview and commit.
    mutateSource({
      ...source,
      turns: [
        ...source.turns,
        {
          id: "turn-3",
          status: "completed",
          startedAt: null,
          completedAt: null,
          events: [messageEvent(source.key, "assistant", "a mutation happened after preview")],
        },
      ],
    });

    await expect(
      commitCrossProviderHandoff(registry, flags, source.key, preview, TARGET_HOME),
    ).rejects.toThrow(SourceTaskMutatedError);
  });

  it("creates a NEW native task on the target provider and links source<->target bidirectionally", async () => {
    const flags = defineDevHubFeatureFlags({ crossProviderFork: true });
    const source = adversarialSourceTask("anthropic");
    const { registry } = buildRegistry(source, "openai");

    // Build the preview from the SAME registry-read (normalized) projection that
    // commit will re-read, exactly as a real caller (which never has a raw adapter
    // task lying around, only what `registry.readTask` hands back) would.
    const readSource = await registry.readTask(source.key, true);
    const preview = buildCrossProviderHandoffPreview(flags, readSource, {
      provider: "openai",
      home: TARGET_HOME,
      cwd: "/work/target",
    });

    const result = await commitCrossProviderHandoff(registry, flags, source.key, preview, TARGET_HOME);

    expect(result.targetTask.key.provider).toBe("openai");
    expect(result.targetTask.key.nativeTaskId).not.toBe(source.key.nativeTaskId);

    // bidirectional linkage, both directions present and pointing at each other
    expect(result.link.forSource.relation).toBe("handoff-source");
    expect(result.link.forSource.counterpart.nativeTaskId).toBe(result.targetTask.key.nativeTaskId);
    expect(result.link.forTarget.relation).toBe("handoff-target");
    expect(result.link.forTarget.counterpart.nativeTaskId).toBe(source.key.nativeTaskId);
    expect(result.link.forSource.sourceContentHash).toBe(result.link.forTarget.sourceContentHash);
    expect(result.link.sourceContentHash).toBe(sourceTaskContentHash(readSource));

    // locator-only: no raw home leaked into the link either
    expect(JSON.stringify(result.link)).not.toContain(SOURCE_HOME);
    expect(JSON.stringify(result.link)).not.toContain(TARGET_HOME);
  });

  it("rejects a same-provider target at the preview stage (a handoff is cross-provider by definition)", () => {
    const flags = defineDevHubFeatureFlags({ crossProviderFork: true });
    const source = adversarialSourceTask("anthropic");
    expect(() =>
      buildCrossProviderHandoffPreview(flags, source, {
        provider: "anthropic",
        home: SOURCE_HOME,
        cwd: "/work/target",
      })
    ).toThrow(TypeError);
  });

  it("rejects commit when the flag flips back off between preview and commit", async () => {
    const onFlags = defineDevHubFeatureFlags({ crossProviderFork: true });
    // M7 fork cutover: crossProviderFork is now the requested default, so this "flipped
    // back off" state must be modeled with an explicit override, not the bare default.
    const offFlags = defineDevHubFeatureFlags({ crossProviderFork: false });
    const source = adversarialSourceTask("anthropic");
    const { registry } = buildRegistry(source, "openai");
    const preview = buildCrossProviderHandoffPreview(onFlags, source, {
      provider: "openai",
      home: TARGET_HOME,
      cwd: "/work/target",
    });
    await expect(
      commitCrossProviderHandoff(registry, offFlags, source.key, preview, TARGET_HOME),
    ).rejects.toThrow(CrossProviderForkDisabledError);
  });

  it("computes a stable content hash that changes when task content changes", () => {
    const source = adversarialSourceTask("anthropic");
    const hash1 = sourceTaskContentHash(source);
    const hash2 = sourceTaskContentHash(source);
    expect(hash1).toBe(hash2);
    const mutated: NativeTask = {
      ...source,
      turns: [...source.turns].reverse(),
    };
    expect(sourceTaskContentHash(mutated)).not.toBe(hash1);
  });
});
