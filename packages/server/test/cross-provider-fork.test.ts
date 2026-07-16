import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { Engine } from "@devhub/engine";
import {
  DEFAULT_DEVHUB_FEATURE_FLAGS,
  ProviderRegistry,
  createNativeTaskKey,
  defineProviderCapabilities,
  type NativeTask,
  type ProviderAdapter,
  type ProviderId,
} from "@devhub/engine/providers";
import type { ProviderEvent } from "@devhub/engine/providers";
import { buildApp } from "../src/app.js";

const SOURCE_HOME = path.resolve(os.tmpdir(), "devhub-fork-source");
const TARGET_HOME = path.resolve(os.tmpdir(), "devhub-fork-target");
const TOKEN = "test-mutation-token";

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

/** A source task carrying secrets, hidden reasoning, a system message, and an
 * in-flight unreviewed turn — every one of these must be stripped from a preview. */
function adversarialSourceTask(provider: ProviderId, nativeTaskId: string): NativeTask {
  const key = createNativeTaskKey(provider, SOURCE_HOME, nativeTaskId);
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
          messageEvent(key, "user", "Please deploy using sk-proj-abcdefghijklmnopqrstuvwx"),
          messageEvent(key, "assistant", "Done. My internal reasoning: chain-of-thought secret plan is X."),
          messageEvent(key, "system", "system prompt: auth=super-secret-value"),
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
    acknowledgeReconciliation: unsupported,
    subscribe: unsupported,
    ...overrides,
  };
}

interface AppHandle {
  app: FastifyInstance;
  engine: Engine;
  root: string;
}

const activeApps: AppHandle[] = [];

async function makeApp(
  providerRegistry: ProviderRegistry,
  options: { flagEnabled?: boolean } = {},
): Promise<{ app: FastifyInstance; engine: Engine }> {
  const root = mkdtempSync(path.join(os.tmpdir(), "devhub-cross-fork-route-test-"));
  const engine = new Engine(path.join(root, "index.db"));
  engine.setSettings({
    devHubFeatures: {
      ...DEFAULT_DEVHUB_FEATURE_FLAGS,
      crossProviderFork: options.flagEnabled ?? true,
    },
  });
  const { app } = buildApp({ engine, providerRegistry, token: TOKEN });
  await app.ready();
  activeApps.push({ app, engine, root });
  return { app, engine };
}

function previewRequest(overrides: Partial<{
  provider: string;
  nativeTaskId: string;
  home: string;
  target: Record<string, unknown>;
  authorization?: string;
}> = {}) {
  const {
    provider = "openai",
    nativeTaskId = "source-task-1",
    home = SOURCE_HOME,
    target = { provider: "anthropic", home: TARGET_HOME, cwd: "/work/target" },
    authorization = `Bearer ${TOKEN}`,
  } = overrides;
  return {
    method: "POST" as const,
    url: `/api/providers/${provider}/tasks/${nativeTaskId}/fork-preview`,
    headers: authorization ? { authorization } : {},
    payload: { home, target },
  };
}

afterEach(async () => {
  for (const handle of activeApps.splice(0).reverse()) {
    await handle.app.close();
    handle.engine.close();
    rmSync(handle.root, { recursive: true, force: true });
  }
});

