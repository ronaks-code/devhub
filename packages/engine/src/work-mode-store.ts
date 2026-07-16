/**
 * M7-WORKMODE-PERSIST: durable store for Work-mode tasks.
 *
 * Mirrors the other small per-concern stores in this file's neighborhood
 * (`SavedViewStore`, `ProjectMetaStore`, `AuditStore`) — a thin class over the
 * TranscriptIndex's SHARED `node:sqlite` handle (no second connection, no
 * separate file to keep in sync), reading/writing the `work_mode_tasks` table
 * added to the base `SCHEMA` in `index-db.ts`.
 *
 * Work-mode tasks previously lived in a closure-scoped `Map` inside
 * `packages/server/src/routes/work-mode.ts` — real in the running process but
 * gone the instant the server restarted. Persisting them here (the same
 * SQLite file every other durable engine state lives in, under the isolated
 * scratch config dir resolved by `appDataDir()`) makes a created task survive
 * a restart for free: a fresh `Engine` pointed at the same db file rehydrates
 * the same row.
 *
 * The full `WorkModeTask` is stored as one JSON blob per row (its shape is
 * still evolving alongside the engine model in `providers/work-mode.ts`) —
 * this store does not interpret the task's fields, it only round-trips them.
 */
import type { DatabaseSync as SqliteDatabase, StatementSync } from "node:sqlite";
import type { WorkModeTask } from "./providers/work-mode.js";

export class WorkModeTaskStore {
  private readonly selectOne: StatementSync;
  private readonly upsert: StatementSync;

  /** Construct over the shared DatabaseSync handle (do NOT open a new connection). */
  constructor(private readonly db: SqliteDatabase) {
    this.selectOne = this.db.prepare("SELECT data FROM work_mode_tasks WHERE id = ?");
    this.upsert = this.db.prepare(`
      INSERT INTO work_mode_tasks (id, data, createdAt, updatedAt) VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET data = excluded.data, updatedAt = excluded.updatedAt
    `);
  }

  /** Read one work-mode task by id, or null when no row exists (or its JSON is corrupt). */
  get(id: string): WorkModeTask | null {
    const row = this.selectOne.get(id) as { data: string } | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.data) as WorkModeTask;
    } catch {
      return null; // corrupt row — treat as absent rather than throwing
    }
  }

  /** True when a (readable) row exists for `id`. */
  has(id: string): boolean {
    return this.get(id) !== null;
  }

  /** Upsert the full task by its own `id`. `createdAt` is set once, on first insert. */
  put(task: WorkModeTask): void {
    const now = Date.now();
    this.upsert.run(task.id, JSON.stringify(task), now, now);
  }
}
