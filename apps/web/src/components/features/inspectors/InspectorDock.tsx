import { type KeyboardEvent, type ReactNode } from "react";
import type { DevHubFeatureFlags } from "@devhub/engine/providers";
import { providerIdentity, type ProviderId } from "../providers/provider-capabilities.js";
import { SHELL_GEOMETRY } from "../shell/DevHubShell.js";

/**
 * InspectorDock — the canonical task inspector (M6 slice 6).
 *
 * `design-lock.md` §8 / `component-state-matrix.md` §11 / `surface-inventory.md`
 * `SF-11`..`SF-17`: ONE measured 300-wide, content-height, rounded `#2d2d2d` surface
 * (12 top / 16 right lane gutter, 16 inner padding, ~16 radius) — NOT a permanent
 * full-height IDE split pane. It opens with a persistent COMPACT `Environment` summary
 * region (backed environment/repository/subagent/source rows only; NOT a sixth tab),
 * followed by exactly five selectable destinations `Diff`, `Files`, `Terminal`,
 * `Browser`, `Artifacts`, and a quiet footer `Availability follows the task runtime`.
 *
 * Availability follows the real task runtime, never the schema: a gated destination
 * says `Not available for this task` (with a cause when useful); empty Artifacts says
 * `No artifacts` (DISTINCT from unsupported); a disconnected panel reads cached with
 * `Showing cached data — reconnect to refresh.`. Terminal is provider-emitted output
 * ONLY and never auto-invokes an unsandboxed shell (`thread/shellCommand`); Browser
 * updates only from a real browser runtime. Destructive discard/unstage/worktree
 * deletion is a repository-utility confirmation OUTSIDE any tab — the dock renders no
 * destructive control inside a tabpanel.
 *
 * Mounted only behind the default-off `inspectorDock` slice flag; flag-off keeps the
 * legacy diff/file/git panels as the immediate, non-destructive rollback. Renders no
 * `<svg>`/`<img>` (provider identity is quiet text, never a logo).
 */

export type { ProviderId };

/** The five destinations, in locked order. `Environment` is a summary, not one of these. */
export type DestinationId = "diff" | "files" | "terminal" | "browser" | "artifacts";

/**
 * The measured dock geometry, transcribed from `reference-capture-manifest.md` and
 * mirrored on the shell's `SHELL_GEOMETRY` so the dock never drifts from the shell lane.
 * Content-height (`heightMode: "content"`), never a full-height pane.
 */
export const INSPECTOR_GEOMETRY = Object.freeze({
  width: 300,
  laneWidth: 316,
  topGutter: 12,
  rightGutter: 16,
  radius: 16,
  padding: 16,
  heightMode: "content",
} as const);

/** Locked destination order + visible labels. Exactly five, no more, no fewer. */
export const INSPECTOR_DESTINATIONS: ReadonlyArray<{ id: DestinationId; label: string }> =
  Object.freeze([
    { id: "diff", label: "Diff" },
    { id: "files", label: "Files" },
    { id: "terminal", label: "Terminal" },
    { id: "browser", label: "Browser" },
    { id: "artifacts", label: "Artifacts" },
  ] as const);

/** One source for the `T-inspectors` visible-copy diff. */
export const INSPECTOR_COPY = Object.freeze({
  environmentHeading: "Environment",
  footer: "Availability follows the task runtime",
  /** A gated destination. Distinct from empty. */
  notAvailable: "Not available for this task",
  /** Empty (but SUPPORTED) artifacts. Distinct from unsupported. */
  noArtifacts: "No artifacts",
  /** A disconnected panel reads cached with this note. */
  cachedNote: "Showing cached data — reconnect to refresh.",
  /** Narrow/PWA disclosure when the desktop-only destinations can't render. */
  desktopRequired: "Desktop required for terminal and diff",
  /** Environment sub-labels retained only when backed. */
  env: {
    changes: "Changes",
    commitOrPush: "Commit or push",
    createPullRequest: "Create pull request",
    pullRequestUnavailable: "Pull request status unavailable",
    subagents: "Subagents",
    noSubagents: "No active subagents",
    sources: "Sources",
    webSearch: "Web search",
    viewAll: "View all",
  },
});

// --- Pure decision functions (asserted without a DOM) --------------------------

/**
 * Pure roving-focus index math for a HORIZONTAL tablist: Left/Right wrap, Home/End
 * jump. Returns the current index for any other key. Mirrors the rail's
 * `nextRovingIndex` but on the Left/Right axis the inspector tablist requires.
 */
