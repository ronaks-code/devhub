import { Fragment, type ReactNode } from "react";
import type { DevHubFeatureFlags } from "@devhub/engine/providers";
import { type ProviderId } from "../providers/provider-capabilities.js";
import { Skeleton } from "../../Skeleton.js";

/**
 * TaskSearchDialog — the dedicated `Search tasks and messages` dialog (M6 slice 7).
 *
 * `component-state-matrix.md` §12 / `surface-inventory.md` `SF-18` / `design-system.md`
 * §7.9 / `design-lock.md` §8; `REF-SEARCH` (`devhub-current-search-results.png`) is the
 * PRESERVATION authority for the populated results contract. This is Search ONLY — it
 * is NOT the command palette and MUST NOT be merged into it (Commands is the separate
 * `CommandDialog`; `Search tasks` in Commands closes Commands and opens THIS dialog).
 *
 * The dialog owns: a focused query, Global/current-project scope, date facets, a result
 * count/status, and title/project/highlighted-snippet rows. Opening a result navigates
 * to the correct provider-LOCKED native task/message, and the result provider is derived
 * from the composite task key (`provider\u0000home\u0000nativeTaskId`) — NEVER inferred
 * from model text. On error it shows a DISTINCT in-dialog error state that retains the
 * query and facets; it MUST NOT collapse to `No results`. Degraded history results carry
 * `Read-only fallback`, and a raw OpenAI session is never labeled `Codex`.
 *
 * Mounted only behind the default-off `searchCommands` slice flag; flag-off keeps the
 * legacy `SearchPalette` as the immediate, non-destructive rollback. Renders no provider
 * logo (`<svg>`/`<img>`) — provider identity is quiet text.
 */

export type { ProviderId };

/** The composite native task key separator (mirrors engine `task-key.ts`). */
const KEY_SEPARATOR = "\u0000";

/** The recognized providers, so a malformed key can never masquerade as a provider. */
const PROVIDERS = new Set<ProviderId>(["openai", "anthropic"]);

/** Search scope: everything, or just the active project. */
export type SearchScope = "global" | "project";

/** Retained date facets (`T-search`). */
export type SearchDateFacet = "today" | "7d" | "30d" | "90d" | "custom";

/** One source for the `T-search` visible-copy diff. */
export const SEARCH_COPY = Object.freeze({
  /** Accessible dialog title. */
  title: "Search tasks and messages",
  placeholderGlobal: "Search all tasks and messages…",
  placeholderProject: (name: string) => `Search ${name}…`,
  scopeGlobal: "Global",
  scopeProjectFallback: "Project",
  /** Explains why the Project scope is disabled with no active project. */
  scopeProjectDisabledReason: "Select a project to scope the search to it",
  states: Object.freeze({
    idle: "Type to search",
    loading: "Searching…",
    /** DISTINCT error state — never collapses to `No results`. */
    error: "Search failed",
    empty: "No results",
  }),
  /** Dynamic status, e.g. `12 results`. */
  resultCount: (n: number) => `${n} ${n === 1 ? "result" : "results"}`,
  dateControls: Object.freeze({
    afterDate: "After date",
    beforeDate: "Before date",
    clearRange: "Clear date range",
  }),
  footer: Object.freeze({
    navigate: "↑↓ navigate",
    open: "↵ open",
    close: "esc close",
    allProjects: "all projects",
  }),
  /** Required disclosure on a degraded/read-only history result. */
  readOnlyFallback: "Read-only fallback",
  retry: "Retry",
} as const);

/** Locked date-facet order + visible labels. */
export const SEARCH_DATE_FACETS: ReadonlyArray<{ id: SearchDateFacet; label: string }> =
  Object.freeze([
    { id: "today", label: "Today" },
    { id: "7d", label: "7d" },
    { id: "30d", label: "30d" },
    { id: "90d", label: "90d" },
    { id: "custom", label: "Custom" },
  ] as const);

/**
 * A single populated search result. The `taskKey` is the composite native task key
 * (`provider\u0000home\u0000nativeTaskId`); the provider is derived from IT and never
 * from model/assistant text.
 */
export interface SearchResult {
  /** Composite native task key. Sole source of the result's provider. */
  taskKey: string;
  /** Task title. */
  title: string;
  /** Project display name. */
  projectName: string;
  /** FTS snippet with `[match]` highlight markers. */
  snippet: string;
  /** Best-matching message seq within the task, so navigation jumps to the match. */
  seq?: number;
  /**
   * True when this hit is a degraded/read-only history record (e.g. a raw OpenAI
   * session that is NOT a native Codex task). Carries `Read-only fallback` and is
   * never labeled `Codex`.
   */
  degraded?: boolean;
}

