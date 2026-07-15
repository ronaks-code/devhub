/**
 * App-settings REST surface. GET returns the full merged settings (stored values
 * layered over defaults); PUT/PATCH merges a partial update and returns the new
 * merged settings. Persistence lives in the engine's SettingsStore — this file is
 * just the HTTP boundary, so it stays thin and framework-agnostic underneath.
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import type { Engine } from "@devhub/engine";
import type { AppSettings } from "@devhub/engine/types";
import {
  DEFAULT_DEVHUB_FEATURE_FLAGS,
  type DevHubFeatureFlags,
} from "@devhub/engine/providers";

const FEATURE_KEYS = [
  "nativeCodex",
  "persistentClaude",
  "unifiedTaskIndex",
  "shellChrome",
  "codexStyleShell",
  "crossProviderFork",
  "workMode",
] as const satisfies readonly (keyof DevHubFeatureFlags)[];

export interface SettingsRouteOptions {
  /** Runtime-backed availability. Persisted requests are ANDed with this before leaving the server. */
  availableDevHubFeatures?:
    | Partial<DevHubFeatureFlags>
    | (() => Partial<DevHubFeatureFlags>);
  /** Dynamic applied truth. Omitted fields do not further clamp availability. */
  appliedDevHubFeatures?: () => Partial<DevHubFeatureFlags>;
  /** Persisted-first, awaited lifecycle hook for provider runtime transitions. */
  onDevHubFeaturesChanged?: (
    features: Readonly<DevHubFeatureFlags>,
  ) => void | Promise<void>;
}

function completeFeatures(value: unknown): DevHubFeatureFlags {
  const input = value && typeof value === "object"
    ? value as Partial<DevHubFeatureFlags>
    : {};
  return {
    nativeCodex: input.nativeCodex === true,
    persistentClaude: input.persistentClaude === true,
    unifiedTaskIndex: input.unifiedTaskIndex === true,
    shellChrome: input.shellChrome === true,
    codexStyleShell: input.codexStyleShell === true,
    crossProviderFork: input.crossProviderFork === true,
    workMode: input.workMode === true,
  };
}

function resolveSettings(
  settings: AppSettings,
  available: DevHubFeatureFlags,
  applied: DevHubFeatureFlags,
): AppSettings {
  const requested = completeFeatures(settings.devHubFeatures);
  const resolved = { ...DEFAULT_DEVHUB_FEATURE_FLAGS };
  for (const key of FEATURE_KEYS) {
    resolved[key] = requested[key] && available[key] && applied[key];
  }
  return {
    ...settings,
    devHubFeatures: resolved,
    requestedDevHubFeatures: requested,
  };
}

const ALL_FEATURES_APPLIED: Readonly<DevHubFeatureFlags> = Object.freeze({
  nativeCodex: true,
  persistentClaude: true,
  unifiedTaskIndex: true,
  shellChrome: true,
  codexStyleShell: true,
  crossProviderFork: true,
  workMode: true,
});

function availableFeatures(
  source: SettingsRouteOptions["availableDevHubFeatures"],
): DevHubFeatureFlags {
  try {
    return completeFeatures(typeof source === "function" ? source() : source);
  } catch {
    return { ...DEFAULT_DEVHUB_FEATURE_FLAGS };
  }
}

function appliedFeatures(
  source: SettingsRouteOptions["appliedDevHubFeatures"],
): DevHubFeatureFlags {
  if (source === undefined) return { ...ALL_FEATURES_APPLIED };
  try {
    const value = source();
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    const applied = { ...ALL_FEATURES_APPLIED };
    for (const key of FEATURE_KEYS) {
      if (Object.prototype.hasOwnProperty.call(value, key)) applied[key] = value[key] === true;
    }
    return applied;
  } catch {
    return { ...DEFAULT_DEVHUB_FEATURE_FLAGS };
  }
}

async function rejectUnknownFeatureKeys(
  req: { body?: unknown },
  reply: FastifyReply,
): Promise<FastifyReply | void> {
  if (!req.body || typeof req.body !== "object") return;
  const value = (req.body as Record<string, unknown>).devHubFeatures;
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const allowed = new Set<string>(FEATURE_KEYS);
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) {
    return reply.code(400).send({
      error: "invalid_devhub_feature",
      field: unknown,
    });
  }
}

/**
 * Fastify body schema for a settings update. `additionalProperties: false`
 * rejects unknown keys so a typo never silently lands in the store; every field
 * is optional because a partial update only writes the keys the client sends.
 * Kept in sync with AppSettings in @devhub/engine/types.
 */
const settingsBodySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    defaultModel: { type: "string" },
    defaultPermissionMode: { type: "string" },
    theme: { type: "string", enum: ["dark", "light", "system"] },
    density: { type: "string" },
    lastProjectId: { type: ["string", "null"] },
    lastTab: { type: "string" },
    monthlyBudgetUsd: { type: ["number", "null"] },
    devHubFeatures: {
      type: "object",
      additionalProperties: false,
      required: [...FEATURE_KEYS],
      properties: {
        nativeCodex: { type: "boolean" },
        persistentClaude: { type: "boolean" },
        unifiedTaskIndex: { type: "boolean" },
        shellChrome: { type: "boolean" },
        codexStyleShell: { type: "boolean" },
        crossProviderFork: { type: "boolean" },
        workMode: { type: "boolean" },
      },
    },
  },
} as const;

/** Wire GET/PUT/PATCH /api/settings onto an app, backed by the engine store. */
export function registerSettingsRoutes(
  app: FastifyInstance,
  engine: Engine,
  options: SettingsRouteOptions = {},
): void {
  const resolveCurrent = (): AppSettings => resolveSettings(
    engine.getSettings(),
    availableFeatures(options.availableDevHubFeatures),
    appliedFeatures(options.appliedDevHubFeatures),
  );
  app.get("/api/settings", async () => resolveCurrent());

  const update = async (req: { body: Partial<AppSettings> }): Promise<AppSettings> => {
    const body = req.body ?? {};
    const stored = engine.setSettings(body);
    if (
      Object.prototype.hasOwnProperty.call(body, "devHubFeatures") &&
      options.onDevHubFeaturesChanged
    ) {
      const transition = resolveSettings(
        stored,
        availableFeatures(options.availableDevHubFeatures),
        { ...ALL_FEATURES_APPLIED },
      );
      try {
        await options.onDevHubFeaturesChanged(transition.devHubFeatures!);
      } catch (error) {
        if (options.appliedDevHubFeatures === undefined) throw error;
        const effective = completeFeatures(resolveCurrent().devHubFeatures);
        const attempted = completeFeatures(transition.devHubFeatures);
        if (FEATURE_KEYS.some((key) => attempted[key] && effective[key])) throw error;
      }
    }
    return resolveCurrent();
  };

  app.put<{ Body: Partial<AppSettings> }>(
    "/api/settings",
    {
      schema: { body: settingsBodySchema },
      preValidation: rejectUnknownFeatureKeys,
    },
    update,
  );

  // PATCH is an alias for PUT here: both perform a partial merge, never a replace.
  app.patch<{ Body: Partial<AppSettings> }>(
    "/api/settings",
    {
      schema: { body: settingsBodySchema },
      preValidation: rejectUnknownFeatureKeys,
    },
    update,
  );
}
