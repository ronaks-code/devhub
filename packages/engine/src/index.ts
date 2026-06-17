/**
 * The engine's public API — the one contract every face depends on.
 * Framework-agnostic: callable in-process (TUI/desktop) or wrapped by the server (web).
 */
import { EventEmitter } from "node:events";
import path from "node:path";
import { stat, readdir, readFile } from "node:fs/promises";
import { TranscriptIndex } from "./index-db.js";
import { scanAllSessionFiles, isInternalFolder } from "./discovery.js";
import { liveSessionsDir } from "./paths.js";
import { readSessionMessages, listSubagentFiles, normalizeLine, streamRawLines } from "./parser.js";
import type {
  EngineEvent,
  NormalizedMessage,
  ProjectSummary,
  RunningSession,
  SearchHit,
  SessionMessagesPage,
  SessionSummary,
  Stats,
  TokenUsage,
} from "./types.js";
import { EMPTY_USAGE } from "./types.js";

/** A cwd belongs to an internal/plugin store, not a real coding session. */
function isInternalCwd(cwd: string): boolean {
  return cwd.includes("/.claude-mem/") || cwd.includes("claude-mem");
}

export class Engine {
  readonly index: TranscriptIndex;
  private emitter = new EventEmitter();
  private indexing = false;
  ready = false;

  constructor(dbPath?: string) {
    this.index = new TranscriptIndex(dbPath);
    this.emitter.setMaxListeners(0);
  }

  /** Subscribe to engine events (index progress, session add/change). Returns an unsubscribe fn. */
  on(fn: (e: EngineEvent) => void): () => void {
    this.emitter.on("event", fn);
    return () => this.emitter.off("event", fn);
  }
  private emit(e: EngineEvent): void {
    this.emitter.emit("event", e);
  }

  /** Incrementally (re)index every session across every project. Safe to call repeatedly. */
  async indexAll(): Promise<void> {
    if (this.indexing) return;
    this.indexing = true;
    try {
      const files = await scanAllSessionFiles();
      // Index newest-first so the user's recent, real work appears immediately
      // (old/huge archives index last).
      const withMtime = await Promise.all(
        files.map(async (f) => {
          try {
            return { f, m: (await stat(f)).mtimeMs };
          } catch {
            return { f, m: 0 };
          }
        }),
      );
      withMtime.sort((a, b) => b.m - a.m);
      const sorted = withMtime.map((x) => x.f);
      let done = 0;
      for (const f of sorted) {
        await this.index.indexSession(f);
        done++;
        if (done % 10 === 0 || done === sorted.length) {
          this.emit({ kind: "index-progress", done, total: sorted.length });
        }
      }
      this.ready = true;
      this.emit({ kind: "ready" });
    } finally {
      this.indexing = false;
    }
  }

  getProjects(): ProjectSummary[] {
    return this.index.getProjects();
  }

  getProjectSessions(projectId: string): SessionSummary[] {
    return this.index.getSessionsForProject(projectId);
  }

  getSession(sessionId: string): SessionSummary | undefined {
    return this.index.getSessionSummary(sessionId);
  }

  search(query: string, opts: { limit?: number } = {}): SearchHit[] {
    return this.index.search(query, opts.limit);
  }

  /**
   * Currently-running claude processes, read from ~/.claude/sessions/<pid>.json.
   * These files are ephemeral and may be stale — we just reflect what's on disk.
   * Tolerant: missing dir => [], unparseable/internal entries are skipped.
   * Sorted by `updatedAt` (most recently active first).
   */
  async getRunningSessions(): Promise<RunningSession[]> {
    let names: string[];
    try {
      names = await readdir(liveSessionsDir());
    } catch {
      return []; // no sessions dir yet
    }
    const out: RunningSession[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      let raw: Record<string, unknown>;
      try {
        raw = JSON.parse(await readFile(path.join(liveSessionsDir(), name), "utf8"));
      } catch {
        continue; // skip unreadable / unparseable files
      }
      if (!raw || typeof raw !== "object") continue;
      const cwd = typeof raw.cwd === "string" ? raw.cwd : null;
      if (cwd && isInternalCwd(cwd)) continue; // drop claude-mem etc.
      out.push({
        pid: typeof raw.pid === "number" ? raw.pid : 0,
        sessionId: typeof raw.sessionId === "string" ? raw.sessionId : "",
        cwd,
        status: typeof raw.status === "string" ? raw.status : "unknown",
        model: typeof raw.model === "string" ? raw.model : null,
        startedAt: typeof raw.startedAt === "number" ? raw.startedAt : null,
        updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : null,
        name: typeof raw.name === "string" ? raw.name : null,
        entrypoint: typeof raw.entrypoint === "string" ? raw.entrypoint : null,
      });
    }
    out.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    return out;
  }