describe("cross-provider fork HTTP seam", () => {
  it("rejects both routes with a disabled response when crossProviderFork is off", async () => {
    const registry = new ProviderRegistry();
    registry.register(SOURCE_HOME, fakeAdapter("openai", {
      readTask: async () => adversarialSourceTask("openai", "source-task-1"),
    }));
    const { app } = await makeApp(registry, { flagEnabled: false });

    const previewResponse = await app.inject(previewRequest());
    expect(previewResponse.statusCode).toBe(403);
    expect(previewResponse.json()).toEqual({ error: "cross_provider_fork_disabled" });

    const commitResponse = await app.inject({
      method: "POST",
      url: "/api/providers/openai/tasks/source-task-1/fork-commit",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { previewId: "does-not-matter" },
    });
    expect(commitResponse.statusCode).toBe(403);
    expect(commitResponse.json()).toEqual({ error: "cross_provider_fork_disabled" });
  });

  it("strips secrets/hidden-reasoning/system/in-flight content and never leaks a raw home path", async () => {
    const registry = new ProviderRegistry();
    registry.register(SOURCE_HOME, fakeAdapter("openai", {
      readTask: async () => adversarialSourceTask("openai", "source-task-1"),
    }));
    registry.register(TARGET_HOME, fakeAdapter("anthropic"));
    const { app } = await makeApp(registry);

    const response = await app.inject(previewRequest());
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      previewId: string;
      preview: {
        sourceLocator: { homeFingerprint: string };
        transferredContext: { messages: Array<{ role: string; text: string }> };
        targetProvider: string;
        targetCwd: string;
      };
    };

    expect(typeof body.previewId).toBe("string");
    expect(body.previewId.length).toBeGreaterThan(0);

    const messages = body.preview.transferredContext.messages;
    expect(messages).toEqual([
      { role: "user", text: expect.stringContaining("[REDACTED") },
      { role: "assistant", text: "The deploy finished cleanly." },
    ]);
    // The secret-carrying user message must be redacted, not merely passed through.
    expect(messages[0]!.text).not.toContain("sk-proj-abcdefghijklmnopqrstuvwx");
    // Hidden-reasoning-marked and system-role content never made it in at all.
    for (const message of messages) {
      expect(message.text).not.toMatch(/chain-of-thought/i);
      expect(message.text).not.toContain("super-secret-value");
      expect(message.text).not.toContain("unreviewed in-flight output");
    }
    expect(body.preview.targetProvider).toBe("anthropic");
    expect(body.preview.targetCwd).toBe("/work/target");

    // No raw provider home path anywhere in the response body.
    const raw = JSON.stringify(body);
    expect(raw).not.toContain(SOURCE_HOME);
    expect(raw).not.toContain(TARGET_HOME);
    expect(body.preview.sourceLocator.homeFingerprint).toBeTruthy();
  });

  it("rejects a commit when the source task mutated between preview and commit", async () => {
    const registry = new ProviderRegistry();
    let currentSource = adversarialSourceTask("openai", "source-task-1");
    registry.register(SOURCE_HOME, fakeAdapter("openai", {
      readTask: async () => currentSource,
    }));
    let started = 0;
    registry.register(TARGET_HOME, fakeAdapter("anthropic", {
      startTask: async (input) => {
        started += 1;
        return {
          key: createNativeTaskKey("anthropic", TARGET_HOME, "target-task-1"),
          title: "Target",
          cwd: input.cwd,
          model: input.model ?? null,
          status: "idle",
          createdAt: null,
          updatedAt: null,
          archived: false,
          source: "native",
          turns: [],
        };
      },
    }));
    const { app } = await makeApp(registry);

    const previewResponse = await app.inject(previewRequest());
    expect(previewResponse.statusCode).toBe(200);
    const { previewId } = previewResponse.json() as { previewId: string };

    // Mutate the source task's content after the preview was taken.
    currentSource = {
      ...currentSource,
      turns: [
        ...currentSource.turns,
        {
          id: "turn-3",
          status: "completed" as const,
          startedAt: null,
          completedAt: null,
          events: [messageEvent(currentSource.key, "assistant", "a new completed turn")],
        },
      ],
    };

    const commitResponse = await app.inject({
      method: "POST",
      url: "/api/providers/openai/tasks/source-task-1/fork-commit",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { previewId },
    });

    expect(commitResponse.statusCode).toBe(409);
    expect(commitResponse.json()).toEqual({
      error: "cross_provider_fork_source_mutated",
      code: "SOURCE_TASK_MUTATED",
    });
    expect(started).toBe(0);

    // The preview was single-use: a retry with the same id must not resurrect it.
    const retryResponse = await app.inject({
      method: "POST",
      url: "/api/providers/openai/tasks/source-task-1/fork-commit",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { previewId },
    });
    expect(retryResponse.statusCode).toBe(404);
  });

  it("commits an unmutated preview into a native target task and a bidirectional link", async () => {
    const registry = new ProviderRegistry();
    const source = adversarialSourceTask("openai", "source-task-1");
    registry.register(SOURCE_HOME, fakeAdapter("openai", {
      readTask: async () => source,
    }));
    let startedWith: unknown;
    registry.register(TARGET_HOME, fakeAdapter("anthropic", {
      startTask: async (input) => {
        startedWith = input;
        return {
          key: createNativeTaskKey("anthropic", TARGET_HOME, "target-task-1"),
          title: "Target",
          cwd: input.cwd,
          model: input.model ?? null,
          status: "idle",
          createdAt: null,
          updatedAt: null,
          archived: false,
          source: "native",
          turns: [],
        };
      },
    }));
    const { app } = await makeApp(registry);

    const previewResponse = await app.inject(previewRequest());
    expect(previewResponse.statusCode).toBe(200);
    const { previewId } = previewResponse.json() as { previewId: string };

    const commitResponse = await app.inject({
      method: "POST",
      url: "/api/providers/openai/tasks/source-task-1/fork-commit",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { previewId },
    });

    expect(commitResponse.statusCode).toBe(201);
    const body = commitResponse.json() as {
      targetTask: { key: { provider: string; nativeTaskId: string } };
      link: {
        sourceLocator: { provider: string; homeFingerprint: string };
        targetLocator: { provider: string; homeFingerprint: string };
        forSource: { relation: string };
        forTarget: { relation: string };
      };
    };

    expect(body.targetTask.key.provider).toBe("anthropic");
    expect(body.targetTask.key.nativeTaskId).toBe("target-task-1");
    expect(body.link.sourceLocator.provider).toBe("openai");
    expect(body.link.targetLocator.provider).toBe("anthropic");
    expect(body.link.forSource.relation).toBe("handoff-source");
    expect(body.link.forTarget.relation).toBe("handoff-target");
    expect(startedWith).toMatchObject({ cwd: "/work/target" });

    // The link itself is locator-based (home FINGERPRINT only, like the preview) —
    // the raw home only ever appears in `targetTask`, which is the caller's OWN
    // task echoed back with the same home the caller already supplied to commit it.
    const linkRaw = JSON.stringify(body.link);
    expect(linkRaw).not.toContain(SOURCE_HOME);
    expect(linkRaw).not.toContain(TARGET_HOME);

    // Single-use: the same previewId cannot be committed twice.
    const secondCommit = await app.inject({
      method: "POST",
      url: "/api/providers/openai/tasks/source-task-1/fork-commit",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { previewId },
    });
    expect(secondCommit.statusCode).toBe(404);
  });
});