export function nextTabIndex(key: string, current: number, count: number): number {
  if (count <= 0) return -1;
  switch (key) {
    case "ArrowRight":
      return (current + 1) % count;
    case "ArrowLeft":
      return (current - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return current;
  }
}

/** Live runtime for a single destination. Missing fields default to the SUPPORTED value. */
export interface DestinationRuntime {
  /**
   * Whether the real task runtime proves this destination. `false` => the panel body
   * is `Not available for this task`. Availability follows the runtime, NEVER the
   * schema (Codex review/diff and Claude persistent review stay gated until proven).
   */
  supported?: boolean;
  /** Optional exact cause appended to the unavailable message when useful. */
  cause?: string;
  /** Transport health. A non-connected value renders the cached/stale read. */
  connection?: "connected" | "disconnected" | "stale";
  /** Artifacts only: whether any real artifact/deliverable exists. */
  hasContent?: boolean;
}

/** What a destination panel should render, as a discriminated union. */
export type DestinationView =
  | { kind: "content" }
  | { kind: "unavailable"; cause?: string }
  | { kind: "empty" }
  | { kind: "cached" };

/**
 * Resolve what a destination shows, in a deterministic precedence:
 *   1. unsupported (structural gate)  → `Not available for this task` (+ cause)
 *   2. disconnected/stale (transport) → cached read with the reconnect note
 *   3. artifacts with no content      → `No artifacts` (distinct empty, not unsupported)
 *   4. otherwise                      → live content
 * A gated destination may still be SELECTED so its explanation can be read.
 */
export function computeDestinationView(
  dest: DestinationId,
  runtime: DestinationRuntime | undefined,
): DestinationView {
  const rt = runtime ?? {};
  if (rt.supported === false) return { kind: "unavailable", cause: rt.cause };
  if (rt.connection === "disconnected" || rt.connection === "stale") return { kind: "cached" };
  if (dest === "artifacts" && rt.hasContent === false) return { kind: "empty" };
  return { kind: "content" };
}

/** The unavailable body copy, with the exact cause appended only when useful. */
export function unavailableMessage(cause?: string): string {
  const c = cause?.trim();
  return c ? `${INSPECTOR_COPY.notAvailable} — ${c}` : INSPECTOR_COPY.notAvailable;
}

/**
 * A destructive repository action confirmation descriptor. Discard/unstage/worktree
 * deletion NEVER lives inside a tab: it is an explicit repository-utility confirmation
 * whose focus starts on `Cancel`, that NAMES the affected file/worktree, and that
 * states the provider task is unaffected. This is the contract the dock defers to; the
 * dock itself renders no destructive control inside a tabpanel.
 */
export type DestructiveAction = "discard" | "unstage" | "delete-worktree";
export interface DestructiveConfirmation {
  action: DestructiveAction;
  /** The named file or worktree the action affects. */
  target: string;
  title: string;
  body: string;
  confirmLabel: string;
  cancelLabel: string;
  /** Focus starts on Cancel, never the destructive button. */
  initialFocus: "cancel";
  /** Rendered by the repository utility, never inside an inspector tab. */
  rendersInTab: false;
}
export function describeDestructiveConfirmation(
  action: DestructiveAction,
  target: string,
): DestructiveConfirmation {
  const verb =
    action === "discard" ? "Discard changes to" : action === "unstage" ? "Unstage" : "Delete worktree";
  return {
    action,
    target,
    title: `${verb} ${target}?`,
    body: `This changes only your local repository. The provider task is unaffected.`,
    confirmLabel: verb,
    cancelLabel: "Cancel",
    initialFocus: "cancel",
    rendersInTab: false,
  };
}

// --- Presentation --------------------------------------------------------------

/** Compact Environment summary — backed rows only; never a tab. */
export interface EnvironmentSummary {
  /** Repository change summary, e.g. `2 files · +84 -19`. */
  changes?: string;
  /** Current branch name. */
  branch?: string;
  /** Backed repository actions, e.g. `Commit or push`, `Create pull request`. */
  repoActions?: readonly string[];
  /** Pull request status text; omit → the row is not shown. */
  pullRequestStatus?: string;
  /** Active subagents; empty/omitted → `No active subagents`. */
  subagents?: readonly string[];
  /** Web/source rows; omit → no Sources row. */
  sources?: readonly string[];
}

export interface DiffContent {
  /** Changed file paths (labels only). */
  files: readonly string[];
  /** Durable summary, e.g. `2 files · +84 -19`. */
  summary?: string;
  /** Unified diff lines (already provider/repository-sourced). */
  lines?: readonly string[];
}
export interface FileEntry {
  path: string;
  selected?: boolean;
}
export interface BrowserActivity {
  title?: string;
  url?: string;
}
export interface ArtifactEntry {
  label: string;
  source: string;
}

export interface InspectorDockProps {
  /** Immutable-after-creation provider identity (quiet footer text only). */
  provider?: ProviderId;
  /** Selected destination. Default `diff`. A gated destination may be selected. */
  selected?: DestinationId;
  /** Persistent Environment summary rows (backed only). */
  environment?: EnvironmentSummary;
  /** Per-destination runtime availability. */
  runtime?: Partial<Record<DestinationId, DestinationRuntime>>;
  /** Content payloads for available destinations. */
  content?: {
    diff?: DiffContent;
    files?: readonly FileEntry[];
    terminal?: readonly string[];
    browser?: BrowserActivity;
    artifacts?: readonly ArtifactEntry[];
  };
  /** Accessible name for the complementary landmark + tablist. */
  label?: string;
  /**
   * Layout variant. `dock` (default) is the measured desktop content-height dock.
   * `disclosure` is the narrow/PWA fallback: the explicit `Desktop required for
   * terminal and diff` disclosure, NOT the full tablist.
   */
  variant?: "dock" | "disclosure";
  /**
   * Switch the selected destination (M6 Task 9, additive/optional). When omitted the
   * tabs render exactly as before — inert, presentation-only. A live host wires this
   * (with `nextTabIndex` for Left/Right/Home/End roving) to make the tablist real.
   */
  onSelectDestination?: (id: DestinationId) => void;
}

const TAB_ID = (id: DestinationId) => `dh-inspector-tab-${id}`;
const PANEL_ID = (id: DestinationId) => `dh-inspector-panel-${id}`;

function EnvironmentRegion({ env }: { env?: EnvironmentSummary }) {
  const C = INSPECTOR_COPY.env;
  return (
    // A persistent NON-TAB summary region. Its markup NEVER depends on the selected
    // destination, so switching tabs leaves it byte-identical.
    <section
      className="dh-inspector-env"
      data-dh-inspector-env=""
      aria-label={INSPECTOR_COPY.environmentHeading}
    >
      <h3 className="dh-inspector-env-heading" data-dh-inspector-env-heading="">
        {INSPECTOR_COPY.environmentHeading}
      </h3>
      {env?.changes ? (
        <p className="dh-inspector-env-row" data-dh-env-row="changes">
          <span className="dh-inspector-env-label">{C.changes}</span>
          <span className="dh-inspector-env-value">{env.changes}</span>
        </p>
      ) : null}
      {env?.branch ? (
        <p className="dh-inspector-env-row" data-dh-env-row="branch">
          <span className="dh-inspector-env-value">{env.branch}</span>
        </p>
      ) : null}
      {env?.repoActions?.length ? (
        <ul className="dh-inspector-env-actions" data-dh-env-row="repo-actions">
          {env.repoActions.map((a) => (
            <li key={a}>{a}</li>
          ))}
        </ul>
      ) : null}
      {env?.pullRequestStatus ? (
        <p className="dh-inspector-env-row" data-dh-env-row="pr-status">
          {env.pullRequestStatus}
        </p>
      ) : null}
      <p className="dh-inspector-env-row" data-dh-env-row="subagents">
        <span className="dh-inspector-env-label">{C.subagents}</span>
        <span className="dh-inspector-env-value">
          {env?.subagents?.length ? env.subagents.join(", ") : C.noSubagents}
        </span>
      </p>
      {env?.sources?.length ? (
        <p className="dh-inspector-env-row" data-dh-env-row="sources">
          <span className="dh-inspector-env-label">{C.sources}</span>
          <span className="dh-inspector-env-value">{env.sources.join(", ")}</span>
        </p>
      ) : null}
    </section>
  );
}

function UnavailableBody({ cause }: { cause?: string }) {
  return (
    <p className="dh-inspector-empty" data-dh-inspector-unavailable="">
      {unavailableMessage(cause)}
    </p>
  );
}

function CachedBody({ children }: { children?: ReactNode }) {
  return (
    <div data-dh-inspector-cached="">
      <p className="dh-inspector-notice" data-dh-inspector-cached-note="">
        {INSPECTOR_COPY.cachedNote}
      </p>
      {children ? <div className="dh-inspector-cached-content">{children}</div> : null}
    </div>
  );
}

function DiffBody({ content }: { content?: DiffContent }) {
  if (!content) return <UnavailableBody />;
  return (
    <div data-dh-inspector-diff="">
      {content.files.length ? (
        <ul className="dh-inspector-filelist" data-dh-diff-files="">
          {content.files.map((f) => (
            <li key={f}>{f}</li>
          ))}
        </ul>
      ) : null}
      {/* ScrollArea is allowed ONLY inside this bounded, non-virtualized diff body. */}
      <div className="dh-inspector-diff-scroll" data-dh-diff-scroll="">
        {content.lines?.length ? (
          <pre className="dh-inspector-diff-code">{content.lines.join("\n")}</pre>
        ) : null}
      </div>
      {content.summary ? (
        <p className="dh-inspector-diff-summary" data-dh-diff-summary="">
          {content.summary}
        </p>
      ) : null}
    </div>
  );
}

function FilesBody({ files }: { files?: readonly FileEntry[] }) {
  if (!files) return <UnavailableBody />;
  return (
    <ul className="dh-inspector-tree" data-dh-inspector-files="" role="tree">
      {files.map((f) => (
        <li
          key={f.path}
          role="treeitem"
          aria-selected={f.selected ? "true" : "false"}
          data-dh-file-selected={f.selected ? "" : undefined}
        >
          {f.path}
        </li>
      ))}
    </ul>
  );
}

function TerminalBody({ output }: { output?: readonly string[] }) {
  // Provider-emitted output ONLY. There is NO input/prompt element here — the dock never
  // presents an unsandboxed shell fallback and never auto-invokes `thread/shellCommand`.
  if (!output?.length) return <UnavailableBody />;
  return (
    <pre className="dh-inspector-terminal" data-dh-inspector-terminal="">
      {output.join("\n")}
    </pre>
  );
}

function BrowserBody({ activity }: { activity?: BrowserActivity }) {
  // Only a REAL browser runtime populates this; with no activity it is honestly empty.
  if (!activity || (!activity.title && !activity.url)) return <UnavailableBody />;
  return (
    <div data-dh-inspector-browser="">
      {activity.title ? <p className="dh-inspector-browser-title">{activity.title}</p> : null}
      {activity.url ? (
        <p className="dh-inspector-browser-url" data-dh-browser-url="">
          {activity.url}
        </p>
      ) : null}
    </div>
  );
}

function ArtifactsBody({ artifacts }: { artifacts?: readonly ArtifactEntry[] }) {
  if (!artifacts?.length) {
    // Empty but SUPPORTED — distinct from unsupported.
    return (
      <p className="dh-inspector-empty" data-dh-inspector-no-artifacts="">
        {INSPECTOR_COPY.noArtifacts}
      </p>
    );
  }
  return (
    <ul className="dh-inspector-artifacts" data-dh-inspector-artifacts="">
      {artifacts.map((a) => (
        <li key={`${a.label}:${a.source}`}>
          <span className="dh-inspector-artifact-label">{a.label}</span>
          <span className="dh-inspector-artifact-source">{a.source}</span>
        </li>
      ))}
    </ul>
  );
}

function DestinationPanel({
  dest,
  view,
  content,
}: {
  dest: DestinationId;
  view: DestinationView;
  content: InspectorDockProps["content"];
}) {
  if (view.kind === "unavailable") return <UnavailableBody cause={view.cause} />;

  let body: ReactNode;
  switch (dest) {
    case "diff":
      body = <DiffBody content={content?.diff} />;
      break;
    case "files":
      body = <FilesBody files={content?.files} />;
      break;
    case "terminal":
      body = <TerminalBody output={content?.terminal} />;
      break;
    case "browser":
      body = <BrowserBody activity={content?.browser} />;
      break;
    case "artifacts":
      body = <ArtifactsBody artifacts={content?.artifacts} />;
      break;
  }

  if (view.kind === "empty") return <>{body}</>;
  if (view.kind === "cached") return <CachedBody>{body}</CachedBody>;
  return <>{body}</>;
}

export function InspectorDock({
  provider,
  selected = "diff",
  environment,
  runtime,
  content,
  label = "Task inspector",
  variant = "dock",
  onSelectDestination,
}: InspectorDockProps): ReactNode {
  // Narrow/PWA: an explicit disclosure, NOT the full desktop dock (no tablist/terminal).
  if (variant === "disclosure") {
    return (
      <section
        className="dh-inspector-disclosure"
        data-dh-inspector-disclosure=""
        aria-label={label}
      >
        <h2 className="dh-inspector-disclosure-title" data-dh-inspector-disclosure-title="">
          {label}
        </h2>
        <p data-dh-inspector-desktop-required="">{INSPECTOR_COPY.desktopRequired}</p>
      </section>
    );
  }

  const selectedIndex = Math.max(
    0,
    INSPECTOR_DESTINATIONS.findIndex((d) => d.id === selected),
  );

  return (
    // ONE measured 300-wide, content-height, rounded #2d2d2d dock. The geometry data
    // attrs are CONSTANT across every selection — switching tabs never resizes the dock.
    <div
      className="dh-inspector dh-inspector-dock"
      data-dh-inspector=""
      data-dh-inspector-dock=""
      data-dh-surface=""
      data-dh-inspector-width={INSPECTOR_GEOMETRY.width}
      data-dh-inspector-radius={INSPECTOR_GEOMETRY.radius}
      data-dh-inspector-padding={INSPECTOR_GEOMETRY.padding}
      data-dh-inspector-height-mode={INSPECTOR_GEOMETRY.heightMode}
    >
      {/* Persistent, compact Environment summary — never a tab, never selection-dependent. */}
      <EnvironmentRegion env={environment} />

      <div
        className="dh-inspector-tablist"
        data-dh-inspector-tablist=""
        role="tablist"
        aria-label={label}
        aria-orientation="horizontal"
      >
        {INSPECTOR_DESTINATIONS.map((d, i) => {
          const isSelected = d.id === selected;
          const onKeyDown = onSelectDestination
            ? (e: KeyboardEvent<HTMLButtonElement>) => {
                const next = nextTabIndex(e.key, selectedIndex, INSPECTOR_DESTINATIONS.length);
                if (next !== selectedIndex) {
                  e.preventDefault();
                  onSelectDestination(INSPECTOR_DESTINATIONS[next]!.id);
                }
              }
            : undefined;
          return (
            <button
              key={d.id}
              type="button"
              id={TAB_ID(d.id)}
              className="dh-inspector-tab"
              data-dh-inspector-tab={d.id}
              role="tab"
              aria-selected={isSelected ? "true" : "false"}
              aria-controls={PANEL_ID(d.id)}
              // Roving focus: only the selected tab is in the tab order (0); Left/Right
              // move focus among tabs, Home/End jump (see `nextTabIndex`).
              tabIndex={i === selectedIndex ? 0 : -1}
              onClick={onSelectDestination ? () => onSelectDestination(d.id) : undefined}
              onKeyDown={onKeyDown}
            >
              {d.label}
            </button>
          );
        })}
      </div>

      {/* Exactly ONE destination renders, below the unchanged Environment summary. The
          tabpanel is in the tab order so Tab from the selected tab enters the panel. */}
      <div
        className="dh-inspector-panel"
        data-dh-inspector-panel={selected}
        role="tabpanel"
        id={PANEL_ID(selected)}
        aria-labelledby={TAB_ID(selected)}
        tabIndex={0}
      >
        <DestinationPanel
          dest={selected}
          view={computeDestinationView(selected, runtime?.[selected])}
          content={content}
        />
      </div>

      <p className="dh-inspector-footer" data-dh-inspector-footer="">
        {INSPECTOR_COPY.footer}
      </p>

      {provider ? (
        <span className="dh-sr-only" data-dh-inspector-provider={provider}>
          {providerIdentity(provider).label}
        </span>
      ) : null}
    </div>
  );
}

export type InspectorDockMode = "devhub" | "legacy";

/**
 * Slice-flag gate. Mirrors `resolveComposerSurfaceMode`: the new InspectorDock mounts
 * only for a server-resolved true `inspectorDock`; anything else (false/undefined/
 * missing) keeps the legacy diff/file/git panels — the immediate, non-destructive
 * rollback. Flag-off NEVER instantiates the dock.
 */
export function resolveInspectorDockMode(
  settings: { devHubFeatures?: Partial<DevHubFeatureFlags> } | null | undefined,
): InspectorDockMode {
  return settings?.devHubFeatures?.inspectorDock === true ? "devhub" : "legacy";
}

/** True only when the inspector-dock slice flag is applied. */
export function isInspectorDockApplied(
  features: Partial<DevHubFeatureFlags> | undefined,
): boolean {
  return features?.inspectorDock === true;
}

/** Mirror the shell geometry so the dock never drifts from the shell lane. */
export const INSPECTOR_SHELL_GEOMETRY = SHELL_GEOMETRY;