  /** Aggregate usage/activity analytics computed from the index. */
  getStats(): Stats {
    const totalSessions = this.index.getSessionCount();
    const projects = this.index.getProjects();

    let totalUsage: TokenUsage = { ...EMPTY_USAGE };
    for (const p of projects) {
      totalUsage.inputTokens += p.totalUsage.inputTokens;
      totalUsage.outputTokens += p.totalUsage.outputTokens;
      totalUsage.cacheReadTokens += p.totalUsage.cacheReadTokens;
      totalUsage.cacheCreationTokens += p.totalUsage.cacheCreationTokens;
    }

    const topProjects = projects
      .map((p) => ({
        projectId: p.id,
        name: p.name,
        sessions: p.sessionCount,
        tokens:
          p.totalUsage.inputTokens +
          p.totalUsage.outputTokens +
          p.totalUsage.cacheReadTokens +
          p.totalUsage.cacheCreationTokens,
      }))
      .sort((a, b) => b.tokens - a.tokens)
      .slice(0, 8);

    return {
      totalSessions,
      totalProjects: projects.length,
      totalUsage,
      topProjects,
      activity: this.buildActivity(),
    };
  }

  /**
   * Sessions-per-day for the last 30 calendar days (UTC), oldest→newest, with
   * zero-count days included. Each session counts on the day of its last activity.
   */
  private buildActivity(): Array<{ date: string; sessions: number }> {
    const counts = new Map<string, number>();
    for (const ts of this.index.getActivityDates()) {
      const day = ts.slice(0, 10); // ISO `lastTs` is already YYYY-MM-DD... (UTC)
      if (day.length === 10) counts.set(day, (counts.get(day) ?? 0) + 1);
    }
    const out: Array<{ date: string; sessions: number }> = [];
    const todayUtc = Date.UTC(
      new Date().getUTCFullYear(),
      new Date().getUTCMonth(),
      new Date().getUTCDate(),
    );
    for (let i = 29; i >= 0; i--) {
      const date = new Date(todayUtc - i * 86_400_000).toISOString().slice(0, 10);
      out.push({ date, sessions: counts.get(date) ?? 0 });
    }
    return out;
  }

  async getSessionMessages(
    sessionId: string,
    opts: { tailBytes?: number } = {},
  ): Promise<SessionMessagesPage | undefined> {
    const summary = this.index.getSessionSummary(sessionId);
    if (!summary) return undefined;
    const { messages, truncatedFromStart } = await readSessionMessages(summary.filePath, opts);
    const sessionDir = path.join(path.dirname(summary.filePath), sessionId);
    const subagents = summary.hasSubagents ? await listSubagentFiles(sessionDir) : [];
    return { session: summary, messages, truncatedFromStart, subagents };
  }

  /** Read a single subagent transcript file (already-discovered path). */
  async getSubagentMessages(filePath: string): Promise<NormalizedMessage[]> {
    const out: NormalizedMessage[] = [];
    let seq = 0;
    for await (const raw of streamRawLines(filePath)) {
      const m = normalizeLine(raw, seq, path.basename(filePath, ".jsonl"));
      if (m) {
        out.push(m);
        seq++;
      }
    }
    return out;
  }

  /** Called by the watcher when a transcript file changes. */
  async onFileChanged(filePath: string): Promise<void> {
    if (isInternalFolder(path.dirname(filePath))) return; // skip claude-mem etc.
    const result = await this.index.indexSession(filePath);
    if (result === "added" || result === "updated") {
      const sessionId = path.basename(filePath, ".jsonl");
      const s = this.index.getSessionSummary(sessionId);
      this.emit({
        kind: result === "added" ? "session-added" : "session-changed",
        sessionId,
        projectId: s?.projectId ?? "unknown",
      });
    }
  }

  close(): void {
    this.index.close();
  }
}

export { TranscriptIndex } from "./index-db.js";
export { watchTranscripts } from "./watcher.js";
export { CliDriver, createDriver } from "./driver/cli.js";
export * as paths from "./paths.js";
export * from "./types.js";
export type * from "./driver/types.js";
