/**
 * The engine's public API — the one contract every face depends on.
 * Framework-agnostic: callable in-process (TUI/desktop) or wrapped by the server (web).
 */
import { EventEmitter } from "node:events";
import path from "node:path";
import { stat } from "node:fs/promises";
import { TranscriptIndex } from "./index-db.js";
import type { SearchFacets } from "./search.js";
import type { ListAllSessionsOptions } from "./all-sessions.js";
import type { DailyUsage, DailyUsageOptions } from "./rollups.js";
import { budgetStatus, type BudgetStatus } from "./budget.js";
import {
  budgetGuardStatus,
  guardTurn,
  type BudgetGuardStatus,
  type BudgetGuardOptions,
  type GuardTurnOptions,
  type TurnGuardDecision,
} from "./budget-guard.js";
import { listRunningSessions } from "./running.js";
import { scanAllSessionFiles, isInternalFolder } from "./discovery.js";
import { hasArchive, archiveSession, readArchived } from "./archive.js";
import { readSessionMessages, listSubagentFiles, normalizeLine, streamRawLines } from "./parser.js";
import { listCheckpoints, restoreCheckpoint } from "./checkpoint.js";
import type { Checkpoint, RestoreResult } from "./checkpoint.js";
import { GitService } from "./git.js";
import type { SettingsStore } from "./settings.js";
import type { ProjectMetaPatch } from "./project-meta.js";
import type { SavedView, SaveViewInput } from "./saved-views.js";
import { WebhookConfigStore } from "./webhooks.js";
import type { WebhookConfig } from "./webhooks.js";
import type { AuditDecisionInput, AuditEntry } from "./audit.js";
import { getSessionCommits } from "./session-commits.js";
import type { SessionCommit } from "./session-commits.js";
import { aggregateFileChanges } from "./file-changes.js";
import type { SessionFileChanges } from "./file-changes.js";
import type { PermissionDenial } from "./driver/types.js";
import { listMcpServers } from "./config/index.js";
import { testMcpServer } from "./config/mcp-test.js";
import type { McpTestResult } from "./config/mcp-test.js";
import { resolveEffectiveConfig } from "./config/effective.js";
import type { EffectiveConfig } from "./config/effective.js";
import { searchConfig } from "./config/index-config.js";
import type { ConfigSearchHit } from "./config/index-config.js";
import { hybridSearch } from "./embeddings.js";
import type { HybridSearchOptions } from "./embeddings.js";
import { searchSymbols } from "./symbols.js";
import type { SymbolHit, SymbolSearchOptions } from "./symbols.js";
import { parseRateLimit } from "./rate-limit.js";
import type { RateLimitInfo } from "./rate-limit.js";
import { computeRetry } from "./retry-policy.js";
import type { RetryDecision, RetryOptions } from "./retry-policy.js";
import { listPlugins } from "./config/index.js";
import type { PluginInfo } from "./config/index.js";
import { setMcpEnabled, listMcpToggles } from "./config/mcp-toggle.js";
import type { McpToggle } from "./config/mcp-toggle.js";
import { computeAutoTags, mergeAutoTags } from "./auto-tag.js";
import type { RelatedOptions, RelatedSession } from "./related.js";
import type { ToolStatsOptions, ToolStatsResult } from "./tool-stats.js";
import type { ProjectOverview } from "./project-overview.js";
import type { IntegrityReport, RepairOptions, RepairResult } from "./integrity.js";
import type {
  ArchiveBundle,
  ExportArchiveOptions,
  ImportArchiveOptions,
  ImportArchiveResult,
} from "./portable.js";
import type { TurnResult } from "./driver/types.js";
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
  /** Outbound webhook subscriptions, persisted via {@link settings}. */
  readonly webhooks: WebhookConfigStore;
  private emitter = new EventEmitter();
  private indexing = false;
  ready = false;

  constructor(dbPath?: string) {
    this.index = new TranscriptIndex(dbPath);
    this.settings = this.index.settings;
    this.webhooks = new WebhookConfigStore(this.settings);
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

  /**
   * Emit a `config-changed` event for `changedPath` (a Claude Code config file/dir).
   * Called by the config watcher ({@link startConfigWatcher}); kept as a narrow
   * public method so the watcher doesn't need access to the private event bus.
   */
  emitConfigChanged(changedPath: string): void {
    this.emit({ kind: "config-changed", path: changedPath });
  }

  /**
   * Incrementally (re)index every session across every project. Safe to call repeatedly.
   *
   * `opts.force` re-runs a FULL re-index of EVERY discovered session even when its file
   * size+mtime are unchanged (the default incremental/skip-unchanged behavior is bypassed
   * per file). This is the backfill path for the W28 `tool_calls` sidecar AND the
   * currently-null `sessions.model` on pre-model-tracking rows. It still isolates per-file
   * failures, still emits progress, and is guarded by the same single-flight `indexing`
   * latch — so it's safe to kick off in the background. Without `force` the behavior is
   * identical to before.
   */
  async indexAll(opts: { force?: boolean } = {}): Promise<void> {
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
          await this.index.indexSession(f, { force: opts.force });
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

  getProjectSessions(
    projectId: string,
    opts: { includeArchived?: boolean } = {},
  ): SessionSummary[] {
    return this.index.getSessionsForProject(projectId, opts);
  }

  /**
   * Archive (or un-archive) a session. Archived sessions drop out of
   * getProjectSessions / listAllSessions (and getProjects' counts) unless an
   * includeArchived flag is passed. Stored in session_meta — never touches the
   * transcript.
   */
  setArchived(sessionId: string, archived: boolean): void {
    this.index.setArchived(sessionId, archived);
  }

  /**
   * Cross-project session listing for a global "All Sessions" view: every project's
   * sessions in one list, with optional projectId/tag/model filters, a sort
   * ("recent" | "tokens" | "messages" | "cost"), and limit/offset paging. The "cost"
   * sort ranks by estimated per-session spend (top-spenders first). Reuses the index
   * (no transcript reads).
   */
  listAllSessions(opts: ListAllSessionsOptions = {}): SessionSummary[] {
    return this.index.listAllSessions(opts);
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

  /**
   * Best-effort connectivity test for one configured MCP server, looked up by name.
   * Pass `scopeCwd` to also consider that project's `~/.claude.json` per-project
   * servers (a project entry of the same name shadows the global one). For stdio
   * servers this spawns the command and attempts an MCP `initialize` handshake; for
   * http/sse servers it does a reachability check. Returns `{ ok:false, error }` when
   * no server by that name is configured.
   */
  async testMcpServer(name: string, scopeCwd?: string): Promise<McpTestResult> {
    const servers = await listMcpServers(scopeCwd);
    // A project-scoped entry of the same name takes precedence over the global one.
    const match =
      servers.filter((s) => s.name === name).sort((a, b) => (a.scope === "project" ? -1 : 1))[0];
    if (!match) return { ok: false, error: `no MCP server named "${name}"` };
    return testMcpServer(match);
  }

  /**
   * The fully-merged EFFECTIVE Claude Code config for a project: every settings.json
   * key with its winning scope + per-scope provenance, the merged hooks + accumulated
   * permission lists the runtime applies, and the ACTIVE agents/skills/commands/mcp
   * servers (a project entry shadows a global of the same name, flagged `shadowedBy`).
   * Omit `projectCwd` for a user/global-only view. Read-only; tolerant of a half-
   * configured machine. See {@link resolveEffectiveConfig}.
   */
  async getEffectiveConfig(projectCwd?: string): Promise<EffectiveConfig> {
    return resolveEffectiveConfig(projectCwd);
  }

  /**
   * Flat, relevance-ranked search across ALL Claude Code config artifacts — agents,
   * skills, commands, MCP server names, settings/permission keys, hook events, and
   * CLAUDE.md content — for a config command palette. Case-insensitive substring-then-
   * fuzzy matching; a blank query returns []. Pass `projectCwd` to also include that
   * project's scoped config (project + global entries are returned side by side, each
   * with its own scope). `opts.limit` caps the result count. Read-only and tolerant of a
   * half-configured machine. See {@link searchConfig}.
   */
  async searchConfig(
    query: string,
    projectCwd?: string,
    opts: { limit?: number } = {},
  ): Promise<ConfigSearchHit[]> {
    return searchConfig(query, projectCwd, opts);
  }

  /**
   * Inspect a finished turn ({@link TurnResult}) or a raw error string for any
   * rate-limit / max-budget / overloaded signal — so the server/UI can show a banner
   * or schedule a resume. Returns `{ limited, reason?, resetAt?, signal? }`. Pure
   * delegation to {@link parseRateLimit}; exposed here so faces reach it off the
   * engine instance without a separate import.
   */
  parseRateLimit(resultOrError: TurnResult | string | null | undefined, now?: number): RateLimitInfo {
    return parseRateLimit(resultOrError, now);
  }

  /**
   * Decide whether a finished turn should be retried (and after how long) when the
   * CLI/API throttled it. Retries only on a transient `rate_limit` / `overloaded`
   * signal, never on `max_budget` or a clean/aborted turn, and is bounded by
   * `opts.maxAttempts`. Pure delegation to {@link computeRetry}; exposed here so a face
   * can drive an opt-in retry loop off the engine instance without a separate import.
   */
  computeRetry(
    resultOrError: TurnResult | string | null | undefined,
    attempt: number,
    opts?: RetryOptions,
  ): RetryDecision {
    return computeRetry(resultOrError, attempt, opts);
  }

  /**
   * Installed Claude Code plugins, flattened from
   * `~/.claude/plugins/installed_plugins.json` (cross-referenced with
   * known_marketplaces.json + blocklist.json) to
   * `[{ name, version, marketplace, enabled, scope }]`. Read-only and tolerant of a
   * machine with no plugins (returns []). See {@link listPlugins}.
   */
  async listPlugins(): Promise<PluginInfo[]> {
    return listPlugins();
  }

  /**
   * Every known project MCP server for `projectPath` with its resolved on/off state,
   * honoring that project's `.claude/settings.json` toggle fields
   * (disableAllProjectMcpServers / enabledMcpjsonServers / disabledMcpjsonServers).
   * Read-only and tolerant of a project with no MCP config. See {@link listMcpToggles}.
   */
  async listMcpToggles(projectPath: string): Promise<McpToggle[]> {
    return listMcpToggles(projectPath);
  }

  /**
   * Toggle one project MCP server on/off by editing that project's `.claude/settings.json`
   * (SAFE write: validate → rotating `.bak` backup → atomic write). The server's DEFINITION
   * is never touched, so the toggle is reversible. Returns the new resolved state. See
   * {@link setMcpEnabled}.
   */
  async setMcpEnabled(projectPath: string, serverName: string, enabled: boolean): Promise<McpToggle> {
    return setMcpEnabled(projectPath, serverName, enabled);
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
   * SUGGESTED auto-tags for a session, derived from its project's language/framework
   * (marker files in the session's cwd) plus a `branch:<slug>` tag for a non-default git
   * branch. Looks up the session's cwd + gitBranch from the index, then delegates to
   * {@link computeAutoTags}. Does NOT persist — a face/route decides whether to apply them
   * via {@link setTags}. Returns [] for an unknown session or when nothing can be derived.
   */
  autoTagSession(sessionId: string): string[] {
    const summary = this.index.getSessionSummary(sessionId);
    if (!summary) return [];
    return computeAutoTags({ cwd: summary.cwd, gitBranch: summary.gitBranch });
  }

  /**
   * APPLY the suggested auto-tags to a session: compute suggestions via {@link autoTagSession},
   * merge them into the session's existing tags (set union, normalized/de-duped via the shared
   * tag normalization in {@link mergeAutoTags}), and persist the result via {@link setTags}.
   *
   * Returns `{ applied, added }` — `applied` is the full resulting tag set, `added` only the newly
   * added tags. Idempotent: a second call adds nothing (`added: []`) since the suggestions are
   * already present. Existing user tags are preserved (union, never dropped). An unknown session
   * is a no-op (`{ applied: [], added: [] }`) and never throws — pairs with the suggestions-only
   * {@link autoTagSession} for a "preview before apply" UX.
   */
  applyAutoTags(sessionId: string): { applied: string[]; added: string[] } {
    const suggested = this.autoTagSession(sessionId);
    // Unknown session (or nothing to suggest with no prior tags) -> no-op, no write.
    if (!this.index.getSessionSummary(sessionId)) return { applied: [], added: [] };
    const existing = this.getTags(sessionId);
    const { applied, added } = mergeAutoTags(existing, suggested);
    if (added.length) this.setTags(sessionId, applied);
    return { applied, added };
  }

  /**
   * Read a session's free-form notes (markdown), or null when none. User-owned
   * scratchpad in session_meta — never derived from the transcript.
   */
  getNotes(sessionId: string): string | null {
    return this.index.getNotes(sessionId);
  }

  /**
   * Set (or clear) a session's notes (markdown). A blank value clears them. Stored
   * in session_meta — never touches the transcript. The value also surfaces on the
   * `notes` field of {@link SessionSummary}.
   */
  setNotes(sessionId: string, md: string | null): void {
    this.index.setNotes(sessionId, md);
  }

  /**
   * Record one permission DECISION (allow/deny for a tool call) in the audit log.
   * Returns the stored entry. Our own data in session_meta's sibling
   * `permission_audit` table; never touches the transcript.
   */
  logPermissionDecision(input: AuditDecisionInput): AuditEntry {
    return this.index.audit.logDecision(input);
  }

  /**
   * Capture the result-level `permission_denials` a turn reported (as implicit deny
   * decisions, scope "result"). The server calls this when a turn ends so denials
   * that never surfaced an inline prompt still land in the audit trail. Returns the
   * rows written (one per denial; [] when none).
   */
  logTurnDenials(
    denials: PermissionDenial[],
    opts: { sessionId?: string | null; ts?: number } = {},
  ): AuditEntry[] {
    return this.index.audit.logResultDenials(denials, opts);
  }

  /**
   * Best-effort audit hook the server's WS turn loop calls when a turn ends with
   * tool-permission denials: records each as an implicit "deny" decision (scope
   * "result") in the `permission_audit` table via {@link logTurnDenials}. Argument
   * order mirrors the WS call site (sessionId first, which may be null). A no-op for
   * an empty/absent `denials` list, and never throws — a failure to log must never
   * fail the turn that produced the denials.
   */
  auditPermissionDenials(sessionId: string | null, denials: PermissionDenial[]): void {
    if (!denials || denials.length === 0) return;
    try {
      this.logTurnDenials(denials, { sessionId });
    } catch {
      // Audit logging is best-effort: swallow any write failure so it can't break
      // the turn. The denials are already surfaced to the user via the result frame.
    }
  }

  /**
   * Recent permission-decision audit entries, newest first. `{ sessionId }` scopes
   * to one session; `{ limit }` caps the row count (default 100).
   */
  listAudit(opts: { limit?: number; sessionId?: string | null } = {}): AuditEntry[] {
    return this.index.audit.list(opts);
  }

  /**
   * The git commits a session LIKELY produced: commits in the session's cwd authored
   * within its first→last activity window (padded). Best-effort — `[]` for a session
   * with no cwd, a non-git cwd, or an unknown session id. Read-only (uses {@link git}).
   */
  async getSessionCommits(sessionId: string): Promise<SessionCommit[]> {
    const summary = this.index.getSessionSummary(sessionId);
    if (!summary) return [];
    return getSessionCommits(summary, (cwd) => this.git(cwd));
  }

  /**
   * The project files a session EDITED or WROTE: one display-friendly row per file
   * ({@link FileChange}) plus a headline summary, derived from the session's
   * Edit/MultiEdit/Write/NotebookEdit tool_use blocks. Reuses the SAME bounded
   * message-loading path as {@link getSessionMessages} (a single transcript read of THIS
   * session — never a corpus scan), then folds it with the pure {@link aggregateFileChanges}.
   * Paths are relativized against the session cwd for display (with the absolute path kept).
   * Best-effort — an unknown session, or one with no file edits, returns an empty result;
   * tolerant of partial/odd tool inputs. See {@link aggregateFileChanges}.
   */
  async sessionFileChanges(sessionId: string): Promise<SessionFileChanges> {
    const page = await this.getSessionMessages(sessionId);
    if (!page) return { files: [], summary: { fileCount: 0, editCount: 0, writeCount: 0 } };
    return aggregateFileChanges(page.messages, page.session.cwd);
  }

  /**
   * Saved views ("smart folders") — a named, re-runnable (query + facets). A view
   * is exactly what {@link search} understands, so re-running one is
   * `engine.search(view.query, view.facets)`. Newest first.
   */
  listSavedViews(): SavedView[] {
    return this.index.listSavedViews();
  }

  /**
   * Persist a new saved view (smart folder). `name` is required (trimmed); `query`
   * and `facets` default to "" / {}. Returns the stored view (with id + createdAt).
   */
  saveView(input: SaveViewInput): SavedView {
    return this.index.saveView(input);
  }

  /** Delete a saved view by id; returns true when a row was removed. */
  deleteView(id: number): boolean {
    return this.index.deleteView(id);
  }

  /**
   * Outbound webhook subscriptions (POSTed by the server on engine events). The
   * engine owns the durable list + the pure payload/matcher helpers; it performs NO
   * network I/O — the server lane does the firing (timeout/abort/scheme guards).
   * Returns the stored list (default []).
   */
  getWebhooks(): WebhookConfig[] {
    return this.webhooks.list();
  }

  /**
   * Replace the whole webhook list. VALIDATES every entry (http/https url, known event
   * kinds) and de-dupes ids before persisting via the settings store; throws (without
   * writing) on the first invalid entry. Returns the normalized, stored list.
   */
  setWebhooks(list: unknown): WebhookConfig[] {
    return this.webhooks.set(list);
  }

  /** Insert or replace one webhook (matched by id). Validates it; returns the new full list. */
  upsertWebhook(wh: unknown): WebhookConfig[] {
    return this.webhooks.upsert(wh);
  }

  /** Remove one webhook by id; returns the new full list (unchanged when absent). */
  deleteWebhook(id: string): WebhookConfig[] {
    return this.webhooks.delete(id);
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
   * The SECOND search lane: FTS primary + an OPTIONAL semantic rerank on top. With no
   * `CLAUDE_UI_EMBED_PROVIDER` configured (the default) this returns EXACTLY what
   * {@link search} returns — same hits, same order — at no added cost. When a provider
   * is configured (the built-in dependency-free "lexical" overlap reranker, or a host-
   * supplied one passed via `opts.provider`), it pulls a wider FTS candidate set and
   * reorders it by relevance to `query`. FTS stays the source of truth for WHICH rows
   * match; the reranker only reorders. See {@link hybridSearch}.
   */
  async searchHybrid(
    query: string,
    facets: SearchFacets = {},
    opts: HybridSearchOptions = {},
  ): Promise<SearchHit[]> {
    return hybridSearch((q, f) => this.index.search(q, f), query, facets, opts);
  }

  /**
   * ALL matching message rows within ONE session (not deduped to a single best
   * hit), ordered by in-session `seq`, for an expandable "all matches in this
   * conversation" view. `{ limit }` caps the row count.
   */
  searchInSession(sessionId: string, query: string, opts: { limit?: number } = {}): SearchHit[] {
    return this.index.searchInSession(sessionId, query, opts);
  }

  /**
   * The OTHER sessions most related to a given one — a cheap, deterministic "related
   * work" rank built only from signals already in the index (shared significant terms
   * from the mirrored text, same project, shared tags/tools, temporal proximity). No
   * embeddings or transcript reads. The source session is always excluded; an unknown
   * id returns []. Each hit carries a score + a short reason. See {@link relatedSessions}.
   */
  relatedSessions(sessionId: string, opts: RelatedOptions = {}): RelatedSession[] {
    return this.index.relatedSessions(sessionId, opts);
  }

  /**
   * Per-tool usage analytics across the indexed corpus (or one project/session when
   * scoped via `opts.projectId` / `opts.sessionId`): a ranked `[{ toolName, count, … }]`
   * plus a corpus totals summary. Computed with a single GROUP BY aggregate over the
   * indexed tool-invocation rows (no transcript reads, no per-row scan). Error counts
   * and durations are not persisted in the index, so they degrade gracefully (errors 0,
   * `avgMs` omitted). A tool-less corpus returns []. See {@link toolStats}.
   */
  toolStats(opts: ToolStatsOptions = {}): ToolStatsResult {
    return this.index.toolStats(opts);
  }

  /**
   * A single BOUNDED per-project aggregate for a project deep-dive: headline totals
   * (sessionCount/cost/tokens/firstTs/lastTs) plus a per-model split, top tools, a
   * ~30-day daily-cost series, and the project's tag cloud — assembled from a few bounded
   * queries (GROUP BY / reused rollup helpers), NOT a per-session scan. No transcript
   * reads. An unknown projectId returns a well-formed empty overview, never a throw.
   * See {@link projectOverview}.
   */
  projectOverview(projectId: string): ProjectOverview {
    return this.index.projectOverview(projectId);
  }

  /**
   * Read-only INTEGRITY diagnostic over the index DB: a set of bounded queries that flag
   * orphaned sidecar/search rows (parent session gone), sessions whose mirrored text is
   * missing despite a present transcript, sessions whose on-disk transcript no longer
   * exists (expected after Claude Code's ~30-day auto-delete), and a SQLite
   * `PRAGMA integrity_check`. Mutates nothing; returns `{ ok, issues, counts, ... }`. The
   * companion to {@link repairIntegrity}. See {@link checkIntegrity}.
   */
  checkIntegrity(): IntegrityReport {
    return this.index.checkIntegrity();
  }

  /**
   * SAFELY repair what {@link checkIntegrity} found, preferring RE-DERIVATION over
   * destruction: delete clearly-orphaned sidecar/search rows whose parent session is gone
   * (each delete gated on the parent being absent, so a live session can never be touched),
   * and re-index any session whose mirror text is empty but whose transcript still exists.
   * NEVER touches ~/.claude transcripts — only the index DB. Idempotent (a second run is a
   * no-op). Returns `{ repaired, reindexed }`. See {@link repairIntegrity}.
   */
  repairIntegrity(opts: RepairOptions = {}): Promise<RepairResult> {
    return this.index.repairIntegrity(opts);
  }

  /**
   * On-demand code-symbol search within ONE project tree: greps the project's source
   * files for declaration-like matches (function/class/const/def/type/interface/...)
   * whose name contains `q`, returning `[{ name, kind, file, line }]`. Lightweight —
   * there is NO persistent symbol index; each call walks the tree under a capped
   * budget (skipping node_modules/.git/build dirs and binaries).
   *
   * ALLOWLIST: `cwd` must be a known project directory — exactly one of (or nested
   * under) a cwd the index has seen via {@link getProjects}. A path outside every
   * known project is rejected with `[]` (never read), so this can't be turned into an
   * arbitrary-filesystem reader. Returns `[]` for a blank/unknown cwd.
   */
  async searchSymbols(cwd: string, q: string, opts: SymbolSearchOptions = {}): Promise<SymbolHit[]> {
    const target = (cwd ?? "").trim();
    if (!target || !this.isKnownProjectPath(target)) return [];
    return searchSymbols(target, q, opts);
  }

  /**
   * True when `target` is, or is nested under, a project cwd the index knows about
   * (the symbol-search allowlist). Both sides are resolved and compared on path
   * SEGMENT boundaries so a sibling like `/home/me/widget-shop-evil` is NOT treated
   * as inside `/home/me/widget-shop`. Archived projects still count — the user can
   * search their code.
   */
  private isKnownProjectPath(target: string): boolean {
    const resolved = path.resolve(target);
    for (const p of this.index.getProjects({ includeArchived: true })) {
      if (!p.cwd) continue;
      const root = path.resolve(p.cwd);
      if (resolved === root || resolved.startsWith(root + path.sep)) return true;
    }
    return false;
  }

  /**
   * Where this calendar month's APPROXIMATE spend sits relative to the user's soft
   * monthly budget (`settings.monthlyBudgetUsd`). Month-to-date cost is the current
   * UTC month's slice of the {@link dailyUsage} series; `alert` is "warn" at >=80%
   * and "over" at >=100%. Returns `alert: "none"` (and `pct: 0`) when no budget set.
   */
  getBudgetStatus(): BudgetStatus {
    return budgetStatus(this.settings.get("monthlyBudgetUsd"), this.index.dailyUsage());
  }

  /**
   * Period-aware budget guard snapshot: remaining headroom, a linear month-to-date
   * spend PROJECTION to the period end, and an ok/warn/over `state` graded against the
   * configured cap (`settings.monthlyBudgetUsd`). Spend reuses the SAME bounded per-day
   * rollup ({@link dailyUsage}) the dashboard uses — no transcript re-scan, no new
   * schema. A null cap yields `state: "ok"` but still computes the projection. This is
   * the data behind a face's pre-turn budget warning; see {@link guardTurn} for the gate.
   */
  budgetStatus(opts: BudgetGuardOptions = {}): BudgetGuardStatus {
    return budgetGuardStatus(this.settings.get("monthlyBudgetUsd"), this.index.dailyUsage(), opts);
  }

  /**
   * Cheap, ADVISORY pre-turn budget check: `{ allow, reason?, status }`. `allow` is
   * false ONLY when the (estimate-inclusive) period spend is already over the cap AND
   * enforcement is on (the default) — otherwise true, with `reason` carrying any warn/
   * over advisory for the caller to surface. Reuses the bounded rollup via
   * {@link budgetStatus}; never spawns/cancels a turn, so the CLI driver is unchanged
   * unless a caller opts in by consulting this decision.
   */
  guardTurn(opts: GuardTurnOptions = {}): TurnGuardDecision {
    return guardTurn(this.settings.get("monthlyBudgetUsd"), this.index.dailyUsage(), opts);
  }

  /**
   * Currently-running claude processes, read from ~/.claude/sessions/<pid>.json.
   * Delegates to the `running` module, which reads the ephemeral files AND probes
   * each PID for liveness — stale/zombie entries are flagged (`alive: false`,
   * `status: "dead"`) so faces don't present a dead file as a live session.
   * Tolerant: missing dir => [], unparseable/internal entries skipped, sorted by
   * `updatedAt` (most recently active first).
   *
   * Each session also carries a `needsYou` flag — true when it's been `waiting`
   * (e.g. on a permission prompt) longer than the staleness threshold, so it's
   * blocked on the user. Pass `{ needsYouFirst: true }` to float those to the top,
   * or `{ needsYouThresholdMs }` to tune how stale "stuck" means.
   */
  async getRunningSessions(
    opts: { dropDead?: boolean; needsYouThresholdMs?: number; needsYouFirst?: boolean } = {},
  ): Promise<RunningSession[]> {
    return listRunningSessions(opts);
  }

  /**
   * Checkpoints for a session: the `file-history-snapshot` points in its transcript,
   * each with a timestamp + the project files it backed up (with blob locations).
   * Reads from `~/.claude/file-history/<sessionId>/` + the transcript; never writes.
   * Returns [] when the session is unknown or has no transcript.
   */
  async listCheckpoints(sessionId: string): Promise<Checkpoint[]> {
    const summary = this.index.getSessionSummary(sessionId);
    if (!summary) return [];
    return listCheckpoints(sessionId, summary.filePath, summary.cwd);
  }

  /**
   * Restore the PROJECT files captured in one checkpoint to their backed-up bytes —
   * the explicit checkpoint feature. Writes the user's project files (NOT a
   * transcript), backing each up to `<file>.bak` first. Defaults to a DRY RUN
   * (`opts.dryRun` true): pass `{ dryRun: false }` to actually write. Throws when the
   * session or checkpoint id is unknown.
   */
  async restoreCheckpoint(
    sessionId: string,
    messageId: string,
    opts: { dryRun?: boolean } = {},
  ): Promise<RestoreResult> {
    const summary = this.index.getSessionSummary(sessionId);
    if (!summary) throw new Error(`restoreCheckpoint: unknown session ${sessionId}`);
    return restoreCheckpoint(sessionId, messageId, summary.filePath, summary.cwd, opts);
  }

  /**
   * Per-day token & cost time series for usage/spend charts. Each session's totals
   * land on the UTC day of its last activity; cost is per-session (model-priced) and
   * summed per day. Optional since/until/projectId narrow the window.
   */
  dailyUsage(opts: DailyUsageOptions = {}): DailyUsage[] {
    return this.index.dailyUsage(opts);
  }

  /**
   * Serialize the durable index into a portable, self-describing {@link ArchiveBundle}
   * (a versioned JSON document): every indexed session's normalized metadata + mirrored
   * search text PLUS all the sidecar data we own (custom titles/pins/tags/archived
   * /notes, saved views, the permission audit log). Read-only; never reads or copies a
   * raw ~/.claude transcript. The export `timestamp` is injectable for deterministic
   * tests (defaults to Date.now()). For a very large index, stream it instead with
   * {@link exportArchiveChunks}.
   */
  exportArchive(opts: ExportArchiveOptions = {}): ArchiveBundle {
    return this.index.exportArchive(opts);
  }

  /**
   * Restore a {@link ArchiveBundle} into THIS index, idempotently — re-importing the
   * same bundle never duplicates rows (mirrored text reuses the W23 stable-rowid path;
   * session/sidecar rows upsert by identity). A bundle with an unreadable
   * `schemaVersion` throws {@link ArchiveVersionError} (or no-ops in non-strict mode).
   * NEVER writes to ~/.claude — only the index DB.
   */
  importArchive(bundle: ArchiveBundle, opts: ImportArchiveOptions = {}): ImportArchiveResult {
    return this.index.importArchive(bundle, opts);
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

    // Per-project USD cost is computed per session (each session priced by its own
    // model) and rolled up by projectId, then summed for the grand total.
    const costByProject = this.index.getCostByProject();
    let totalCostUsd = 0;
    for (const c of costByProject.values()) totalCostUsd += c;

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
        costUsd: costByProject.get(p.id) ?? 0,
      }))
      .sort((a, b) => b.tokens - a.tokens)
      .slice(0, 8);

    return {
      totalSessions,
      totalProjects: projects.length,
      totalUsage,
      totalCostUsd,
      topProjects,
      activity: this.buildActivity(),
      budget: this.getBudgetStatus(),
      byModel: this.index.getUsageByModel(),
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
export { parseSearchQuery, mergeFacets } from "./query-parser.js";
export type { ParsedQuery } from "./query-parser.js";
export { searchSymbols } from "./symbols.js";
export type { SymbolHit, SymbolKind, SymbolSearchOptions } from "./symbols.js";
export { relatedSessions } from "./related.js";
export type { RelatedSession, RelatedOptions } from "./related.js";
export { toolStats } from "./tool-stats.js";
export type { ToolStat, ToolStatsResult, ToolStatsSummary, ToolStatsOptions } from "./tool-stats.js";
export { projectOverview } from "./project-overview.js";
export type {
  ProjectOverview,
  ProjectModelUsage,
  ProjectTopTool,
  ProjectDailyCost,
  ProjectTag,
} from "./project-overview.js";
export type { ToolCall } from "./parse-session.js";
export { listAllSessions } from "./all-sessions.js";
export type { ListAllSessionsOptions } from "./all-sessions.js";
export { dailyUsage } from "./rollups.js";
export type { DailyUsage, DailyUsageOptions } from "./rollups.js";
export { budgetStatus } from "./budget.js";
export type { BudgetStatus } from "./budget.js";
export { budgetGuardStatus, guardTurn, DEFAULT_WARN_FRACTION } from "./budget-guard.js";
export type {
  BudgetGuardStatus,
  BudgetGuardOptions,
  BudgetState,
  GuardTurnOptions,
  TurnGuardDecision,
} from "./budget-guard.js";
export { classifyCommand, classifyShell } from "./classify-command.js";
export type { CommandSeverity, CommandClassification } from "./classify-command.js";
export {
  listRunningSessions,
  isPidAlive,
  clearRunningSessionsCache,
  DEFAULT_NEEDS_YOU_MS,
} from "./running.js";
export {
  listCheckpoints,
  restoreCheckpoint,
  fileHistoryDir,
} from "./checkpoint.js";
export type {
  Checkpoint,
  CheckpointFile,
  RestoreResult,
  RestoredFile,
} from "./checkpoint.js";
export { resolveSettings } from "./config/resolve.js";
export type {
  ResolvedSettings,
  ResolvedScope,
  ResolvedKey,
  SettingsScopeName,
} from "./config/resolve.js";
export { resolveEffectiveConfig } from "./config/effective.js";
export type { EffectiveConfig, EffectiveExtension } from "./config/effective.js";
export { searchConfig } from "./config/index-config.js";
export type { ConfigSearchHit, ConfigArtifactKind } from "./config/index-config.js";
export {
  hybridSearch,
  selectProvider,
  noopProvider,
  lexicalProvider,
} from "./embeddings.js";
export type {
  EmbeddingProvider,
  FtsSearchFn,
  HybridSearchOptions,
} from "./embeddings.js";
export { testMcpServer } from "./config/mcp-test.js";
export type { McpTestResult } from "./config/mcp-test.js";
export { setMcpEnabled, listMcpToggles } from "./config/mcp-toggle.js";
export type { McpToggle } from "./config/mcp-toggle.js";
export {
  projectRollups,
  costByProject,
  usageByModel,
  AggregateCache,
} from "./aggregates.js";
export type { ProjectRollup } from "./aggregates.js";
export { SettingsStore } from "./settings.js";
export { watchTranscripts } from "./watcher.js";
export { startConfigWatcher, configWatchPaths } from "./config/watcher.js";
export type { ConfigWatcherOptions } from "./config/watcher.js";
export { CliDriver, createDriver } from "./driver/cli.js";
export {
  buildSandboxConfig,
  applySandbox,
  scrubEnv,
  networkEnvKeys,
  sandboxExecAvailable,
  NETWORK_ENV_VARS,
  SANDBOX_ENV_MARKER,
  SEATBELT_NO_NETWORK_PROFILE,
} from "./driver/sandbox.js";
export type { SandboxOptions, SandboxConfig, SpawnSpec } from "./driver/sandbox.js";
export { forkTurn, forkCliArgs } from "./driver/fork.js";
export type { ForkedTurn } from "./driver/fork.js";
export { writeFtsRows, assignStableRowids, stableRowid } from "./fts-write.js";
export type { FtsRow } from "./fts-write.js";
export { checkIntegrity, repairIntegrity } from "./integrity.js";
export type {
  IntegrityReport,
  IntegrityIssue,
  IntegrityCounts,
  RepairOptions,
  RepairResult,
} from "./integrity.js";
export {
  exportArchive,
  exportArchiveForProject,
  exportArchiveChunks,
  importArchive,
  ArchiveVersionError,
  ARCHIVE_SCHEMA_VERSION,
} from "./portable.js";
export type {
  ArchiveBundle,
  ArchiveSession,
  ArchiveTextRow,
  ArchiveSavedView,
  ArchiveAuditRow,
  ArchiveChunk,
  ExportArchiveOptions,
  ImportArchiveOptions,
  ImportArchiveResult,
} from "./portable.js";
export {
  gracefulInterrupt,
  DEFAULT_GRACE_MS,
  DEFAULT_KILL_MS,
} from "./driver/interrupt.js";
export type { InterruptibleProcess, GracefulInterruptOptions } from "./driver/interrupt.js";
export {
  parseRateLimit,
  parseResetAt,
  classifySubtype,
  classifyText,
} from "./rate-limit.js";
export type { RateLimitInfo, RateLimitReason } from "./rate-limit.js";
export {
  computeRetry,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_BASE_DELAY_MS,
  DEFAULT_MAX_DELAY_MS,
} from "./retry-policy.js";
export type { RetryDecision, RetryOptions } from "./retry-policy.js";
export {
  scanSubagents,
  scanSubagentFile,
  subagentsDir,
  SUBAGENT_ROLE,
} from "./subagents.js";
export type { SubagentSearchText } from "./subagents.js";
export { detectSourceKind } from "./discovery.js";
export type { SourceKind } from "./discovery.js";
export { archiveSession, hasArchive, readArchived, archiveDir, archivePath } from "./archive.js";
export { costUsd, pricingForModel, MODEL_PRICING, FALLBACK_PRICING } from "./pricing.js";
export type { ModelPricing } from "./pricing.js";
export { GitService, parseStatus, parseWorktrees } from "./git.js";
export type {
  GitStatus,
  GitBranch,
  GitLogEntry,
  GitDiff,
  GitWorktree,
  GitWriteResult,
  GitCommitResult,
} from "./git.js";
export { ProjectMetaStore } from "./project-meta.js";
export type { ProjectMetaPatch } from "./project-meta.js";
export { normalizeProjectDefault, DEFAULT_PROJECT_DEFAULTS } from "./project-settings.js";
export type {
  ProjectDefaults,
  ProjectDefaultModel,
  ProjectDefaultPermissionMode,
} from "./project-settings.js";
export {
  FTS_TABLE,
  FTS_COLUMNS,
  TOKENIZER_PREFERENCE,
  createFtsTableSql,
  createLikeTableSql,
  detectFtsTokenizer,
  tokenizerOf,
  ftsTableColumns,
  ftsLacksColumn,
} from "./fts-schema.js";
export type { FtsTokenizer } from "./fts-schema.js";
export { TagStore, parseTags, normalizeTags } from "./tags.js";
export { computeAutoTags, branchTag, mergeAutoTags } from "./auto-tag.js";
export { SavedViewStore } from "./saved-views.js";
export type { SavedView, SaveViewInput } from "./saved-views.js";
export {
  WebhookConfigStore,
  WEBHOOK_EVENTS,
  isHttpUrl,
  normalizeWebhook,
  normalizeWebhooks,
  buildWebhookPayload,
  webhooksForEvent,
} from "./webhooks.js";
export type { WebhookConfig, WebhookEvent, WebhookPayload } from "./webhooks.js";
export { AuditStore } from "./audit.js";
export type { AuditDecision, AuditDecisionInput, AuditEntry } from "./audit.js";
export { redactSecrets, redactDeep } from "./redact.js";
export { getSessionCommits, selectCommitsInWindow } from "./session-commits.js";
export type { SessionCommit } from "./session-commits.js";
export { aggregateFileChanges } from "./file-changes.js";
export type { FileChange, FileChangesSummary, SessionFileChanges } from "./file-changes.js";
export { createLineSplitter, DEFAULT_MAX_LINE_BYTES } from "./driver/buffer.js";
export type { LineSplitter, LineSplitterOptions } from "./driver/buffer.js";
export * as config from "./config/index.js";
export * as paths from "./paths.js";
export * from "./types.js";
export type * from "./driver/types.js";
export { listCodexSessions, getCodexStats } from "./codex.js";
export type { CodexSession, CodexStats } from "./codex.js";
