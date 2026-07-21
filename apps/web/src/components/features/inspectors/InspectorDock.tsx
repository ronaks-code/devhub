import { type ReactNode } from "react";
import type { DevHubFeatureFlags } from "@devhub/engine/providers";
import { providerIdentity, type ProviderId } from "../providers/provider-capabilities.js";
import { SHELL_GEOMETRY } from "../shell/DevHubShell.js";

/**
 * InspectorDock — the task's session-state dock (Aurora Cockpit §3.3).
 *
 * REPURPOSED from the old five-destination Diff/Files/Terminal/Browser/Artifacts
 * tablist into three fixed, backed-only sections: WORKTREE, SESSION, and CHANGED
 * FILES. The owner explicitly does NOT want diff-forward UI in chat, and wants the
 * worktree + live session state visible instead — so this dock never renders a diff
 * viewer, a terminal, or a browser panel. It is one measured 300-wide, content-height
 * glass card (12 top / 16 right lane gutter, 16 inner padding, ~16 radius) — NOT a
 * full-height IDE split pane.
 *
 * Data honesty (unchanged discipline): every row is backed by real data or it does
 * not render. No worktree → a quiet `⎇ {branch} · no worktree` line, never a fake
 * one. A section with nothing backed renders its empty/quiet state, never a
 * placeholder value.
 *
 * Mounted only behind the default-off `inspectorDock` slice flag; flag-off keeps the
 * legacy diff/file/git panels as the immediate, non-destructive rollback. Renders no
 * `<svg>`/`<img>` (provider identity stays quiet text, never a logo).
 */

export type { ProviderId };

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

/** One source for the `T-inspectors` visible-copy diff. */
export const INSPECTOR_COPY = Object.freeze({
  worktreeHeading: "Worktree",
  sessionHeading: "Session",
  changedFilesHeading: "Changed files",
  /** Quiet state when the task is not running in a worktree. */
  noWorktreePrefix: "⎇",
  noWorktreeSuffix: "no worktree",
  /** Empty (but supported) changed-files state. */
  noChanges: "No changes",
  /** Narrow/PWA disclosure when the desktop-only dock can't render. */
  desktopRequired: "Desktop required for the session inspector",
  session: {
    model: "Model",
    permissionMode: "Permission",
    tokens: "Tokens",
    cost: "Cost",
    started: "Started",
    duration: "Duration",
  },
});

/**
 * Pure roving-focus index math for a HORIZONTAL tablist: Left/Right wrap, Home/End
 * jump. Returns the current index for any other key. The dock itself no longer owns
 * a tablist, but this pure helper is the single source `settings-ui`'s Tabs reuses
 * for its own roving-focus math — so it stays exported here (its canonical home).
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

// --- Section models (backed-only) ----------------------------------------------

/** The task's worktree/branch state. Every field optional — backed rows only. */
export interface InspectorWorktree {
  /** Branch or worktree name, e.g. `wt/eye2-hotplug` or `main`. */
  branch?: string;
  /** Base + short sha, e.g. `from main @ 9f3c2ea`. */
  base?: string;
  /** Owning project name. */
  project?: string;
  /** Durable change summary, e.g. `2 files · +84 -19`. */
  changesSummary?: string;
  /** True when the branch is a dedicated worktree (prefix `wt/`, stronger tint). */
  isWorktree?: boolean;
}

/** The task's live session state. Every field optional — backed rows only. */
export interface InspectorSession {
  model?: string;
  permissionMode?: string;
  /** Honest token label, e.g. `12.3k in · 4.5k out`. */
  tokensLabel?: string;
  /** Cost string, e.g. `$4.87`. */
  cost?: string;
  started?: string;
  duration?: string;
}

/** One changed file: path + line deltas (labels only; NO diff hunks — §3.3). */
export interface InspectorChangedFile {
  path: string;
  added?: number;
  removed?: number;
}

