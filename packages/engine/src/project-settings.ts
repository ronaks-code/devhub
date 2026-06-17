/**
 * Per-project DEFAULTS the user can set: the model and permission mode a NEW session
 * in that project should start with (e.g. always open this repo on opus + acceptEdits).
 *
 * These live on the existing `project_meta` row (two additive columns,
 * `defaultModel` + `defaultPermissionMode`, added by migration v9) rather than a new
 * table — they're the same shape of "our own per-project preference, keyed by the
 * stable projectId" as favorite/archived/order/color, and sharing the row keeps a
 * single upsert per project. This module owns ONLY the types + helpers for those two
 * keys; the read/write itself goes through {@link ProjectMetaStore}, which already
 * shares the index's DB connection.
 *
 * Both keys are optional/null by default (a project with no row, or a row that never
 * set them, reads back null = "no project-specific default; use the app-wide
 * setting"). They're surfaced on {@link ProjectSummary} and accepted by
 * {@link ProjectMetaStore.set} (and therefore by the existing PATCH /api/projects/:id
 * once it forwards the keys).
 */

/** A free-form model id (e.g. "claude-opus-4-8") or null = no project default. */
export type ProjectDefaultModel = string | null;

/**
 * A Claude Code permission mode (e.g. "default", "acceptEdits", "plan",
 * "bypassPermissions") or null = no project default. Stored free-form (the engine
 * doesn't enforce an enum; the face presents the known modes).
 */
export type ProjectDefaultPermissionMode = string | null;

/** The two per-project default columns, with their baseline (null = unset) values. */
export interface ProjectDefaults {
  /** Preferred model id for new sessions in this project, or null = use app default. */
  defaultModel: ProjectDefaultModel;
  /** Preferred permission mode for new sessions in this project, or null = use app default. */
  defaultPermissionMode: ProjectDefaultPermissionMode;
}

/** Baseline (unset) per-project defaults. */
export const DEFAULT_PROJECT_DEFAULTS: ProjectDefaults = {
  defaultModel: null,
  defaultPermissionMode: null,
};

/**
 * Normalize a stored/incoming default value: trim a string, treat empty/whitespace as
 * "unset" (null). Keeps a single canonical representation so "" and null behave
 * identically and a stray space can't masquerade as a real default.
 */
export function normalizeProjectDefault(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}
