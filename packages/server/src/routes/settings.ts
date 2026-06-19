/**
 * App-settings REST surface. GET returns the full merged settings (stored values
 * layered over defaults); PUT/PATCH merges a partial update and returns the new
 * merged settings. Persistence lives in the engine's SettingsStore — this file is
 * just the HTTP boundary, so it stays thin and framework-agnostic underneath.
 */
import type { FastifyInstance } from "fastify";
import type { Engine } from "@devhub/engine";
import type { AppSettings } from "@devhub/engine/types";

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
  },
} as const;

/** Wire GET/PUT/PATCH /api/settings onto an app, backed by the engine store. */
export function registerSettingsRoutes(app: FastifyInstance, engine: Engine): void {
  app.get("/api/settings", async () => engine.getSettings());

  const update = async (req: { body: Partial<AppSettings> }): Promise<AppSettings> =>
    engine.setSettings(req.body ?? {});

  app.put<{ Body: Partial<AppSettings> }>(
    "/api/settings",
    { schema: { body: settingsBodySchema } },
    update,
  );

  // PATCH is an alias for PUT here: both perform a partial merge, never a replace.
  app.patch<{ Body: Partial<AppSettings> }>(
    "/api/settings",
    { schema: { body: settingsBodySchema } },
    update,
  );
}
