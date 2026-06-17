/**
 * Per-session tags — our own data, stored as a JSON array string in
 * `session_meta.tags` (keyed by sessionId). We never touch transcripts.
 *
 *  - Shares the TranscriptIndex's `node:sqlite` handle (no second connection).
 *  - The `tags` column is created by the base SCHEMA on a fresh DB and backfilled
 *    onto an older DB by the migration runner (see migrations.ts v3); this store
 *    only reads/writes the JSON value.
 *  - Tags are normalized on write: trimmed, empty dropped, lower-cased for
 *    case-insensitive grouping, and de-duplicated (insertion order preserved).
 *    A session with no row — or a corrupt/non-array JSON value — reads back as [].
 */
import type { DatabaseSync as SqliteDatabase, StatementSync } from "node:sqlite";

/** Parse a stored `session_meta.tags` JSON value into a clean string[] (always defined). */
export function parseTags(raw: unknown): string[] {
  if (typeof raw !== "string" || !raw.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return []; // corrupt JSON — treat as untagged rather than throwing
  }
  if (!Array.isArray(parsed)) return [];
  return normalizeTags(parsed);
}

/** Trim, drop empties, lower-case, and de-dupe a raw tag list (insertion order kept). */
export function normalizeTags(tags: unknown[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of tags) {
    if (typeof t !== "string") continue;
    const v = t.trim().toLowerCase();
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

export class TagStore {
  private selectOne: StatementSync;
  private selectAll: StatementSync;
  private upsert: StatementSync;

  /** Construct over the shared DatabaseSync handle (do NOT open a new connection). */
  constructor(private readonly db: SqliteDatabase) {
    this.selectOne = this.db.prepare("SELECT tags FROM session_meta WHERE sessionId = ?");
    this.selectAll = this.db.prepare("SELECT tags FROM session_meta WHERE tags IS NOT NULL");
    this.upsert = this.db.prepare(
      `INSERT INTO session_meta (sessionId, tags) VALUES (?, ?)
       ON CONFLICT(sessionId) DO UPDATE SET tags = excluded.tags`,
    );
  }

  /** Tags for one session (empty array when none / no row). */
  get(sessionId: string): string[] {
    const row = this.selectOne.get(sessionId) as { tags: string | null } | undefined;
    return parseTags(row?.tags ?? null);
  }

  /**
   * Replace a session's tags with the given list (normalized). An empty result
   * stores `NULL` (so the row reads back as untagged and drops out of getAll).
   * Returns the normalized tags actually persisted.
   */
  set(sessionId: string, tags: string[]): string[] {
    const next = normalizeTags(tags);
    this.upsert.run(sessionId, next.length ? JSON.stringify(next) : null);
    return next;
  }

  /**
   * Every distinct tag in use across all sessions, with its session count, sorted
   * by count desc then name asc. Powers the `tag` search facet's suggestions.
   */
  getAll(): Array<{ tag: string; count: number }> {
    const rows = this.selectAll.all() as Array<{ tags: string | null }>;
    const counts = new Map<string, number>();
    for (const r of rows) {
      for (const t of parseTags(r.tags)) {
        counts.set(t, (counts.get(t) ?? 0) + 1);
      }
    }
    return [...counts.entries()]
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  }
}