export interface InspectorDockProps {
  /** Immutable-after-creation provider identity (quiet text only). */
  provider?: ProviderId;
  /** WORKTREE section. Omitted/empty → the quiet `no worktree` state. */
  worktree?: InspectorWorktree;
  /** SESSION section. Rows render only when backed. */
  session?: InspectorSession;
  /** CHANGED FILES section. Empty → `No changes`. */
  changedFiles?: readonly InspectorChangedFile[];
  /** Open a changed file in the user's editor (renders the row as a button when set). */
  onOpenFile?: (path: string) => void;
  /** Accessible name for the complementary landmark. */
  label?: string;
  /**
   * Layout variant. `dock` (default) is the measured desktop content-height dock.
   * `disclosure` is the narrow/PWA fallback: an explicit desktop-required disclosure.
   */
  variant?: "dock" | "disclosure";
}

// --- Presentation --------------------------------------------------------------

function hasWorktreeData(w?: InspectorWorktree): boolean {
  return !!(w && (w.branch || w.base || w.project || w.changesSummary));
}

function WorktreeSection({ worktree }: { worktree?: InspectorWorktree }) {
  const w = worktree;
  const branchLabel = w?.branch ?? "main";
  const showData = hasWorktreeData(w);
  return (
    <section
      className="dh-inspector-section"
      data-dh-inspector-section="worktree"
      aria-label={INSPECTOR_COPY.worktreeHeading}
    >
      <h2 className="dh-inspector-section-heading" data-dh-inspector-section-heading="worktree">
        {INSPECTOR_COPY.worktreeHeading}
      </h2>
      {showData ? (
        <>
          <p
            className={`dh-inspector-branch${w?.isWorktree ? " dh-inspector-branch--wt" : ""}`}
            data-dh-inspector-branch=""
            data-dh-worktree={w?.isWorktree ? "" : undefined}
          >
            <span className="dh-inspector-branch-glyph" aria-hidden>
              ⎇
            </span>
            <span className="dh-inspector-branch-name">
              {w?.isWorktree && !branchLabel.startsWith("wt/") ? `wt/${branchLabel}` : branchLabel}
            </span>
          </p>
          {w?.base || w?.project ? (
            <p className="dh-inspector-subline" data-dh-worktree-base="">
              {[w?.base, w?.project].filter(Boolean).join(" · ")}
            </p>
          ) : null}
          {w?.changesSummary ? (
            <p className="dh-inspector-changes" data-dh-worktree-changes="">
              {w.changesSummary}
            </p>
          ) : null}
        </>
      ) : (
        // Quiet, honest state — the task is not running in a worktree.
        <p className="dh-inspector-quiet" data-dh-worktree-none="">
          {INSPECTOR_COPY.noWorktreePrefix} {branchLabel} · {INSPECTOR_COPY.noWorktreeSuffix}
        </p>
      )}
    </section>
  );
}

function SessionRow({ label, value, attr }: { label: string; value?: string; attr: string }) {
  if (!value) return null;
  return (
    <p className="dh-inspector-kv" data-dh-session-row={attr}>
      <span className="dh-inspector-kv-label">{label}</span>
      <span className="dh-inspector-kv-value">{value}</span>
    </p>
  );
}

function SessionSection({ session }: { session?: InspectorSession }) {
  const s = session;
  const C = INSPECTOR_COPY.session;
  const anyRow = !!(
    s &&
    (s.model || s.permissionMode || s.tokensLabel || s.cost || s.started || s.duration)
  );
  return (
    <section
      className="dh-inspector-section"
      data-dh-inspector-section="session"
      aria-label={INSPECTOR_COPY.sessionHeading}
    >
      <h2 className="dh-inspector-section-heading" data-dh-inspector-section-heading="session">
        {INSPECTOR_COPY.sessionHeading}
      </h2>
      {anyRow ? (
        <>
          <SessionRow label={C.model} value={s?.model} attr="model" />
          <SessionRow label={C.permissionMode} value={s?.permissionMode} attr="permission" />
          <SessionRow label={C.tokens} value={s?.tokensLabel} attr="tokens" />
          <SessionRow label={C.cost} value={s?.cost} attr="cost" />
          <SessionRow label={C.started} value={s?.started} attr="started" />
          <SessionRow label={C.duration} value={s?.duration} attr="duration" />
        </>
      ) : (
        <p className="dh-inspector-quiet" data-dh-session-none="">
          —
        </p>
      )}
    </section>
  );
}

