/**
 * Saved views ("smart folders") — a named, re-runnable (query + facets) pair.
 * Our own data, stored in the `saved_views` table; we never touch transcripts.
 *
 *  - A smart folder is simply a saved query string plus a {@link SearchFacets}
 *    object (projectId/role/tag/since/…). Re-running a view = engine.search(query,
 *    facets), so a view is exactly what `search` already understands.
 *  - Shares the TranscriptIndex's `node:sqlite` handle (no second connection).
 *  - The `saved_views` table is created by the base SCHEMA on a fresh DB and added
 *    onto an older DB by the migration runner (see migrations.ts v7); this store
 *    only reads/writes rows.
 *  - `facets` round-trips as a JSON object string. A corrupt/non-object value reads
 *    back as `{}` (an empty facet set) rather than throwing.
 */
import type { DatabaseSync as SqliteDatabase, StatementSync } from "node:sqlite";
import type { SearchFacets } from "./search.js";

/** A persisted saved view (smart folder). */
export interface SavedView {
  id: number;
  name: string;
  /** The text query to re-run (may be empty for a facet-only view). */
  query: string;
  /** The search facets to AND onto the query (projectId/role/tag/since/…). */
  facets: SearchFacets;
  /** Creation time, epoch milliseconds. */
  createdAt: number;
}

/** Input to {@link SavedViewStore.save}: a name plus the query + facets to store. */
export interface SaveViewInput {
  name: string;
  query?: string;
  facets?: SearchFacets;
}

interface ViewRow {
  id: number | bigint;
  name: string;
  query: string | null;
  facets: string | null;
  createdAt: number | bigint;
}

/** Parse a stored `saved_views.facets` JSON value into a clean object (always defined). */
function parseFacets(raw: unknown): SearchFacets {
  if (typeof raw !== "string" || !raw.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {}; // corrupt JSON — treat as no facets rather than throwing
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  return parsed as SearchFacets;
}

function num(v: number | bigint): number {
  return typeof v === "bigint" ? Number(v) : v;
}

function rowToView(row: ViewRow): SavedView {
  return {
    id: num(row.id),
    name: row.name,
    query: row.query ?? "",
    facets: parseFacets(row.facets),
    createdAt: num(row.createdAt),
  };
}

export class SavedViewStore {
  private selectAll: StatementSync;
  private insert: StatementSync;
  private deleteOne: StatementSync;

  /** Construct over the shared DatabaseSync handle (do NOT open a new connection). */
  constructor(private readonly db: SqliteDatabase) {
    // Newest first, then by name for stable ordering of same-instant inserts.
    this.selectAll = this.db.prepare(
      "SELECT id, name, query, facets, createdAt FROM saved_views ORDER BY createdAt DESC, id DESC",
    );
    this.insert = this.db.prepare(
      "INSERT INTO saved_views (name, query, facets, createdAt) VALUES (?, ?, ?, ?)",
    );
    this.deleteOne = this.db.prepare("DELETE FROM saved_views WHERE id = ?");
  }

  /** All saved views, newest first. */
  list(): SavedView[] {
    const rows = this.selectAll.all() as unknown as ViewRow[];
    return rows.map(rowToView);
  }

  /**
   * Persist a new saved view. `name` is trimmed (a blank name throws — a folder
   * needs a label); `query` defaults to "" and `facets` to {}. Returns the stored
   * view (with its assigned id + createdAt).
   */
  save(input: SaveViewInput): SavedView {
    const name = (input.name ?? "").trim();
    if (!name) throw new Error("saveView: name is required");
    const query = (input.query ?? "").trim();
    const facets = input.facets ?? {};
    const createdAt = Date.now();
    const res = this.insert.run(name, query, JSON.stringify(facets), createdAt);
    return {
      id: Number(res.lastInsertRowid),
      name,
      query,
      facets,
      createdAt,
    };
  }

  /** Delete one saved view by id. Returns true when a row was removed. */
  delete(id: number): boolean {
    const res = this.deleteOne.run(id);
    return Number(res.changes) > 0;
  }
}