/**
 * Derive the provider from the composite task key — the ONLY sanctioned source of a
 * result's provider (never model text). Throws on a malformed key so bad data is loud
 * rather than silently mislabeling a provider (mirrors engine `assertNativeTaskKey`).
 */
export function providerFromTaskKey(taskKey: string): ProviderId {
  const first = typeof taskKey === "string" ? taskKey.split(KEY_SEPARATOR)[0] : undefined;
  if (!first || !PROVIDERS.has(first as ProviderId)) {
    throw new TypeError(`task key does not carry a known provider: ${String(taskKey)}`);
  }
  return first as ProviderId;
}

/** A provider-locked navigation target parsed straight from the composite key. */
export interface SearchNavigationTarget {
  provider: ProviderId;
  home: string;
  nativeTaskId: string;
  /** Message seq to jump to (0 when unknown). */
  seq: number;
  /** Cached/degraded results open read-only until task reconciliation. */
  readOnly: boolean;
}

/**
 * Build the provider-LOCKED navigation target for a result. The provider/home/task id
 * all come from the composite key, so the target can never point at another provider's
 * task. Degraded results open read-only.
 */
export function navigationTargetForResult(result: SearchResult): SearchNavigationTarget {
  const [provider, home = "", nativeTaskId = ""] = result.taskKey.split(KEY_SEPARATOR);
  if (!provider || !PROVIDERS.has(provider as ProviderId)) {
    throw new TypeError(`task key does not carry a known provider: ${String(result.taskKey)}`);
  }
  return {
    provider: provider as ProviderId,
    home,
    nativeTaskId,
    seq: typeof result.seq === "number" && result.seq >= 0 ? result.seq : 0,
    readOnly: result.degraded === true,
  };
}

/**
 * The row provider label. Anthropic is `Claude`; a native Codex task is `Codex`; a
 * DEGRADED (raw) OpenAI session is `OpenAI` and MUST NOT be labeled `Codex`.
 */
export function resultProviderLabel(result: SearchResult): string {
  const provider = providerFromTaskKey(result.taskKey);
  if (provider === "anthropic") return "Claude";
  return result.degraded === true ? "OpenAI" : "Codex";
}

/** The result-status discriminated union. `error` is DISTINCT from `empty`. */
export type SearchStatus =
  | { kind: "idle"; message: string }
  | { kind: "loading"; message: string }
  | { kind: "error"; message: string }
  | { kind: "empty"; message: string }
  | { kind: "results"; count: number; message: string };

/**
 * Resolve the search status with a precedence that guarantees the error state can NEVER
 * collapse to `No results`:
 *   1. error (distinct; retains query/facets)  → `Search failed`
 *   2. no query                                → `Type to search`
 *   3. loading                                 → `Searching…`
 *   4. zero results                            → `No results`
 *   5. otherwise                               → `[count] results`
 */
export function resolveSearchStatus(input: {
  query: string;
  loading?: boolean;
  error?: boolean;
  resultCount: number;
}): SearchStatus {
  const S = SEARCH_COPY.states;
  if (input.error) return { kind: "error", message: S.error };
  if (!input.query.trim()) return { kind: "idle", message: S.idle };
  if (input.loading) return { kind: "loading", message: S.loading };
  if (input.resultCount <= 0) return { kind: "empty", message: S.empty };
  return {
    kind: "results",
    count: input.resultCount,
    message: SEARCH_COPY.resultCount(input.resultCount),
  };
}

// --- Slice-flag gate (shared with CommandDialog — same `searchCommands` flag) ---

export type SearchCommandsMode = "devhub" | "legacy";

/**
 * Slice-flag gate for BOTH search + command dialogs. Mirrors `resolveInspectorDockMode`:
 * the new dialogs mount only for a server-resolved true `searchCommands`; anything else
 * (false/undefined/missing) keeps the legacy `SearchPalette` with Commands unmounted —
 * the immediate, non-destructive rollback. Flag-off NEVER instantiates either dialog.
 * A shared flag PREDICATE — the two dialogs stay separate contracts and are never merged.
 */
export function resolveSearchCommandsMode(
  settings: { devHubFeatures?: Partial<DevHubFeatureFlags> } | null | undefined,
): SearchCommandsMode {
  return settings?.devHubFeatures?.searchCommands === true ? "devhub" : "legacy";
}

/** True only when the search/commands slice flag is applied. */
export function isSearchCommandsApplied(
  features: Partial<DevHubFeatureFlags> | undefined,
): boolean {
  return features?.searchCommands === true;
}

// --- Presentation --------------------------------------------------------------

const OPTION_ID = (i: number) => `dh-search-result-${i}`;

