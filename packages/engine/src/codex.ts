/**
 * Codex session discovery — reads <codex-home>/sessions/**\/rollout-*.jsonl files.
 * Each .jsonl is one session; the first line is a session_meta record and
 * subsequent lines are event_msg records.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { streamRawLines } from "./parser.js";

export interface CodexSession {
  id: string;
  filename: string;
  startedAt: string;       // ISO timestamp from session_meta
  cwd: string | null;
  model: string | null;    // from session_meta payload.base_instructions or model_provider
  provider: string | null; // e.g. "openai"
  cliVersion: string | null;
  userMessageCount: number; // count of event_msg where payload.type === "user_message"
  turnCount: number;        // count of event_msg where payload.type === "task_started"
}

export interface CodexStats {
  totalSessions: number;
  last30Days: number;
  last7Days: number;
  topCwds: Array<{ cwd: string; count: number }>;
}

/**
 * Recursively find all rollout-*.jsonl files under a directory.
 */
async function* findJsonlFiles(dir: string): AsyncGenerator<string> {
  let entries: fs.Dir;
  try {
    entries = await fs.promises.opendir(dir);
  } catch {
    return;
  }
  for await (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* findJsonlFiles(full);
    } else if (entry.isFile() && entry.name.startsWith("rollout-") && entry.name.endsWith(".jsonl")) {
      yield full;
    }
  }
}

async function resolveSessionsDir(codexHome: string): Promise<string | null> {
  try {
    const canonicalHome = await fs.promises.realpath(path.resolve(codexHome));
    const canonicalSessions = await fs.promises.realpath(path.join(canonicalHome, "sessions"));
    const relative = path.relative(canonicalHome, canonicalSessions);
    if (
      relative.length === 0 ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      return null;
    }
    return canonicalSessions;
  } catch {
    return null;
  }
}

/**
 * Parse one .jsonl session file into a CodexSession.
 * Returns null if the file is unreadable or missing a valid session_meta first line.
 */
type CodexSessionMetadata = CodexSession;

/** Metadata is always the first parsed record; never buffer the remainder here. */
async function parseSessionMetadata(filePath: string): Promise<CodexSessionMetadata | null> {
  let meta: Record<string, unknown> | undefined;
  try {
    for await (const row of streamRawLines(filePath, { maxLines: 1 })) {
      meta = row;
    }
  } catch {
    return null;
  }
  if (!meta || meta.type !== "session_meta") return null;

  const payload = (meta.payload ?? {}) as Record<string, unknown>;
  const id = (payload.id as string | undefined) ?? path.basename(filePath, ".jsonl");
  const startedAt = (payload.timestamp as string | undefined) ?? new Date(0).toISOString();
  const cwd = (payload.cwd as string | null | undefined) ?? null;
  const provider = (payload.model_provider as string | null | undefined) ?? null;
  const cliVersion = (payload.cli_version as string | null | undefined) ?? null;

  // model: prefer model_provider field; fall back to base_instructions if present
  let model: string | null = provider;
  const baseInstructions = payload.base_instructions;
  if (!model && typeof baseInstructions === "string" && baseInstructions.length > 0) {
    model = baseInstructions;
  }

  return {
    id,
    filename: filePath,
    startedAt,
    cwd,
    model,
    provider,
    cliVersion,
    userMessageCount: 0,
    turnCount: 0,
  };
}

/** Fold only the two listing counters while streaming one rollout line at a time. */
async function parseSessionCounts(
  filePath: string,
): Promise<{ userMessageCount: number; turnCount: number }> {
  let userMessageCount = 0;
  let turnCount = 0;
  try {
    for await (const row of streamRawLines(filePath)) {
      if (row.type !== "event_msg") continue;
      const p = (row.payload ?? {}) as Record<string, unknown>;
      const t = p.type as string | undefined;
      if (t === "user_message") userMessageCount++;
      if (t === "task_started") turnCount++;
    }
  } catch {
    // Preserve the old best-effort contract for files changed/removed mid-scan.
  }
  return { userMessageCount, turnCount };
}

