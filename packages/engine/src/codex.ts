/**
 * Codex session discovery — reads ~/.codex/sessions/**\/rollout-*.jsonl files.
 * Each .jsonl is one session; the first line is a session_meta record and
 * subsequent lines are event_msg records.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

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
async function findJsonlFiles(dir: string): Promise<string[]> {
  const results: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = await findJsonlFiles(full);
      results.push(...sub);
    } else if (entry.isFile() && entry.name.startsWith("rollout-") && entry.name.endsWith(".jsonl")) {
      results.push(full);
    }
  }
  return results;
}

/**
 * Parse one .jsonl session file into a CodexSession.
 * Returns null if the file is unreadable or missing a valid session_meta first line.
 */
async function parseSessionFile(filePath: string): Promise<CodexSession | null> {
  let content: string;
  try {
    content = await fs.promises.readFile(filePath, "utf8");
  } catch {
    return null;
  }

  const lines = content.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) return null;

  // First line must be session_meta
  const firstLine = lines[0];
  if (!firstLine) return null;
  let meta: Record<string, unknown>;
  try {
    meta = JSON.parse(firstLine) as Record<string, unknown>;
  } catch {
    return null;
  }

  if ((meta as { type?: string }).type !== "session_meta") return null;

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

  let userMessageCount = 0;
  let turnCount = 0;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (row.type !== "event_msg") continue;
    const p = (row.payload ?? {}) as Record<string, unknown>;
    const t = p.type as string | undefined;
    if (t === "user_message") userMessageCount++;
    if (t === "task_started") turnCount++;
  }

  return {
    id,
    filename: filePath,
    startedAt,
    cwd,
    model,
    provider,
    cliVersion,
    userMessageCount,
    turnCount,
  };
}

/**
 * List Codex sessions from ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl.
 * Returns the most recent 200 sessions sorted by startedAt descending.
 * Gracefully returns [] if the directory does not exist.
 */
export async function listCodexSessions(): Promise<CodexSession[]> {
  const sessionsDir = path.join(os.homedir(), ".codex", "sessions");

  try {
    await fs.promises.stat(sessionsDir);
  } catch {
    // ~/.codex/sessions doesn't exist — Codex not installed or never run
    return [];
  }

  const files = await findJsonlFiles(sessionsDir);
  if (files.length === 0) return [];

  // Parse all files concurrently
  const parsed = await Promise.all(files.map(parseSessionFile));
  const sessions = parsed.filter((s): s is CodexSession => s !== null);

  // Sort newest first
  sessions.sort((a, b) => {
    const ta = new Date(a.startedAt).getTime();
    const tb = new Date(b.startedAt).getTime();
    return tb - ta;
  });

  // Limit to 200 most recent
  return sessions.slice(0, 200);
}

/**
 * Aggregate stats across Codex sessions.
 */
export async function getCodexStats(): Promise<CodexStats> {
  const sessions = await listCodexSessions();
  const now = Date.now();
  const day30 = now - 30 * 24 * 60 * 60 * 1000;
  const day7 = now - 7 * 24 * 60 * 60 * 1000;

  let last30Days = 0;
  let last7Days = 0;
  const cwdCounts = new Map<string, number>();

  for (const s of sessions) {
    const ts = new Date(s.startedAt).getTime();
    if (ts >= day30) last30Days++;
    if (ts >= day7) last7Days++;
    if (s.cwd) {
      cwdCounts.set(s.cwd, (cwdCounts.get(s.cwd) ?? 0) + 1);
    }
  }

  const topCwds = Array.from(cwdCounts.entries())
    .map(([cwd, count]) => ({ cwd, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  return {
    totalSessions: sessions.length,
    last30Days,
    last7Days,
    topCwds,
  };
}
