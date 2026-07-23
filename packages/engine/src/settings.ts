/**
 * Durable user preferences, stored in a single `settings(key, value)` key/value
 * table inside the SAME index.db the TranscriptIndex owns (we share its
 * node:sqlite handle — we never open a second connection).
 *
 *  - Each AppSettings field is one row keyed by its name; the value is JSON so
 *    numbers / null / strings round-trip without string-coercion surprises.
 *  - Reads layer stored values over DEFAULT_SETTINGS, so a fresh DB still yields
 *    a sensible, fully-typed object.
 */
import type { DatabaseSync as SqliteDatabase, StatementSync } from "node:sqlite";
import type { AppSettings } from "./types.js";
import { DEFAULT_SETTINGS } from "./types.js";

const SETTINGS_SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
`;

export class SettingsStore {
  private db: SqliteDatabase;
  private upsert: StatementSync;
  private selectAll: StatementSync;

  /** Construct over the shared DatabaseSync handle (do NOT open a new connection). */
  constructor(db: SqliteDatabase) {
    this.db = db;
    this.db.exec(SETTINGS_SCHEMA);
    this.upsert = this.db.prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    );
    this.selectAll = this.db.prepare("SELECT key, value FROM settings");
  }

  /** Read one setting, falling back to its default (or undefined when no default). */
  get<K extends keyof AppSettings>(key: K): AppSettings[K] {
    const row = this.db
      .prepare("SELECT value FROM settings WHERE key = ?")
      .get(key as string) as { value: string | null } | undefined;
    if (row && row.value != null) {
      const parsed = parseValue(row.value);
      if (parsed !== undefined) return parsed as AppSettings[K];
    }
    const fallback = DEFAULT_SETTINGS[key];
    if (key === "devHubFeatures" && fallback && typeof fallback === "object") {
      return { ...fallback } as AppSettings[K];
    }
    return fallback;
  }

  /** Persist one setting (stored as JSON). */
  set<K extends keyof AppSettings>(key: K, value: AppSettings[K]): void {
    this.upsert.run(key as string, JSON.stringify(value ?? null));
  }

  /**
   * Read an internal boolean flag — a persisted key that is NOT part of the public
   * AppSettings surface (e.g. one-time migration markers). Defaults to false.
   */
  getFlag(key: string): boolean {
    const row = this.db
      .prepare("SELECT value FROM settings WHERE key = ?")
      .get(key) as { value: string | null } | undefined;
    return row?.value != null && parseValue(row.value) === true;
  }

  /** Persist an internal boolean flag (see {@link getFlag}). */
  setFlag(key: string, value: boolean): void {
    this.upsert.run(key, JSON.stringify(value));
  }

  /** Full settings object: stored values layered over DEFAULT_SETTINGS. */
  getAll(): AppSettings {
    const out: AppSettings = {
      ...DEFAULT_SETTINGS,
      devHubFeatures: DEFAULT_SETTINGS.devHubFeatures
        ? { ...DEFAULT_SETTINGS.devHubFeatures }
        : undefined,
    };
    const rows = this.selectAll.all() as Array<{ key: string; value: string | null }>;
    for (const { key, value } of rows) {
      if (value == null) continue;
      const parsed = parseValue(value);
      if (parsed !== undefined) (out as Record<string, unknown>)[key] = parsed;
    }
    return out;
  }

  /** Merge a partial update; only the provided keys are written. */
  setAll(partial: Partial<AppSettings>): void {
    for (const key of Object.keys(partial) as Array<keyof AppSettings>) {
      this.set(key, partial[key] as AppSettings[typeof key]);
    }
  }
}

/** Parse a stored JSON value; returns undefined on corrupt JSON (skip the row). */
function parseValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}