/** Maximum simultaneous rollout streams for metadata and counter scans. */
export const CODEX_LIST_CONCURRENCY = 4;
const CODEX_SESSION_LIMIT = 200;

/** Consume an async source with a fixed worker count and no input-sized Promise array. */
async function runBounded<T>(
  source: AsyncIterable<T>,
  concurrency: number,
  task: (value: T) => Promise<void>,
): Promise<void> {
  const iterator = source[Symbol.asyncIterator]();
  const worker = async (): Promise<void> => {
    while (true) {
      const next = await iterator.next();
      if (next.done) return;
      await task(next.value);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
}

function newestFirst(a: CodexSession, b: CodexSession): number {
  const delta = Date.parse(b.startedAt) - Date.parse(a.startedAt);
  return Number.isFinite(delta) && delta !== 0 ? delta : b.filename.localeCompare(a.filename);
}

interface CodexCorpus {
  sessions: CodexSession[];
  stats: CodexStats;
}

async function scanCodexCorpus(sessionsDir: string): Promise<CodexCorpus> {
  const recent: CodexSessionMetadata[] = [];
  const cwdCounts = new Map<string, number>();
  const now = Date.now();
  const day30 = now - 30 * 24 * 60 * 60 * 1000;
  const day7 = now - 7 * 24 * 60 * 60 * 1000;
  let totalSessions = 0;
  let last30Days = 0;
  let last7Days = 0;

  await runBounded(findJsonlFiles(sessionsDir), CODEX_LIST_CONCURRENCY, async (file) => {
    const session = await parseSessionMetadata(file);
    if (!session) return;
    totalSessions++;
    const ts = Date.parse(session.startedAt);
    if (ts >= day30) last30Days++;
    if (ts >= day7) last7Days++;
    if (session.cwd) cwdCounts.set(session.cwd, (cwdCounts.get(session.cwd) ?? 0) + 1);

    // Retain only the response page; corpus-sized metadata never accumulates.
    recent.push(session);
    recent.sort(newestFirst);
    if (recent.length > CODEX_SESSION_LIMIT) recent.pop();
  });

  await runBounded(
    (async function* () {
      yield* recent;
    })(),
    CODEX_LIST_CONCURRENCY,
    async (session) => {
      Object.assign(session, await parseSessionCounts(session.filename));
    },
  );

  const topCwds = [...cwdCounts.entries()]
    .map(([cwd, count]) => ({ cwd, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);
  return { sessions: recent, stats: { totalSessions, last30Days, last7Days, topCwds } };
}

// The Home view requests sessions + stats together. Share that in-flight scan so
// concurrent HTTP requests cannot duplicate a multi-gigabyte corpus traversal.
const corpusScans = new Map<string, Promise<CodexCorpus>>();
function scanCodexCorpusOnce(sessionsDir: string): Promise<CodexCorpus> {
  const active = corpusScans.get(sessionsDir);
  if (active) return active;
  const scan = scanCodexCorpus(sessionsDir).finally(() => {
    if (corpusScans.get(sessionsDir) === scan) corpusScans.delete(sessionsDir);
  });
  corpusScans.set(sessionsDir, scan);
  return scan;
}

/**
 * List Codex sessions from <codex-home>/sessions/YYYY/MM/DD/rollout-*.jsonl.
 * Returns the most recent 200 sessions sorted by startedAt descending.
 * Gracefully returns [] if the directory does not exist.
 */
export async function listCodexSessions(
  codexHome = path.join(os.homedir(), ".codex"),
): Promise<CodexSession[]> {
  const sessionsDir = await resolveSessionsDir(codexHome);
  if (sessionsDir === null) return [];

  return (await scanCodexCorpusOnce(sessionsDir)).sessions;
}

/**
 * Aggregate stats across Codex sessions.
 */
export async function getCodexStats(
  codexHome = path.join(os.homedir(), ".codex"),
): Promise<CodexStats> {
  const sessionsDir = await resolveSessionsDir(codexHome);
  if (sessionsDir === null) {
    return { totalSessions: 0, last30Days: 0, last7Days: 0, topCwds: [] };
  }
  return (await scanCodexCorpusOnce(sessionsDir)).stats;
}
