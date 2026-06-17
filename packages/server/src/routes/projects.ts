/**
 * Per-project UI metadata writes.
 *
 *   PATCH /api/projects/:id  { favorite?, archived?, sortOrder?, color? }
 *     → engine.setProjectMeta(id, patch)
 *
 * This is OUR own sidecar data (the user's pins/archive/order/accent color),
 * keyed by the stable projectId — it never touches transcripts. The read side
 * (the project list) already surfaces this metadata via `GET /api/projects`;
 * this route is the matching write.
 *
 * VALIDATION:
 *   - `:id` must resolve to a KNOWN project (archived included). An unknown id is
 *     rejected with 404 so we never create metadata rows for arbitrary strings.
 *   - The body is a partial patch: any subset of {favorite, archived, sortOrder,
 *     color}. `color` accepts a string or null (null clears the accent). An empty
 *     body is allowed and is a no-op that returns the current metadata.
 */
import type { FastifyInstance } from "fastify";
import type { Engine, ProjectMetaPatch } from "@claude-ui/engine";

const patchBodySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    favorite: { type: "boolean" },
    archived: { type: "boolean" },
    sortOrder: { type: "integer" },
    color: { type: ["string", "null"], maxLength: 64 },
  },
} as const;

interface ProjectPatchBody {
  favorite?: boolean;
  archived?: boolean;
  sortOrder?: number;
  color?: string | null;
}

/** Wire PATCH /api/projects/:id onto an app, backed by the engine's project-meta store. */
export function registerProjectsRoutes(app: FastifyInstance, engine: Engine): void {
  /** True when `id` is a known project (archived included). */
  const isKnownProject = (id: string): boolean =>
    engine.getProjects({ includeArchived: true }).some((p) => p.id === id);

  app.patch<{ Params: { id: string }; Body: ProjectPatchBody }>(
    "/api/projects/:id",
    {
      schema: {
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", minLength: 1 } },
        },
        body: patchBodySchema,
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      if (!isKnownProject(id)) {
        return reply.code(404).send({ error: "unknown project" });
      }

      // Only forward the keys actually present so an omitted field is left as-is
      // (the engine's store applies `patch.x ?? current.x`, but color uses an
      // `undefined` check to allow an explicit null clear).
      const body = req.body ?? {};
      const patch: ProjectMetaPatch = {};
      if ("favorite" in body) patch.favorite = body.favorite === true;
      if ("archived" in body) patch.archived = body.archived === true;
      if ("sortOrder" in body && typeof body.sortOrder === "number") {
        patch.sortOrder = body.sortOrder;
      }
      if ("color" in body) patch.color = body.color ?? null;

      const meta = engine.setProjectMeta(id, patch);
      return { ok: true, id, meta };
    },
  );
}
