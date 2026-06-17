/**
 * Per-project UI metadata (favorite / archived / sortOrder / color), our own data
 * keyed by the stable projectId — never read from or written back to transcripts.
 *
 *  - Shares the TranscriptIndex's `node:sqlite` handle (no second connection).
 *  - The `project_meta` table is created by the migration runner (see migrations.ts
 *    v2); this store only reads/writes rows.
 *  - A project with no row reads back as {@link DEFAULT_PROJECT_META} so callers can
 *    treat "never customized" and "explicitly default" identically.
 */
import type { DatabaseSync as SqliteDatabase, StatementSync } from "node:sqlite";
import type { ProjectMeta } from "./types.js";
import { DEFAULT_PROJECT_META } from "./types.js";
import { normalizeProjectDefault } from "./project-settings.js";

interface MetaRow {
  projectId: string;
  favorite: number;
  archived: number;
  sortOrder: number;
  color: string | null;
  defaultModel: string | null;
  defaultPermissionMode: string | null;
}

/** A partial update: only the provided fields are written. */
export type ProjectMetaPatch = Partial<Omit<ProjectMeta, "projectId">>;

export class ProjectMetaStore {
  private selectOne: StatementSync;
  private selectAll: StatementSync;

  /** Construct over the shared DatabaseSync handle (do NOT open a new connection). */
  constructor(private readonly db: SqliteDatabase) {
    this.selectOne = this.db.prepare("SELECT * FROM project_meta WHERE projectId = ?");
    this.selectAll = this.db.prepare("SELECT * FROM project_meta");
  }

  /** Metadata for one project (defaults when no row exists). */
  get(projectId: string): ProjectMeta {
    const row = this.selectOne.get(projectId) as MetaRow | undefined;
    return row ? rowToMeta(row) : { projectId, ...DEFAULT_PROJECT_META };
  }

  /** All stored rows, as a projectId -> ProjectMeta map (only customized projects). */
  getAll(): Map<string, ProjectMeta> {
    const rows = this.selectAll.all() as unknown as MetaRow[];
    const out = new Map<string, ProjectMeta>();
    for (const r of rows) out.set(r.projectId, rowToMeta(r));
    return out;
  }

  /**
   * Merge a partial update for one project. Reads the current row (or defaults),
   * applies the patch, and upserts — so unspecified fields are preserved. Returns
   * the resulting metadata.
   */
  set(projectId: string, patch: ProjectMetaPatch): ProjectMeta {
    const current = this.get(projectId);
    const next: ProjectMeta = {
      projectId,
      favorite: patch.favorite ?? current.favorite,
      archived: patch.archived ?? current.archived,
      sortOrder: patch.sortOrder ?? current.sortOrder,
      color: patch.color !== undefined ? patch.color : current.color,
      // The two per-project defaults: an `undefined` patch key leaves the stored
      // value untouched, while an explicit null clears it (mirrors `color`). Both are
      // normalized so a blank/whitespace string is treated as "unset" (null).
      defaultModel:
        patch.defaultModel !== undefined
          ? normalizeProjectDefault(patch.defaultModel)
          : current.defaultModel,
      defaultPermissionMode:
        patch.defaultPermissionMode !== undefined
          ? normalizeProjectDefault(patch.defaultPermissionMode)
          : current.defaultPermissionMode,
    };
    this.db
      .prepare(
        `INSERT INTO project_meta (projectId, favorite, archived, sortOrder, color, defaultModel, defaultPermissionMode)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(projectId) DO UPDATE SET
           favorite = excluded.favorite,
           archived = excluded.archived,
           sortOrder = excluded.sortOrder,
           color = excluded.color,
           defaultModel = excluded.defaultModel,
           defaultPermissionMode = excluded.defaultPermissionMode`,
      )
      .run(
        projectId,
        next.favorite ? 1 : 0,
        next.archived ? 1 : 0,
        next.sortOrder,
        next.color,
        next.defaultModel,
        next.defaultPermissionMode,
      );
    return next;
  }
}

function rowToMeta(row: MetaRow): ProjectMeta {
  return {
    projectId: row.projectId,
    favorite: Number(row.favorite) === 1,
    archived: Number(row.archived) === 1,
    sortOrder: Number(row.sortOrder),
    color: row.color ?? null,
    defaultModel: row.defaultModel ?? null,
    defaultPermissionMode: row.defaultPermissionMode ?? null,
  };
}
