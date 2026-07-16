/**
 * Richer health / diagnostics: GET /api/health/diagnostics
 *
 * The minimal `GET /api/health` (in app.ts) is a fast liveness check the auth hook
 * exempts; this endpoint is the deeper "what's my setup?" probe a support/debug view
 * shows. It reports, best-effort:
 *
 *   - claude CLI version (spawns `claude --version` with a short timeout; null when
 *     the binary is absent or the probe times out — never fatal),
 *   - resolved paths (projects dir, config dir, index DB path),
 *   - search mode (FTS5 vs the LIKE fallback) + the active FTS tokenizer,
 *   - index health (session count, indexed message count, DB file size in bytes),
 *   - engine.ready,
 *   - the app/server version (from package.json).
 *
 * RESILIENCE: every probe is wrapped so a failure degrades to null/"unknown" rather
 * than a 500 — a diagnostics endpoint must work even on a half-broken machine. This
 * is read-only: it spawns `claude --version` (no shell, no args beyond `--version`)
 * and stats files; it never writes anything.
 */
import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { paths, type Engine } from "@devhub/engine";

/** Short cap on the `claude --version` probe so a hung CLI can't stall the response. */
const VERSION_TIMEOUT_MS = 3000;

/**
 * Strict identity string returned by GET /api/health (see app.ts) and echoed here.
 * A bare 2xx on a port proves nothing — any process, including a stale/foreign
 * server another tool happens to have bound there, can answer with `ok: true`.
 * Callers that need to confirm "this port is THE DevHub server" (the Tauri desktop
 * shell's spawn-or-reuse probe, `apps/desktop/src-tauri/src/lib.rs`) must check this
 * exact field/value, not just the HTTP status. Never change this string casually —
 * it's a cross-language contract with the Rust health probe.
 */
export const DEVHUB_SERVER_SERVICE_ID = "devhub-server" as const;

/**
 * Spawn `claude --version` (no shell) and return the trimmed first line, or null on
 * any failure — missing binary, non-zero exit, or timeout. Best-effort by design.
 */
function probeClaudeVersion(): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile(
        "claude",
        ["--version"],
        { timeout: VERSION_TIMEOUT_MS, windowsHide: true },
        (err, stdout) => {
          if (err) return resolve(null);
          const line = String(stdout).trim().split(/\r?\n/)[0]?.trim();
          resolve(line || null);
        },
      );
    } catch {
      // execFile can throw synchronously (e.g. an invalid spawn) on some platforms.
      resolve(null);
    }
  });
}

/**
 * Resolve the index DB file path. The engine doesn't expose it as a typed field, so
 * we duck-type the underlying node:sqlite `DatabaseSync.location()` off the private
 * `db` handle (the authoritative open-file path), then a few likely stored-path
 * accessors, and finally fall back to the engine's DEFAULT location
 * (`appDataDir()/index.db`). Best-effort: a wrong path just means the size probe
 * reports null.
 */
function resolveIndexDbPath(engine: Engine): string {
  const idx = engine.index as unknown as Record<string, unknown>;
  // Authoritative: the SQLite handle knows the file it opened.
  const db = idx.db as { location?: () => string | null } | undefined;
  if (db && typeof db.location === "function") {
    try {
      const loc = db.location();
      if (typeof loc === "string" && loc.length > 0) return loc;
    } catch {
      // fall through to the heuristics below
    }
  }
  for (const key of ["dbPath", "file", "filename", "path", "dbFile"]) {
    const v = idx[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return path.join(paths.appDataDir(), "index.db");
}

/** Stat a file for its byte size; null when it's missing or unreadable. */
async function fileSize(file: string): Promise<number | null> {
  try {
    return (await stat(file)).size;
  } catch {
    return null;
  }
}

/**
 * Sum the per-session message counts across the whole corpus — the "indexed message
 * count" — from the index's own session summaries. Best-effort: null on any failure
 * (so a probe glitch never 500s the endpoint).
 */
function indexedMessageCount(engine: Engine): number | null {
  try {
    let total = 0;
    for (const s of engine.listAllSessions({ limit: 1_000_000, offset: 0 })) {
      total += s.messageCount;
    }
    return total;
  } catch {
    return null;
  }
}

/**
 * The server package version, read from this package's package.json (two dirs up
 * from src/routes/). Read once at startup and memoized; "unknown" when unreadable.
 */
let cachedVersion: string | undefined;
export async function serverVersion(): Promise<string> {
  if (cachedVersion !== undefined) return cachedVersion;
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const pkgPath = path.resolve(here, "..", "..", "package.json");
    const pkg = JSON.parse(await readFile(pkgPath, "utf8")) as { version?: string };
    cachedVersion = typeof pkg.version === "string" ? pkg.version : "unknown";
  } catch {
    cachedVersion = "unknown";
  }
  return cachedVersion;
}

/** Read the active search mode + FTS tokenizer off the index, tolerating absence. */
function searchInfo(engine: Engine): { mode: string; tokenizer: string | null } {
  const idx = engine.index as unknown as { searchMode?: unknown; ftsTokenizer?: unknown };
  const mode = typeof idx.searchMode === "string" ? idx.searchMode : "unknown";
  const tokenizer = typeof idx.ftsTokenizer === "string" ? idx.ftsTokenizer : null;
  return { mode, tokenizer };
}

/**
 * Wire GET /api/health/diagnostics onto an app. The route never throws: every probe
 * is wrapped so a failure degrades to null/"unknown" and the endpoint still answers
 * 200 with the fields it could gather.
 */
export function registerHealthRoutes(app: FastifyInstance, engine: Engine): void {
  app.get("/api/health/diagnostics", async () => {
    // The CLI probe is the only async/spawn step; everything else is cheap + sync.
    const [cliVersion, version] = await Promise.all([probeClaudeVersion(), serverVersion()]);

    const projectsDir = (() => {
      try {
        return paths.projectsDir();
      } catch {
        return null;
      }
    })();
    const configDir = (() => {
      try {
        return paths.claudeConfigDir();
      } catch {
        return null;
      }
    })();
    const indexDbPath = (() => {
      try {
        return resolveIndexDbPath(engine);
      } catch {
        return null;
      }
    })();

    const sessionCount = (() => {
      try {
        return engine.index.getSessionCount();
      } catch {
        return null;
      }
    })();

    const { mode, tokenizer } = searchInfo(engine);

    return {
      ok: true,
      ready: engine.ready,
      version,
      cli: { claudeVersion: cliVersion },
      paths: {
        projectsDir,
        configDir,
        indexDbPath,
      },
      search: {
        mode,
        tokenizer,
      },
      index: {
        sessionCount,
        indexedMessageCount: indexedMessageCount(engine),
        dbSizeBytes: indexDbPath ? await fileSize(indexDbPath) : null,
      },
    };
  });
}