/** Render an FTS snippet, turning `[match]` markers into semantic `<mark>` highlights. */
function Snippet({ text }: { text: string }): ReactNode {
  const parts = text.split(/(\[[^\]]*\])/g);
  return (
    <>
      {parts.map((p, i) =>
        p.length > 2 && p.startsWith("[") && p.endsWith("]") ? (
          <mark key={i} className="dh-search-mark" data-dh-search-mark="">
            {p.slice(1, -1)}
          </mark>
        ) : (
          <Fragment key={i}>{p}</Fragment>
        ),
      )}
    </>
  );
}

export interface TaskSearchDialogProps {
  /** Current query text. */
  query?: string;
  /** Global vs current-project scope. Default `global`. */
  scope?: SearchScope;
  /** Active project id — Project scope is disabled/explained without one. */
  activeProjectId?: string | null;
  /** Active project display name (scope label + placeholder). */
  activeProjectName?: string | null;
  /** Active date facet, if any. */
  dateFacet?: SearchDateFacet | null;
  /** Debounced request in flight. */
  loading?: boolean;
  /** A read failed — render the DISTINCT error state, never `No results`. */
  error?: boolean;
  /** Populated results (already provider-locked via composite key). */
  results?: readonly SearchResult[];
  /** Keyboard-active row (distinct from scope/date selection). Default 0. */
  activeIndex?: number;
  /** Accessible name. Default `Search tasks and messages`. */
  label?: string;
  /** Navigate to a provider-locked result. Provider derives from the composite key. */
  onOpen?: (target: SearchNavigationTarget, result: SearchResult) => void;
}

