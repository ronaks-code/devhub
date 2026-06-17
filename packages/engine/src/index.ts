/**
 * The engine's public API — the one contract every face depends on.
 * Framework-agnostic: callable in-process (TUI/desktop) or wrapped by the server (web).
 */
import { EventEmitter } from "node:events";
import path from "node:path";
import { stat } from "node:fs/promises";
import { TranscriptIndex } from "./index-db.js";
import type { SearchFacets } from "./search.js";
import { listRunningSessions } from "./running.js";
import { scanAllSessionFiles, isInternalFolder } from "./discovery.js";
import { hasArchive, archiveSession, readArchived } from "./archive.js";
import { readSessionMessages, listSubagentFiles, normalizeLine, streamRawLines } from "./parser.js";
import { GitService } from "./git.js";
import type { SettingsStore } from "./settings.js";
import type { ProjectMetaPatch } from "./project-meta.js";
import type {
  AppSettings,
  EngineEvent,
  NormalizedMessage,
  ProjectMeta,
  ProjectSummary,
  RunningSession,
  SearchHit,
  SessionMessagesPage,
  SessionSummary,
  Stats,
  TokenUsage,
} from "./types.js";
import { EMPTY_USAGE } from "./types.js";

export class Engine {
  readonly index: TranscriptIndex;
  /** User preferences (shares the index's DB connection). */
  readonly settings: SettingsStore;
  private emitter = new EventEmitter();
  private indexing = false;
  ready = false;

  constructor(dbPath?: string) {
    this.index = new TranscriptIndex(dbPath);
    this.settings = this.index.settings;
    this.emitter.setMaxListeners(0);
  }

  /** Full app settings (stored values layered over defaults). */
  getSettings(): AppSettings {
    return this.settings.getAll();
  }

