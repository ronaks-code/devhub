import { type ReactNode, useEffect, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { DevHubFeatureFlags } from "@devhub/engine/providers";
import {
  ActivityTimeline,
  type ActivityEntry,
  type PlanModel,
} from "./ActivityTimeline.js";
import { ToolCard } from "../../ToolCard.js";
import { Markdown } from "../../Markdown.js";
import type { PairedToolUse } from "../../../lib/transcript.js";
import { useStickToBottom } from "../../../hooks/useStickToBottom.js";

/**
 * ThreadWorkspace — the transcript IS the task (M6 slice 4).
 *
 * `design-lock.md` §4 and `component-state-matrix.md` §8: active work appears in the
 * SAME vertical narrative as completed work — there is no separate progress
 * dashboard. The core task canvas (`#181818`, no page card) admits SURFACES only for
 * requests, user bubbles, compact controls, the composer, and the inspector.
 * Everything else — assistant prose/tables/lists/code, ordinary tool rows, normal
 * activity, streaming deltas, and unknown-event raw diagnostics — is UNFRAMED
 * (invariant 4). A surfaced control never masquerades as prose, and prose is never
 * boxed to look like a control.
 *
 * The composer sits in a geometry-STABLE slot (736x98, 16-unit bottom gutter,
 * ~21-unit radius) that does NOT move when Send becomes Stop or when activity
 * appends to the transcript (`design-lock.md` §4/§6). The empty existing task
 * renders a BLANK central canvas (zero children, zero SVG, no hero/suggestions)
 * while the composer and inspector still render.
 *
 * Pure presentation over a model; native virtualized scroll is preserved (this
 * region is NEVER wrapped in a shadcn `ScrollArea` — invariant 8). Mounted only
 * behind the default-off `threadWorkspace` slice flag; flag-off keeps the legacy
 * `TranscriptPane`/renderers chat.
 *
 * Renders no `<svg>`/`<img>`.
 */

export type ProviderId = "openai" | "anthropic";

/** Terminal-or-pending state of an inline request. */
export type RequestState = "pending" | "expired" | "cancelled";

/** A provider-proved action offered on an inline request. */
export interface RequestAction {
  id: string;
  label: string;
}

/**
 * One item in the vertical narrative. Completed and active work share this one union
 * so they render in a single transcript, not in split panes/dashboards.
 */
export type ThreadItem =
  /** Assistant prose/tables/lists/code/reasoning — UNFRAMED. */
  | { kind: "assistant"; id: string; content: ReactNode }
  /** User content — the ONE surfaced right-aligned bubble in the narrative. */
  | { kind: "user"; id: string; content: ReactNode }
  /** Inline compact activity + optional expandable plan (delegated) — UNFRAMED. */
  | { kind: "activity"; id: string; entries?: ActivityEntry[]; plan?: PlanModel | null }
  /** Capability-gated inline request — SURFACED (`#262626`), inline, never modal. */
  | { kind: "request"; id: string; prompt: string; actions?: RequestAction[]; state?: RequestState }
  /** The anchored in-progress region streaming native deltas — UNFRAMED. */
  | { kind: "streaming"; id: string; content?: ReactNode; elapsedLabel?: string }
  /**
   * Unknown native event rendered as a bounded raw diagnostic — UNFRAMED, never a
   * fabricated tool. `collapsed` renders it as a slim, closed `<details>` (a one-line
   * summary, full bounded text one click away) instead of an always-open `<pre>` —
   * used for internal plumbing (hook/queue/attachment/system/thinking) so it reads as
   * a skippable row rather than inline chat content (M8: these used to render as raw
   * JSON dumps indistinguishable from real conversation).
   */
  | { kind: "raw"; id: string; raw: string; collapsed?: boolean }
  /**
   * A REAL tool call (tool_use + its paired tool_result) rendered as ONE compact,
   * collapsed-by-default card (Aurora Cockpit §3.3). This replaces the old raw-JSON
   * diagnostic for the tool blocks we can render richly; it is still backed only by
   * real transcript data, never a fabricated call. Diff hunks stay collapsed.
   */
  | { kind: "tool"; id: string; block: PairedToolUse };

/** Composer send affordance. `stop` is shown only when a native interrupt is product-enabled. */
export type ComposerSendState = "send" | "stop";

/** Copy for the workspace. One source for the `T-thread`/`T-active`/`T-intervention` diff. */
export const THREAD_COPY = Object.freeze({
  /** Timeout is terminal and never emits an action (design-lock §5, invariant 2). */
  requestExpired: "Request expired — no action taken",
  /** Cancellation is the INDEPENDENT terminal state, distinct from expiry. */
  cancelledByYou: "Cancelled by you",
  /** Elapsed prefix; the elapsed value comes from acknowledged work, never a fabricated estimate. */
  workingPrefix: "Working for",
  composerLabel: "Message",
  sendLabel: "Send",
  stopLabel: "Stop current turn",
  placeholder: "Describe the outcome or change…",
  requestGroupLabel: "Request",
  /** Banner above the transcript when older history exists before `items[0]`. */
  loadOlder: "Showing recent messages — load older history",
  loadingOlder: "Loading older messages…",
});

/** Max chars of a raw diagnostic that reaches the DOM. Unknown events are bounded, never unbounded. */
export const RAW_DIAGNOSTIC_MAX = 2048;

/**
 * The measured transcript/composer geometry, transcribed from
 * `reference-capture-manifest.md`. Mirrors the matching fields on the shell's
 * `SHELL_GEOMETRY` so the workspace and shell never drift, and so the stable-composer
 * invariant is asserted against a single source.
 */
export const THREAD_GEOMETRY = Object.freeze({
  transcriptWidth: 736,
  composerWidth: 736,
  composerHeight: 98,
  composerBottomGutter: 16,
  composerRadius: 21,
  userBubbleMax: 566,
} as const);

/**
 * Drop any action that would present an `Always allow` (persistent-grant) affordance.
 * Only per-turn provider-proved actions may reach the DOM (design-lock §5, invariant
 * 2): a timeout never emits Allow and a persistent auto-grant is never offered here.
 */
export function sanitizeRequestActions(
  actions: readonly RequestAction[] | undefined,
): RequestAction[] {
  if (!actions) return [];
  return actions.filter((a) => !/always/i.test(a.label));
}

/**
 * Bound + strip NUL/control chars from a raw diagnostic before it reaches the DOM.
 * Keeps tab/newline/carriage-return so multi-line diagnostics stay readable; drops
 * every other C0 control and DEL; hard-caps the length. Implemented with a char-code
 * scan (no control chars in this source file).
 */
export function boundRawDiagnostic(raw: string): string {
  let out = "";
  for (const ch of raw) {
    const code = ch.codePointAt(0) ?? 0;
    const isControl = (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0x7f;
    if (isControl) continue;
    out += ch;
    if (out.length >= RAW_DIAGNOSTIC_MAX) break;
  }
  return out;
}

/**
 * The who-line (Aurora Cockpit §3.3): a small avatar tile + role name above a
 * bubble/block so the vertical narrative reads at a glance. Honest by role only —
 * it never fabricates a model/name the mapper doesn't carry (the AI tile takes the
 * warm gradient identity, the user tile a dark violet). Decorative → aria-hidden;
 * the role is already conveyed by DOM order + the bubble alignment.
 */
function WhoLine({ who }: { who: "assistant" | "user" }) {
  return (
    <div className={`dh-who-line dh-who-line--${who}`} data-dh-who-line={who} aria-hidden>
      <span className={`dh-who-avatar dh-who-avatar--${who}`} />
      <span className="dh-who-name">{who === "assistant" ? "Assistant" : "You"}</span>
    </div>
  );
}

function AssistantBlock({ content }: { content: ReactNode }) {
  // Unframed prose: no surface, no card. Just a who-line + text block in the
  // narrative. Real transcript text is a plain string (see `mapMessagesToThreadItems`)
  // — render it through the shared `Markdown` component (the mapper stays pure/
  // data-only) so `**bold**`/lists/code fences render instead of literal asterisks
  // (W3-TX). A non-string `content` (e.g. this file's own test fixtures) passes
  // through unchanged.
  return (
    <div className="dh-thread-assistant" data-dh-assistant="" data-dh-unframed="">
      <WhoLine who="assistant" />
      {typeof content === "string" ? <Markdown text={content} /> : content}
    </div>
  );
}

function UserBubble({ content }: { content: ReactNode }) {
  // The one surfaced bubble: right-aligned, violet gradient, capped at the measured max width.
  return (
    <div className="dh-thread-user-wrap" data-dh-user-wrap="">
      <WhoLine who="user" />
      <div
        className="dh-thread-user"
        data-dh-user=""
        data-dh-surface=""
        data-dh-bubble-max={THREAD_GEOMETRY.userBubbleMax}
      >
        {content}
      </div>
    </div>
  );
}

/** A real tool call rendered as one compact, collapsed-by-default card (§3.3). */
function ToolBlock({ block }: { block: PairedToolUse }) {
  // History rendering (not live): ToolCard shows the one-line result collapsed; no
  // diff is auto-expanded (EditDiffCard is collapsed by default per §3.3).
  return (
    <div className="dh-thread-tool" data-dh-thread-tool="" data-dh-unframed="">
      <ToolCard block={block} />
    </div>
  );
}

function InlineRequest({
  prompt,
  actions,
  state = "pending",
}: {
  prompt: string;
  actions?: RequestAction[];
  state?: RequestState;
}) {
  const safeActions = state === "pending" ? sanitizeRequestActions(actions) : [];
  return (
    // A surfaced control, inline at transcript width. NOT a modal: no role="dialog",
    // no aria-modal — it never traps focus and never steals typing focus.
    <div
      className={`dh-thread-request dh-thread-request--${state}`}
      data-dh-request=""
      data-dh-surface=""
      data-dh-request-state={state}
      role="group"
      aria-label={THREAD_COPY.requestGroupLabel}
    >
      <p className="dh-request-prompt" data-dh-request-prompt="">
        {prompt}
      </p>
      {state === "pending" ? (
        <div className="dh-request-actions" data-dh-request-actions="">
          {safeActions.map((a) => (
            <button key={a.id} type="button" className="dh-request-action" data-dh-request-action="">
              {a.label}
            </button>
          ))}
        </div>
      ) : (
        <p
          className="dh-request-terminal"
          data-dh-request-terminal=""
          data-dh-request-outcome={state}
        >
          {state === "expired" ? THREAD_COPY.requestExpired : THREAD_COPY.cancelledByYou}
        </p>
      )}
    </div>
  );
}

function StreamingBlock({ content }: { content?: ReactNode }) {
  // The anchored in-progress region. Deltas append here; it is UNFRAMED and carries
  // NO aria-live of its own — the single workspace-level live region announces status.
  return (
    <div className="dh-thread-streaming" data-dh-streaming="" data-dh-unframed="">
      {content}
    </div>
  );
}

/** The `<summary>` for a collapsed raw diagnostic: its first line, short enough to
 *  read as a slim row rather than a wall of text. The full bounded content is one
 *  click away — nothing real is dropped, only de-emphasized (M8). */
function rawSummaryLine(bounded: string): string {
  const firstLine = bounded.split("\n", 1)[0] ?? bounded;
  return firstLine.length > 96 ? `${firstLine.slice(0, 96)}…` : firstLine;
}

function RawDiagnostic({ raw, collapsed }: { raw: string; collapsed?: boolean }) {
  // Unknown native event: bounded raw diagnostic, never a fabricated tool/reasoning.
  const bounded = boundRawDiagnostic(raw);
  if (collapsed) {
    // Internal plumbing (hook/queue/attachment/system/thinking): closed by default so
    // it reads as a skippable row, not inline chat content — never a raw JSON dump in
    // the conversation.
    return (
      <details className="dh-thread-raw-collapsed" data-dh-raw-collapsed="" data-dh-unframed="">
        <summary className="dh-thread-raw-summary" data-dh-raw-summary="">
          {rawSummaryLine(bounded)}
        </summary>
        <pre className="dh-thread-raw" data-dh-raw="">
          {bounded}
        </pre>
      </details>
    );
  }
  return (
    <pre className="dh-thread-raw" data-dh-raw="" data-dh-unframed="">
      {bounded}
    </pre>
  );
}

function ThreadItemView({ item }: { item: ThreadItem }): ReactNode {
  switch (item.kind) {
    case "assistant":
      return <AssistantBlock content={item.content} />;
    case "user":
      return <UserBubble content={item.content} />;
    case "activity":
      return <ActivityTimeline entries={item.entries} plan={item.plan} />;
    case "request":
      return <InlineRequest prompt={item.prompt} actions={item.actions} state={item.state} />;
    case "streaming":
      return <StreamingBlock content={item.content} />;
    case "raw":
      return <RawDiagnostic raw={item.raw} collapsed={item.collapsed} />;
    case "tool":
      return <ToolBlock block={item.block} />;
    default:
      return null;
  }
}

export interface ThreadWorkspaceProps {
  items: ThreadItem[];
  /** Immutable-after-creation provider identity of the task (used for context only). */
  provider?: ProviderId;
  /** Composer affordance. Defaults to `send`; geometry is invariant across the swap. */
  sendState?: ComposerSendState;
  /** Placeholder shown on a fresh composer. Defaults to the outcome-oriented prompt. */
  placeholder?: string;
  /** Whether send is enabled. Presentation only; the swap never changes geometry. */
  canSend?: boolean;
  /**
   * Override the built-in geometry-proof composer slot with a real one (M6 Task 9,
   * additive/optional). When omitted, the inert `ComposerSlot` renders exactly as
   * before — the original byte-for-byte presentation-only contract. A host with a
   * live `composerSurface` mount (the canonical `Composer`) supplies this instead of
   * duplicating a second composer in the same view.
   */
  composerSlot?: ReactNode;
  /**
   * True when older history exists before `items[0]` (a huge-transcript tail
   * window, mirroring `SessionMessagesPage.truncatedFromStart`). Paired with
   * `onLoadOlder` to show the "load older history" banner; omitted/false hides
   * it — a caller that never hydrates a bounded tail (or has no more to load)
   * simply never passes it.
   */
  truncatedFromStart?: boolean;
  /**
   * Fetch the previous (older) window of history, e.g. by growing the tail
   * fetch window (matches legacy `TranscriptPane`'s "load more" contract).
   * Omit to hide the load-older affordance entirely.
   */
  onLoadOlder?: () => void;
  /** True while a load-older fetch is in flight — disables the banner button. */
  loadingOlder?: boolean;
}

/**
 * The geometry-stable composer slot. Its measured dimensions are written as constant
 * `data-dh-composer-*` attributes that DO NOT depend on `sendState` or the transcript
 * item count — the slice's stable-composer invariant (design-lock §4/§6).
 */
function ComposerSlot({
  sendState,
  placeholder,
  canSend,
}: {
  sendState: ComposerSendState;
  placeholder: string;
  canSend: boolean;
}) {
  const isStop = sendState === "stop";
  return (
    <div
      className="dh-thread-composer"
      data-dh-composer=""
      data-dh-surface=""
      data-dh-composer-width={THREAD_GEOMETRY.composerWidth}
      data-dh-composer-height={THREAD_GEOMETRY.composerHeight}
      data-dh-composer-gutter={THREAD_GEOMETRY.composerBottomGutter}
      data-dh-composer-radius={THREAD_GEOMETRY.composerRadius}
    >
      <label className="dh-sr-only" htmlFor="dh-composer-input">
        {THREAD_COPY.composerLabel}
      </label>
      <textarea
        id="dh-composer-input"
        className="dh-composer-input"
        data-dh-composer-input=""
        placeholder={placeholder}
        rows={2}
      />
      <div className="dh-composer-footer" data-dh-composer-footer="">
        {/* Send<->Stop swaps LABEL ONLY, in the same slot; geometry never shifts. */}
        <button
          type="button"
          className="dh-composer-send"
          data-dh-composer-send=""
          data-dh-send-state={sendState}
          disabled={!isStop && !canSend}
        >
          {isStop ? THREAD_COPY.stopLabel : THREAD_COPY.sendLabel}
        </button>
      </div>
    </div>
  );
}

/**
 * Rough initial-guess size (px) for an unmeasured item, before the virtualizer's
 * `measureElement` ref reports its real rendered height. Only affects the very
 * first paint / SSR fallback — every mounted item is re-measured immediately.
 */
const ESTIMATED_ITEM_SIZE = 96;

export function ThreadWorkspace({
  items,
  provider,
  sendState = "send",
  placeholder = THREAD_COPY.placeholder,
  canSend = false,
  composerSlot,
  truncatedFromStart = false,
  onLoadOlder,
  loadingOlder = false,
}: ThreadWorkspaceProps) {
  const isEmpty = items.length === 0;
  // The native-scroll transcript container (`overflow-y: auto`, never a shadcn
  // ScrollArea — invariant 8) doubles as the virtualizer's scroll element, exactly
  // the pattern legacy `TranscriptPane.tsx` uses. `initialRect` gives the
  // virtualizer a sane pre-measurement window (matters for `renderToStaticMarkup`
  // and any pre-layout paint, where no ResizeObserver has reported a real rect
  // yet) so a normal-size transcript still renders in full before the first real
  // measurement lands.
  const transcriptRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => transcriptRef.current,
    estimateSize: () => ESTIMATED_ITEM_SIZE,
    overscan: 10,
    initialRect: { width: THREAD_GEOMETRY.transcriptWidth, height: 800 },
  });
  // "Follow only while pinned near the bottom" — the same rule legacy
  // `TranscriptPane.tsx` uses (see `useStickToBottom`'s own doc comment).
  const stick = useStickToBottom(transcriptRef);
  // Land on the LATEST message the first time this task/session has content —
  // never at the top of a huge loaded window (W3-TX: a resumed/opened transcript
  // used to open scrolled to its oldest loaded message). Guarded by a ref so it
  // fires once per mounted instance; callers that need a fresh landing per task
  // (e.g. Browse switching sessions) key the component so it remounts.
  const openedRef = useRef(false);
  useEffect(() => {
    if (openedRef.current || items.length === 0) return;
    openedRef.current = true;
    stick.pin();
    const id = requestAnimationFrame(() => virtualizer.scrollToIndex(items.length - 1, { align: "end" }));
    return () => cancelAnimationFrame(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items.length]);
  // Follow live growth (new messages appended at the tail, e.g. a running turn)
  // only while pinned. Loading OLDER history prepends at the front instead — the
  // reader is (almost always) scrolled away from the bottom to see the "load
  // older" banner, so `stick.isPinned` is already false and this is a no-op.
  useEffect(() => {
    if (items.length === 0) return;
    return stick.followToIndex(() => virtualizer.scrollToIndex(items.length - 1, { align: "end" }));
  }, [items.length, virtualizer, stick.followToIndex]);
  // The single polite, coarse live region for the whole workspace. It reflects the
  // anchored streaming item's acknowledged elapsed label — never per-token, never a
  // fabricated estimate. Empty (but present) when nothing is streaming.
  const streaming = items.find(
    (i): i is Extract<ThreadItem, { kind: "streaming" }> => i.kind === "streaming",
  );
  const workingText =
    streaming && streaming.elapsedLabel
      ? `${THREAD_COPY.workingPrefix} ${streaming.elapsedLabel}`
      : "";

  return (
    <div className="dh-thread-workspace" data-dh-thread-workspace="" data-dh-provider={provider}>
      {/* Older-history banner (W3-TX): only when a caller both reports more history
          exists AND supplies a fetch — a caller that never hydrates a bounded tail
          never renders this. Sits above the scroll region (like legacy
          `TranscriptPane`'s banner), not inside it, so it never scrolls away. */}
      {onLoadOlder && truncatedFromStart ? (
        <button
          type="button"
          onClick={onLoadOlder}
          disabled={loadingOlder}
          className="dh-thread-load-older"
          data-dh-load-older=""
        >
          {loadingOlder ? THREAD_COPY.loadingOlder : THREAD_COPY.loadOlder}
        </button>
      ) : null}
      {/* Transcript column at the measured 736 width. Native scroll — NOT ScrollArea. */}
      <div
        ref={transcriptRef}
        onScroll={stick.onScroll}
        className="dh-thread-transcript"
        data-dh-transcript=""
        data-dh-transcript-width={THREAD_GEOMETRY.transcriptWidth}
      >
        {/* Empty existing task: a blank canvas with ZERO children/SVG/hero. The region
            element exists (so layout holds) but renders no content. */}
        {isEmpty ? null : (
          <ol
            role="list"
            className="dh-thread-items"
            data-dh-thread-items=""
            style={{ position: "relative", height: virtualizer.getTotalSize() }}
          >
            {/* Windowed: only the visible slice (+ overscan) becomes a live DOM
                node — a 600-message transcript renders well under 120 `<li>`s
                instead of all 600 (the M8-PERF-A11Y cold-render regression). */}
            {virtualizer.getVirtualItems().map((vi) => {
              const item = items[vi.index]!;
              return (
                <li
                  key={item.id}
                  data-index={vi.index}
                  ref={virtualizer.measureElement}
                  role="listitem"
                  className="dh-thread-item"
                  data-dh-thread-item=""
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    transform: `translateY(${vi.start}px)`,
                  }}
                >
                  <ThreadItemView item={item} />
                </li>
              );
            })}
          </ol>
        )}
      </div>

      {/* Exactly one polite live region for the entire workspace. */}
      <div
        className="dh-sr-only"
        data-dh-live-region=""
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {workingText}
      </div>

      {/* The composer renders even when the transcript is empty. */}
      {composerSlot ?? <ComposerSlot sendState={sendState} placeholder={placeholder} canSend={canSend} />}
    </div>
  );
}

export type ThreadWorkspaceMode = "devhub" | "legacy";

/**
 * Slice-flag gate. Mirrors `resolveTaskRailMode`/`resolveTaskHeaderSetupMode`:
 * ThreadWorkspace mounts only for a server-resolved true `threadWorkspace`; anything
 * else (false / undefined / missing settings) keeps the legacy transcript — the
 * immediate, non-destructive rollback surface.
 */
export function resolveThreadWorkspaceMode(
  settings: { devHubFeatures?: Partial<DevHubFeatureFlags> } | null | undefined,
): ThreadWorkspaceMode {
  return settings?.devHubFeatures?.threadWorkspace === false ? "legacy" : "devhub";
}

/** True only when the thread-workspace slice flag is applied. */
export function isThreadWorkspaceApplied(
  features: Partial<DevHubFeatureFlags> | undefined,
): boolean {
  return features?.threadWorkspace === true;
}