function DeltaBadge({ added, removed }: { added?: number; removed?: number }) {
  if (!added && !removed) return null;
  return (
    <span className="dh-inspector-delta" data-dh-file-delta="">
      {added ? <span className="dh-inspector-delta-add">+{added}</span> : null}
      {removed ? <span className="dh-inspector-delta-del">-{removed}</span> : null}
    </span>
  );
}

function ChangedFilesSection({
  files,
  onOpenFile,
}: {
  files?: readonly InspectorChangedFile[];
  onOpenFile?: (path: string) => void;
}) {
  const list = files ?? [];
  return (
    <section
      className="dh-inspector-section"
      data-dh-inspector-section="changed-files"
      aria-label={INSPECTOR_COPY.changedFilesHeading}
    >
      <h2
        className="dh-inspector-section-heading"
        data-dh-inspector-section-heading="changed-files"
      >
        {INSPECTOR_COPY.changedFilesHeading}
      </h2>
      {list.length ? (
        <ul className="dh-inspector-filelist" data-dh-inspector-files="">
          {list.map((f) =>
            onOpenFile ? (
              <li key={f.path}>
                <button
                  type="button"
                  className="dh-inspector-file dh-inspector-file--action"
                  data-dh-file={f.path}
                  onClick={() => onOpenFile(f.path)}
                >
                  <span className="dh-inspector-file-path">{f.path}</span>
                  <DeltaBadge added={f.added} removed={f.removed} />
                </button>
              </li>
            ) : (
              <li key={f.path} className="dh-inspector-file" data-dh-file={f.path}>
                <span className="dh-inspector-file-path">{f.path}</span>
                <DeltaBadge added={f.added} removed={f.removed} />
              </li>
            ),
          )}
        </ul>
      ) : (
        <p className="dh-inspector-quiet" data-dh-changed-none="">
          {INSPECTOR_COPY.noChanges}
        </p>
      )}
    </section>
  );
}

export function InspectorDock({
  provider,
  worktree,
  session,
  changedFiles,
  onOpenFile,
  label = "Task inspector",
  variant = "dock",
}: InspectorDockProps): ReactNode {
  // Narrow/PWA: an explicit disclosure, NOT the full desktop dock.
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

  return (
    // ONE measured 300-wide, content-height, rounded glass dock. The geometry data
    // attrs are CONSTANT — the dock never resizes as its section data changes.
    <div
      className="dh-inspector dh-inspector-dock"
      data-dh-inspector=""
      data-dh-inspector-dock=""
      data-dh-surface=""
      data-dh-inspector-width={INSPECTOR_GEOMETRY.width}
      data-dh-inspector-radius={INSPECTOR_GEOMETRY.radius}
      data-dh-inspector-padding={INSPECTOR_GEOMETRY.padding}
      data-dh-inspector-height-mode={INSPECTOR_GEOMETRY.heightMode}
      aria-label={label}
    >
      <WorktreeSection worktree={worktree} />
      <SessionSection session={session} />
      <ChangedFilesSection files={changedFiles} onOpenFile={onOpenFile} />

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
  return settings?.devHubFeatures?.inspectorDock === false ? "legacy" : "devhub";
}

/** True only when the inspector-dock slice flag is applied. */
export function isInspectorDockApplied(
  features: Partial<DevHubFeatureFlags> | undefined,
): boolean {
  return features?.inspectorDock === true;
}

/** Mirror the shell geometry so the dock never drifts from the shell lane. */
export const INSPECTOR_SHELL_GEOMETRY = SHELL_GEOMETRY;