  /** Merge a partial settings update; only provided keys are written. */
  setSettings(partial: Partial<AppSettings>): AppSettings {
    this.settings.setAll(partial);
    return this.settings.getAll();
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
        // Isolate per-file failures: one corrupt/locked transcript logs a warning
        // and is skipped, instead of aborting the entire index pass.
        try {
          await this.index.indexSession(f);
        } catch (err) {
          console.warn(`[engine] skipping unindexable session ${f}:`, err);
        }
        // One-time backfill: indexSession only archives when a file is new/changed,
        // so a session indexed before archiving existed would never get a copy.
        // Archive any discovered session still lacking one, independent of index
        // freshness. archiveSession is a cheap no-op skip when the source is huge.
        try {
          const sessionId = path.basename(f, ".jsonl");
          if (!(await hasArchive(sessionId))) {
            await archiveSession(f, sessionId);
          }
        } catch (err) {
          console.warn(`[engine] failed to backfill archive for ${f}:`, err);
        }
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

  getProjects(opts: { includeArchived?: boolean } = {}): ProjectSummary[] {
    return this.index.getProjects(opts);
  }

  getProjectSessions(projectId: string): SessionSummary[] {
    return this.index.getSessionsForProject(projectId);
  }

  /** Per-project UI metadata (favorite/archived/sortOrder/color), defaults when unset. */
  getProjectMeta(projectId: string): ProjectMeta {
    return this.index.getProjectMeta(projectId);
  }

  /** Merge a partial per-project UI-metadata update; returns the new value. */
  setProjectMeta(projectId: string, patch: ProjectMetaPatch): ProjectMeta {
    return this.index.setProjectMeta(projectId, patch);
  }

  /** Read-only git introspection for a project working directory. */
  git(cwd: string): GitService {
    return new GitService(cwd);
  }

  getSession(sessionId: string): SessionSummary | undefined {
    return this.index.getSessionSummary(sessionId);
  }

  /** Read one session's tags (normalized; empty when untagged). */
  getTags(sessionId: string): string[] {
    return this.index.getTags(sessionId);
  }

  /**
   * Replace a session's tags. Values are normalized on write (trimmed, lower-cased,
   * de-duped) and stored as a JSON array in session_meta.tags. Returns the persisted
   * set. These also feed the `tag` search facet and the `tags` SessionSummary field.
   */
  setTags(sessionId: string, tags: string[]): string[] {
    return this.index.setTags(sessionId, tags);
  }

  /** Every distinct tag in use with its session count (count desc, then name asc). */
  getAllTags(): Array<{ tag: string; count: number }> {
    return this.index.getAllTags();
  }

  /**
   * Cross-project full-text search. `{ limit }` alone preserves the original
   * behavior; the optional facets (projectId/role/toolName/since/until/gitBranch)
   * narrow the results and are AND-ed onto the text match.
   */
  search(query: string, opts: SearchFacets = {}): SearchHit[] {
    return this.index.search(query, opts);
  }

  /**
   * Currently-running claude processes, read from ~/.claude/sessions/<pid>.json.
   * Delegates to the `running` module, which reads the ephemeral files AND probes
   * each PID for liveness — stale/zombie entries are flagged (`alive: false`,
   * `status: "dead"`) so faces don't present a dead file as a live session.
   * Tolerant: missing dir => [], unparseable/internal entries skipped, sorted by
   * `updatedAt` (most recently active first).
   */
  async getRunningSessions(): Promise<RunningSession[]> {
    return listRunningSessions();
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

    // Live path: read the on-disk transcript. If stat() fails (Claude Code deleted
    // it after ~30 days, or the file moved), fall back to our gzip archive so the
    // session stays viewable.
    let sourceExists = true;
    try {
      await stat(summary.filePath);
    } catch {
      sourceExists = false;
    }

    if (sourceExists) {
      const { messages, truncatedFromStart } = await readSessionMessages(summary.filePath, opts);
      const sessionDir = path.join(path.dirname(summary.filePath), sessionId);
      const subagents = summary.hasSubagents ? await listSubagentFiles(sessionDir) : [];
      return { session: summary, messages, truncatedFromStart, subagents };
    }

    const archived = await readArchived(sessionId);
    if (!archived) return undefined; // source gone AND no archive — nothing to show
    const messages: NormalizedMessage[] = [];
    let seq = 0;
    for (const raw of archived) {
      const m = normalizeLine(raw, seq);
      if (m) {
        messages.push(m);
        seq++;
      }
    }
    // Subagent files live next to the (now-deleted) source, so they're unavailable
    // here; the archive holds the main transcript only.
    return { session: summary, messages, truncatedFromStart: false, subagents: [] };
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
export { MessageSearch } from "./search.js";
export type { SearchFacets } from "./search.js";
export { listRunningSessions, isPidAlive } from "./running.js";
export { SettingsStore } from "./settings.js";
export { watchTranscripts } from "./watcher.js";
export { CliDriver, createDriver } from "./driver/cli.js";
export { detectSourceKind } from "./discovery.js";
export type { SourceKind } from "./discovery.js";
export { archiveSession, hasArchive, readArchived, archiveDir, archivePath } from "./archive.js";
export { costUsd, pricingForModel, MODEL_PRICING, FALLBACK_PRICING } from "./pricing.js";
export type { ModelPricing } from "./pricing.js";
export { GitService, parseStatus } from "./git.js";
export type { GitStatus, GitBranch, GitLogEntry, GitDiff } from "./git.js";
export { ProjectMetaStore } from "./project-meta.js";
export type { ProjectMetaPatch } from "./project-meta.js";
export { TagStore, parseTags, normalizeTags } from "./tags.js";
export { createLineSplitter, DEFAULT_MAX_LINE_BYTES } from "./driver/buffer.js";
export type { LineSplitter, LineSplitterOptions } from "./driver/buffer.js";
export * as config from "./config/index.js";
export * as paths from "./paths.js";
export * from "./types.js";
export type * from "./driver/types.js";