export function TaskSearchDialog({
  query = "",
  scope = "global",
  activeProjectId = null,
  activeProjectName = null,
  dateFacet = null,
  loading = false,
  error = false,
  results = [],
  activeIndex = 0,
  label = SEARCH_COPY.title,
  onOpen,
}: TaskSearchDialogProps): ReactNode {
  const projectScopeEnabled = Boolean(activeProjectId);
  const effectiveProject = scope === "project" && projectScopeEnabled;
  const status = resolveSearchStatus({
    query,
    loading,
    error,
    resultCount: results.length,
  });
  const active = Math.min(Math.max(activeIndex, 0), Math.max(results.length - 1, 0));
  const showResults = status.kind === "results";
  const placeholder = effectiveProject
    ? SEARCH_COPY.placeholderProject(activeProjectName || "this project")
    : SEARCH_COPY.placeholderGlobal;

  return (
    // A dedicated Search dialog (NOT the command palette). One elevated #2d2d2d surface.
    <div
      className="dh-dialog dh-search-dialog"
      data-dh-search-dialog=""
      data-dh-surface=""
      role="dialog"
      aria-modal="true"
      aria-label={label}
    >
      <h2 className="dh-sr-only" data-dh-search-title="">
        {label}
      </h2>

      {/* Focused query. `autoFocus` + the marker attr express "open focuses the query". */}
      <div className="dh-dialog-input" data-dh-search-inputrow="">
        <input
          className="dh-dialog-query"
          data-dh-search-input=""
          data-dh-search-autofocus=""
          role="searchbox"
          type="text"
          autoFocus
          value={query}
          readOnly
          aria-label={label}
          aria-controls="dh-search-results"
          placeholder={placeholder}
        />
      </div>

      {/* Scope (Global / current-project) — pressed/radio semantics, NOT the keyboard row. */}
      <div className="dh-search-facets" data-dh-search-facets="">
        <div
          className="dh-search-scope"
          data-dh-search-scope=""
          role="group"
          aria-label="Search scope"
        >
          <button
            type="button"
            className="dh-search-scope-btn"
            data-dh-search-scope-option="global"
            role="radio"
            aria-checked={scope === "global" ? "true" : "false"}
          >
            {SEARCH_COPY.scopeGlobal}
          </button>
          <button
            type="button"
            className="dh-search-scope-btn"
            data-dh-search-scope-option="project"
            role="radio"
            aria-checked={effectiveProject ? "true" : "false"}
            disabled={!projectScopeEnabled}
            title={projectScopeEnabled ? undefined : SEARCH_COPY.scopeProjectDisabledReason}
          >
            {activeProjectName || SEARCH_COPY.scopeProjectFallback}
          </button>
        </div>

        {/* Date facets — pressed semantics, distinct from the keyboard-active result row. */}
        <div
          className="dh-search-dates"
          data-dh-search-dates=""
          role="group"
          aria-label="Date range"
        >
          {SEARCH_DATE_FACETS.map((f) => (
            <button
              key={f.id}
              type="button"
              className="dh-search-date-btn"
              data-dh-date-facet={f.id}
              role="radio"
              aria-checked={dateFacet === f.id ? "true" : "false"}
            >
              {f.label}
            </button>
          ))}
          <span className="dh-sr-only" data-dh-date-control="after">
            {SEARCH_COPY.dateControls.afterDate}
          </span>
          <span className="dh-sr-only" data-dh-date-control="before">
            {SEARCH_COPY.dateControls.beforeDate}
          </span>
          <button
            type="button"
            className="dh-search-date-clear"
            data-dh-date-control="clear"
          >
            {SEARCH_COPY.dateControls.clearRange}
          </button>
        </div>
      </div>

      {/* Result count / status — announced politely; count present only for results. */}
      <p
        className="dh-search-status"
        data-dh-search-status={status.kind}
        role="status"
        aria-live="polite"
        aria-busy={status.kind === "loading" ? "true" : "false"}
      >
        {status.message}
      </p>

      {error ? (
        // DISTINCT in-dialog error Alert. `role="alert"` (implicit aria-live="assertive")
        // is the accessible-Alert primitive for this failure. Retains query + facets
        // (rendered above); it NEVER renders `No results`. Offers a read retry.
        <div className="dh-search-error" data-dh-search-error="" role="alert">
          <p data-dh-search-error-message="">{SEARCH_COPY.states.error}</p>
          <button type="button" className="dh-search-retry" data-dh-search-retry="">
            {SEARCH_COPY.retry}
          </button>
        </div>
      ) : status.kind === "loading" ? (
        // Content-shaped Skeleton placeholders (mirrors ListRowSkeleton) instead of a
        // bare spinner/text — the status paragraph above already announces "Searching…"
        // to screen readers, so these rows are purely visual (aria-hidden).
        <div
          className="dh-search-results"
          data-dh-search-skeleton=""
          aria-hidden="true"
        >
          {[0, 1, 2].map((i) => (
            <div key={i} className="dh-search-result" data-dh-search-skeleton-row={i}>
              <Skeleton className="h-3 w-[60%]" />
              <Skeleton className="h-2.5 w-[85%]" />
            </div>
          ))}
        </div>
      ) : (
        <div
          className="dh-search-results"
          data-dh-search-results=""
          id="dh-search-results"
          role="listbox"
          aria-label={label}
          aria-activedescendant={showResults ? OPTION_ID(active) : undefined}
        >
          {showResults ? (
            results.map((r, i) => {
              const provider = providerFromTaskKey(r.taskKey);
              const providerLabel = resultProviderLabel(r);
              const isActive = i === active;
              return (
                <button
                  key={`${r.taskKey}-${i}`}
                  type="button"
                  id={OPTION_ID(i)}
                  className="dh-search-result"
                  data-dh-search-result={i}
                  role="option"
                  aria-selected={isActive ? "true" : "false"}
                  data-dh-result-provider={provider}
                  data-dh-result-seq={navigationTargetForResult(r).seq}
                  data-dh-read-only={r.degraded === true ? "" : undefined}
                  onClick={() => onOpen?.(navigationTargetForResult(r), r)}
                >
                  <span className="dh-search-result-head" data-dh-result-head="">
                    <span className="dh-search-result-title" data-dh-result-title="">
                      {r.title}
                    </span>
                    <span className="dh-search-result-project" data-dh-result-project="">
                      {r.projectName}
                    </span>
                    <span
                      className="dh-search-result-provider"
                      data-dh-result-provider-label={provider}
                    >
                      {providerLabel}
                    </span>
                  </span>
                  <span className="dh-search-result-snippet" data-dh-result-snippet="">
                    <Snippet text={r.snippet} />
                  </span>
                  {r.degraded ? (
                    <span
                      className="dh-search-result-fallback"
                      data-dh-result-fallback=""
                    >
                      {SEARCH_COPY.readOnlyFallback}
                    </span>
                  ) : null}
                </button>
              );
            })
          ) : (
            // idle / loading / empty share this non-result placeholder; error never lands here.
            <p className="dh-search-placeholder" data-dh-search-placeholder={status.kind}>
              {status.message}
            </p>
          )}
        </div>
      )}

      <div className="dh-dialog-footer" data-dh-search-footer="">
        <span>{SEARCH_COPY.footer.navigate}</span>
        <span>{SEARCH_COPY.footer.open}</span>
        <span>{SEARCH_COPY.footer.close}</span>
        <span className="dh-dialog-footer-scope" data-dh-search-footer-scope="">
          {effectiveProject
            ? activeProjectName || SEARCH_COPY.scopeProjectFallback
            : SEARCH_COPY.footer.allProjects}
        </span>
      </div>
    </div>
  );
}
