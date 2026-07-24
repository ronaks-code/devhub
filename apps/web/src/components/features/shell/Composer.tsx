import {
  type ChangeEvent,
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { DevHubFeatureFlags } from "@devhub/engine/providers";
import {
  PERMISSION_FIELD_LABEL,
  providerIdentity,
  type ProviderId,
} from "../providers/provider-capabilities.js";
import { MentionPicker, detectMention } from "../../MentionPicker.js";
import { SlashPalette, filterCommands } from "../../SlashPalette.js";
import { ModelBadge } from "../../ModelBadge.js";
import { api, type FileEntry } from "../../../lib/api.js";

/**
 * Composer — the canonical, geometry-stable task composer (M6 slice 5).
 *
 * `design-lock.md` §6: the composer sits in a measured 736x98 slot with a 16-unit
 * bottom gutter and ~21-unit radius, on the elevated `#2d2d2d` surface. Its geometry
 * NEVER moves when Send becomes Stop or when the transcript grows (`design-lock.md`
 * §4). It shows the real folder / permission / model / mode context compactly and
 * NEVER exposes credentials or an unsandboxed shell fallback (§6).
 *
 * This is a from-scratch reimplementation of the legacy `ChatPane` composer against
 * the SAME registries/hooks (`useDraft`, `usePromptHistory`, `detectMention`,
 * `filterCommands`, snippets) — it does NOT edit the user-owned `ChatPane.tsx`. Pure
 * decision logic is exported so it can be asserted without a DOM: `decideComposerKey`
 * (Enter/Shift+Enter/boundary history/picker ownership), `computeSendDisabledReason`,
 * `resolveSendState` (honest Stop gating), and the provider-native footer/
 * `computePickerState` helpers.
 *
 * When wired live (a host passes `onDraftChange`, making the textarea controlled) the
 * composer OWNS its own slash/mention pickers: typing a leading `/` opens a ranked
 * command menu and an `@`-token opens the file picker, both with arrow/enter/click
 * insert — rendered as an overlay above the stable slot so geometry never shifts. The
 * footer shows a `ModelBadge` (provider mark + clean model name) in place of the old
 * raw id/label string.
 *
 * Mounted only behind the default-off `composerSurface` slice flag; flag-off keeps the
 * legacy `ChatPane` composer as the immediate, non-destructive rollback.
 */

export type { ProviderId };

/** Composer send affordance. `stop` shows only when a native interrupt path is product-enabled. */
export type ComposerSendState = "send" | "stop";

/**
 * Connection health of the task's transport. `stale` = a superseded revision;
 * `reconnecting` = the socket is dialing (first connect or a backoff retry), so
 * the composer shows a live spinner instead of the terminal disconnected copy.
 */
export type ComposerConnection = "connected" | "reconnecting" | "disconnected" | "stale";

/**
 * The measured composer geometry, transcribed from `reference-capture-manifest.md`
 * and mirrored on the shell's `SHELL_GEOMETRY`/`THREAD_GEOMETRY` so the composer never
 * drifts from the shell. This is the single source the stable-slot invariant asserts.
 */
export const COMPOSER_GEOMETRY = Object.freeze({
  width: 736,
  height: 98,
  bottomGutter: 16,
  radius: 16,
} as const);

/**
 * Accessible disabled reasons. Each blocking condition has a distinct, honest reason
 * that reaches assistive tech via `aria-describedby`. The disconnected/stale reason is
 * literally the reconnect note so there is ONE source for that copy.
 */
const DISABLED_REASON = Object.freeze({
  pendingCreation: "Creating the task…",
  unsupported: "Sending isn't available for this provider task.",
  disconnectedStale: "Reconnect to send. Your draft is saved.",
  reconnecting: "Connecting… Your draft is saved.",
  missingWriterLease: "Another session holds the write lock.",
  blockingRequest: "Respond to the request above to continue.",
  empty: "Write a message to send.",
});

/** Copy for the composer. One source for the `T-composer`/`L-chat` visible-copy diff. */
export const COMPOSER_COPY = Object.freeze({
  textareaLabel: "Message",
  // Chat framing (W3-SHELL): onboarding sets up "start a chat", so the composer
  // invites a conversation — questions welcome, not only task/PR-shaped work.
  newTaskPlaceholder: "Ask a question or describe what you need…",
  sendLabel: "Send",
  stopLabel: "Stop current turn",
  reconnectNote: DISABLED_REASON.disconnectedStale,
  disabledReason: DISABLED_REASON,
});

/** DOM ids so the label/reason associations are stable and testable. */
const TEXTAREA_ID = "dh-composer-textarea";
const SEND_REASON_ID = "dh-composer-send-reason";

// --- Pure decision functions (asserted without a DOM) --------------------------

/**
 * The Stop affordance is honest: it appears ONLY when a turn is running AND a real
 * native interrupt path is product-enabled. Claude has no native interrupt until M4
 * (`persistentClaude` false), so a running Claude turn correctly stays `send` — the
 * gated state is proven, not faked (`design-lock.md` §6, invariant).
 */
export interface ComposerInterruptContext {
  turnRunning?: boolean;
  nativeInterruptEnabled?: boolean;
}
export function resolveSendState(ctx: ComposerInterruptContext): ComposerSendState {
  return ctx.turnRunning === true && ctx.nativeInterruptEnabled === true ? "stop" : "send";
}

/** Everything that can block a send. Missing fields default to the sendable value. */
export interface ComposerSendContext {
  draft: string;
  taskState?: "ready" | "pending-creation";
  sendSupported?: boolean;
  connection?: ComposerConnection;
  hasWriterLease?: boolean;
  hasBlockingRequest?: boolean;
}

/**
 * The first-unmet blocking reason, in a deterministic precedence, or null when the
 * message can be sent. Structural blockers (pending creation, unsupported) come first,
 * then terminal transport (disconnected/stale), then the write lease, then a pending
 * request, then an empty draft. CSS state never substitutes for these — the button
 * carries a real `disabled` + accessible reason.
 *
 * A DIALING socket (`reconnecting` — first connect or a backoff retry) is deliberately
 * NOT a blocking reason (#12): the transport (`openChat` in `lib/ws.ts`) queues sends
 * placed before the socket is OPEN and flushes them, in order, on connect — so a fresh
 * chat accepts an OPTIMISTIC send immediately instead of feeling dead for the second
 * or two until `onOpen`. The composer still shows a live "Connecting…" notice, but the
 * draft is sendable. Only the TERMINAL states (`disconnected` = the socket gave up, with
 * a real Reconnect action; `stale` = a superseded revision) keep the send blocked.
 */
export function computeSendDisabledReason(ctx: ComposerSendContext): string | null {
  const R = DISABLED_REASON;
  if (ctx.taskState === "pending-creation") return R.pendingCreation;
  if (ctx.sendSupported === false) return R.unsupported;
  if (ctx.connection === "disconnected" || ctx.connection === "stale") return R.disconnectedStale;
  if (ctx.hasWriterLease === false) return R.missingWriterLease;
  if (ctx.hasBlockingRequest === true) return R.blockingRequest;
  if (ctx.draft.trim() === "") return R.empty;
  return null;
}

/** Keyboard context for the composer textarea. */
export interface ComposerKeyContext {
  key: string;
  shiftKey: boolean;
  /** Which picker is open (mention/slash), if any. */
  picker: "none" | "mention" | "slash";
  /** Number of picker matches (0 = the picker doesn't trap the key). */
  pickerCount: number;
  caretAtStart: boolean;
  caretAtEnd: boolean;
  /** History recall is disabled while a turn is running. */
  turnRunning: boolean;
  /** True while already walking history (Down only steps forward then). */
  historyNavigating: boolean;
}

export type ComposerKeyAction =
  | { type: "none" }
  | { type: "send" }
  | { type: "newline" }
  | { type: "history-prev" }
  | { type: "history-next" }
  | { type: "picker-next" }
  | { type: "picker-prev" }
  | { type: "picker-accept" }
  | { type: "picker-dismiss" };

/**
 * Decide what a keypress does. The open picker OWNS Arrow/Enter/Tab/Escape (so focus
 * stays in the textarea); Enter sends and Shift+Enter inserts a newline; boundary
 * Up/Down recall history only while idle at the caret boundary. Mirrors the legacy
 * `ChatPane.onKeyDown` exactly without importing it.
 */
export function decideComposerKey(
  ctx: ComposerKeyContext,
): { action: ComposerKeyAction; preventDefault: boolean } {
  const { key, shiftKey, picker, pickerCount } = ctx;

  if (picker !== "none") {
    if (key === "ArrowDown" && pickerCount > 0) return { action: { type: "picker-next" }, preventDefault: true };
    if (key === "ArrowUp" && pickerCount > 0) return { action: { type: "picker-prev" }, preventDefault: true };
    if ((key === "Enter" && !shiftKey) || key === "Tab") {
      if (pickerCount > 0) return { action: { type: "picker-accept" }, preventDefault: true };
      // No matches: fall through so Enter still sends / Tab does nothing special.
    }
    if (key === "Escape") return { action: { type: "picker-dismiss" }, preventDefault: true };
  }

  if (key === "Enter" && !shiftKey) return { action: { type: "send" }, preventDefault: true };
  if (key === "Enter" && shiftKey) return { action: { type: "newline" }, preventDefault: false };

  if ((key === "ArrowUp" || key === "ArrowDown") && !ctx.turnRunning) {
    if (key === "ArrowUp" && ctx.caretAtStart) return { action: { type: "history-prev" }, preventDefault: false };
    if (key === "ArrowDown" && ctx.caretAtEnd && ctx.historyNavigating) {
      return { action: { type: "history-next" }, preventDefault: false };
    }
  }

  return { action: { type: "none" }, preventDefault: false };
}

/** Slash/mention picker state derived from the live text + caret, using the shared registries. */
export interface ComposerPickerState {
  picker: "none" | "mention" | "slash";
  /** Ranked slash-command matches (empty for mention/none). */
  matches: string[];
  /** The detected mention token (null for slash/none). */
  mention: { query: string; start: number; end: number } | null;
}

/**
 * Compute picker state against the SAME registries the legacy composer uses. Slash mode
 * requires the whole draft to be a single leading-`/` token (so a message that merely
 * starts with `/path ...` is not slash mode); otherwise an `@`-token opens the mention
 * picker via the shared `detectMention`.
 */
export function computePickerState(
  text: string,
  caret: number,
  slashCommands: string[],
): ComposerPickerState {
  const slashMatch = /^\/(\S*)$/.exec(text);
  if (slashMatch) {
    const matches = filterCommands(slashCommands, slashMatch[1]!);
    return { picker: matches.length > 0 ? "slash" : "none", matches, mention: null };
  }
  const mention = detectMention(text, caret);
  if (mention) return { picker: "mention", matches: [], mention };
  return { picker: "none", matches: [], mention: null };
}

/** Insert a chosen slash command as `/name ` (trailing space for arguments). */
export function applySlashInsert(command: string): string {
  return `/${command} `;
}

/** Replace the detected mention token with the picked path (dir keeps the `/` open). */
export function applyMentionInsert(
  text: string,
  mention: { start: number; end: number; query?: string },
  insertPath: string,
  isDir = false,
): string {
  const insert = `@${insertPath}${isDir ? "/" : " "}`;
  return text.slice(0, mention.start) + insert + text.slice(mention.end);
}

/** Append a snippet after the existing draft with a separating blank line. */
export function appendSnippet(draft: string, snippet: string): string {
  const base = draft.trim();
  return base ? `${base}\n\n${snippet}` : snippet;
}

/** Provider-native footer context. Permission/mode strings pass through VERBATIM. */
export interface ComposerFooterInput {
  model?: string;
  mode?: string;
  permissionMode?: string;
  folder?: string;
}
export interface ComposerFooterContext {
  provider: ProviderId;
  identityLabel: string;
  modelValue?: string;
  modeValue?: string;
  permissionLabel: string;
  permissionValue?: string;
  folderValue?: string;
}

/**
 * Build the footer context. The permission LABEL is derived from the provider (Codex
 * `Permissions`, Claude `Permission mode`) so a bad inventory can't cross-map it; the
 * permission/mode VALUES are the provider-native runtime strings shown unchanged — they
 * are NEVER remapped by equality between providers (`design-lock.md` §5/§6).
 */
export function composerFooterContext(
  provider: ProviderId,
  input: ComposerFooterInput,
): ComposerFooterContext {
  return {
    provider,
    identityLabel: providerIdentity(provider).label,
    modelValue: input.model,
    modeValue: input.mode,
    permissionLabel: PERMISSION_FIELD_LABEL[provider],
    permissionValue: input.permissionMode,
    folderValue: input.folder,
  };
}

// --- Presentation --------------------------------------------------------------

export interface ComposerProps {
  /** Immutable-after-creation provider identity (footer context only). */
  provider?: ProviderId;
  /** Fresh task → outcome-oriented placeholder. */
  isNewTask?: boolean;
  /** Draft text (task/provider-scoped; owned by `useDraft`, never cleared until send is accepted). */
  draft?: string;
  /** Send affordance; geometry is invariant across the swap. */
  sendState?: ComposerSendState;
  /** When non-null, send is disabled and this reason is exposed to assistive tech. */
  disabledReason?: string | null;
  /** Transport health; a non-connected value keeps the draft editable and shows the reconnect note. */
  connection?: ComposerConnection;
  /** Compact provider-native context (folder/permission/model/mode). */
  footer?: ComposerFooterInput;
  /**
   * Slash commands the session advertises (without the leading `/`), merged with
   * the always-available built-ins by `filterCommands`. Empty/omitted still yields
   * the built-in command menu, so `/` is never dead.
   */
  slashCommands?: string[];
  /** Placeholder override. */
  placeholder?: string;
  /**
   * Live data-wire hooks (M6 Task 9, additive/optional). When omitted the textarea
   * stays exactly as before (an uncontrolled `defaultValue`) and the send button has
   * no click handler — byte-for-byte the original presentation-only contract. A real
   * host (e.g. the Chat-tab composer host) supplies these to make the draft/send
   * affordance genuinely live without changing geometry or any existing prop's
   * default behavior.
   */
  onDraftChange?: (value: string) => void;
  onKeyDown?: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
  onSend?: () => void;
  /**
   * Manual reconnect for the disconnected state (F3): renders a REAL Reconnect
   * button in the connection notice instead of dead "Reconnect to send" copy.
   * Omitted → the plain notice text, exactly as before.
   */
  onReconnect?: () => void;
}

function FooterContext({ provider, footer }: { provider?: ProviderId; footer?: ComposerFooterInput }) {
  if (!provider) return null;
  const ctx = composerFooterContext(provider, footer ?? {});
  const pairs: Array<{ label: string; value: string }> = [];
  if (ctx.folderValue) pairs.push({ label: "Folder", value: ctx.folderValue });
  if (ctx.modeValue) pairs.push({ label: "Mode", value: ctx.modeValue });
  if (ctx.permissionValue) pairs.push({ label: ctx.permissionLabel, value: ctx.permissionValue });
  return (
    <div className="dh-composer-context" data-dh-composer-context="" data-dh-provider={provider}>
      {/* The model indicator: a provider mark + clean model name (ModelBadge),
          replacing the old raw "Anthropic · Claude" / raw-id text. Falls back to
          the quiet identity label only when no model is known yet. */}
      <span className="dh-composer-identity" data-dh-composer-identity="">
        {ctx.modelValue ? <ModelBadge model={ctx.modelValue} /> : ctx.identityLabel}
      </span>
      {pairs.map((p) => (
        <span key={p.label} className="dh-composer-ctx-item" data-dh-composer-ctx-item="">
          <span className="dh-composer-ctx-label">{p.label}</span>
          <span className="dh-composer-ctx-value">{p.value}</span>
        </span>
      ))}
    </div>
  );
}

export function Composer({
  provider,
  isNewTask = true,
  draft = "",
  sendState = "send",
  disabledReason = null,
  connection = "connected",
  footer,
  slashCommands = [],
  placeholder,
  onDraftChange,
  onKeyDown,
  onSend,
  onReconnect,
}: ComposerProps): ReactNode {
  const isStop = sendState === "stop";
  // Stop is always actionable (a real interrupt path). Only a real Send can be blocked.
  const sendDisabled = !isStop && disabledReason != null;
  const resolvedPlaceholder = placeholder ?? COMPOSER_COPY.newTaskPlaceholder;
  const disconnected = connection !== "connected";
  const reconnecting = connection === "reconnecting";

  // --- Live slash/mention pickers -------------------------------------------
  // The pickers are only meaningful when a host wires `onDraftChange` (the
  // textarea is controlled, so we can read the live value + caret). In the
  // uncontrolled presentation-only mode there's nothing to derive from, so the
  // whole picker layer stays inert and the render is byte-for-byte as before.
  const live = onDraftChange != null;
  const cwd = footer?.folder ?? null;
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [caret, setCaret] = useState(0);
  const [activeIndex, setActiveIndex] = useState(0);
  // Escape suppresses the picker until the next edit/caret move re-derives it, so
  // it can be dismissed without destroying the typed draft.
  const [suppressed, setSuppressed] = useState(false);
  const [mentionEntries, setMentionEntries] = useState<FileEntry[]>([]);
  const [mentionLoading, setMentionLoading] = useState(false);
  const [mentionError, setMentionError] = useState<string | null>(null);

  const pickerState = useMemo(
    () =>
      live && !suppressed
        ? computePickerState(draft, caret, slashCommands)
        : ({ picker: "none", matches: [], mention: null } as ComposerPickerState),
    [live, suppressed, draft, caret, slashCommands],
  );
  const slashQuery = pickerState.picker === "slash" ? (/^\/(\S*)$/.exec(draft)?.[1] ?? "") : "";
  const mentionQuery = pickerState.mention?.query ?? null;
  const listCount =
    pickerState.picker === "slash"
      ? pickerState.matches.length
      : pickerState.picker === "mention"
        ? mentionEntries.length
        : 0;

  // Fetch fuzzy file matches for the active "@" mention (debounced), backed by the
  // same GET /api/files ChatPane uses. Needs a known cwd (from the footer folder);
  // a failure degrades to an inline hint and never breaks typing.
  useEffect(() => {
    if (mentionQuery == null || !cwd) {
      setMentionEntries([]);
      setMentionError(null);
      return;
    }
    let cancelled = false;
    setMentionLoading(true);
    setMentionError(null);
    const t = window.setTimeout(() => {
      api
        .listFiles(cwd, mentionQuery)
        .then((rows) => {
          if (cancelled) return;
          const entries: FileEntry[] = (rows as unknown[]).map((r) =>
            typeof r === "string" ? { path: r } : (r as FileEntry),
          );
          setMentionEntries(entries);
          setMentionLoading(false);
        })
        .catch(() => {
          if (cancelled) return;
          setMentionEntries([]);
          setMentionError("File search is unavailable here.");
          setMentionLoading(false);
        });
    }, 120);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [mentionQuery, cwd]);

  // Keep the highlighted row valid as the filtered list changes.
  useEffect(() => {
    setActiveIndex((i) => (i >= listCount ? 0 : i));
  }, [listCount]);

  // Read the live caret from the textarea after any caret-moving interaction so
  // mention detection tracks where the user is typing.
  const syncCaret = useCallback(() => {
    const el = textareaRef.current;
    if (el) setCaret(el.selectionStart ?? el.value.length);
  }, []);

  // Move the DOM caret to `pos` after a programmatic insert and refocus, keeping
  // the derived caret state in lockstep.
  const focusCaret = useCallback((pos: number) => {
    setCaret(pos);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (el) {
        el.focus();
        el.selectionStart = el.selectionEnd = pos;
      }
    });
  }, []);

  const pickSlash = useCallback(
    (command: string) => {
      const next = applySlashInsert(command);
      onDraftChange?.(next);
      setActiveIndex(0);
      focusCaret(next.length);
    },
    [onDraftChange, focusCaret],
  );

  const pickMention = useCallback(
    (entry: FileEntry) => {
      const m = pickerState.mention;
      if (!m) return;
      const next = applyMentionInsert(draft, m, entry.path, entry.dir);
      onDraftChange?.(next);
      setActiveIndex(0);
      const inserted = `@${entry.path}${entry.dir ? "/" : " "}`;
      focusCaret(m.start + inserted.length);
    },
    [pickerState.mention, draft, onDraftChange, focusCaret],
  );

  // Compose the composer's own keydown handling with the host's. An open picker
  // OWNS arrows/Enter/Tab/Escape (so focus stays in the textarea) and those keys
  // are NOT forwarded; every other key falls through to the host's `onKeyDown`
  // (Enter-to-send, history recall, …).
  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      // An open picker OWNS arrows/Enter/Tab/Escape the WHOLE time it's open —
      // including while the debounced file search is still loading and `listCount`
      // is 0. Gating these on `listCount > 0` used to let Enter/Tab/Arrows leak to
      // the host mid-search (the mention picker shows "Searching…" the instant
      // detectMention matches, ~120ms before entries arrive), which sent the draft
      // with an incomplete "@partial" mention. Now we prevent-default + swallow the
      // key regardless; the row-move and accept only fire once results are present
      // (inner `listCount > 0` guards, which also avoid a `% 0` NaN). Escape still
      // dismisses so a literal "@text" can be sent deliberately.
      if (pickerState.picker !== "none") {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          if (listCount > 0) setActiveIndex((i) => (i + 1) % listCount);
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          if (listCount > 0) setActiveIndex((i) => (i - 1 + listCount) % listCount);
          return;
        }
        if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
          e.preventDefault();
          if (listCount > 0) {
            if (pickerState.picker === "slash") {
              const pick = pickerState.matches[activeIndex] ?? pickerState.matches[0];
              if (pick) pickSlash(pick);
            } else {
              const pick = mentionEntries[activeIndex] ?? mentionEntries[0];
              if (pick) pickMention(pick);
            }
          }
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setSuppressed(true);
          return;
        }
      }
      onKeyDown?.(e);
    },
    [pickerState, listCount, activeIndex, mentionEntries, pickSlash, pickMention, onKeyDown],
  );

  const pickerNode =
    pickerState.picker === "slash" ? (
      <SlashPalette
        query={slashQuery}
        commands={slashCommands}
        activeIndex={activeIndex}
        onPick={pickSlash}
      />
    ) : pickerState.picker === "mention" ? (
      <MentionPicker
        query={mentionQuery ?? ""}
        entries={mentionEntries}
        activeIndex={activeIndex}
        loading={mentionLoading}
        error={mentionError}
        onPick={pickMention}
      />
    ) : null;

  return (
    // The stable geometry slot. Its data attrs are CONSTANT — they never depend on
    // sendState, draft content, or disabled state — so the container tag is byte-identical
    // across every transition (the slice's stable-composer invariant).
    <div
      className="dh-composer"
      style={{ position: "relative" }}
      data-dh-composer=""
      data-dh-surface=""
      data-dh-composer-width={COMPOSER_GEOMETRY.width}
      data-dh-composer-height={COMPOSER_GEOMETRY.height}
      data-dh-composer-gutter={COMPOSER_GEOMETRY.bottomGutter}
      data-dh-composer-radius={COMPOSER_GEOMETRY.radius}
    >
      {/* Slash/mention picker overlay — floats ABOVE the composer so the measured
          98px slot never grows. Only live (controlled) mode renders it. */}
      {live && pickerNode ? (
        <div className="absolute inset-x-0 bottom-full z-30 mb-2" data-dh-composer-picker="">
          {pickerNode}
        </div>
      ) : null}
      {/* Explicit accessible label element (not placeholder-only). */}
      <label className="dh-sr-only" htmlFor={TEXTAREA_ID}>
        {COMPOSER_COPY.textareaLabel}
      </label>
      {/* The draft is ALWAYS editable — even while disconnected — and is owned by
          `useDraft`, never cleared until a send is accepted. */}
      <textarea
        ref={textareaRef}
        id={TEXTAREA_ID}
        className="dh-composer-input"
        data-dh-composer-input=""
        data-dh-composer-new-task={isNewTask ? "" : undefined}
        placeholder={resolvedPlaceholder}
        // Uncontrolled (defaultValue) when no live host wires onDraftChange — the
        // original presentation-only contract, byte-for-byte. A real host supplies
        // onDraftChange and switches this to a controlled value; typing then also
        // re-derives the picker (and clears an Escape dismissal).
        {...(onDraftChange
          ? {
              value: draft,
              onChange: (e: ChangeEvent<HTMLTextAreaElement>) => {
                onDraftChange(e.target.value);
                setSuppressed(false);
                setCaret(e.target.selectionStart ?? e.target.value.length);
              },
            }
          : { defaultValue: draft })}
        onKeyDown={live ? handleKeyDown : onKeyDown}
        onSelect={live ? syncCaret : undefined}
        onClick={live ? syncCaret : undefined}
        rows={2}
      />

      {disconnected ? (
        // A live connection indicator (F3): a spinner while (re)dialing, a real
        // Reconnect action once the transport has genuinely given up — never
        // just the dead "Reconnect to send" copy with no control behind it.
        <p
          className="dh-composer-notice"
          data-dh-composer-notice=""
          data-dh-connection={connection}
          role="status"
          aria-live="polite"
        >
          <span
            className={reconnecting ? "dh-conn-spinner" : "dh-conn-dot"}
            aria-hidden
          />
          {reconnecting ? DISABLED_REASON.reconnecting : COMPOSER_COPY.reconnectNote}
          {!reconnecting && onReconnect ? (
            <button
              type="button"
              className="dh-composer-reconnect"
              data-dh-composer-reconnect=""
              onClick={onReconnect}
            >
              Reconnect
            </button>
          ) : null}
        </p>
      ) : null}

      <div className="dh-composer-footer" data-dh-composer-footer="">
        <FooterContext provider={provider} footer={footer} />
        <button
          type="button"
          className="dh-composer-send"
          data-dh-composer-send=""
          data-dh-send-state={sendState}
          disabled={sendDisabled}
          aria-describedby={sendDisabled ? SEND_REASON_ID : undefined}
          onClick={onSend}
        >
          {isStop ? COMPOSER_COPY.stopLabel : COMPOSER_COPY.sendLabel}
        </button>
      </div>

      {/* The accessible disabled reason, associated with the send button. */}
      {sendDisabled && disabledReason ? (
        <span id={SEND_REASON_ID} className="dh-sr-only" data-dh-composer-send-reason="">
          {disabledReason}
        </span>
      ) : null}
    </div>
  );
}

export type ComposerSurfaceMode = "devhub" | "legacy";

/**
 * Slice-flag gate. Mirrors `resolveThreadWorkspaceMode`: the new Composer mounts only
 * for a server-resolved true `composerSurface`; anything else (false/undefined/missing)
 * keeps the legacy `ChatPane` composer — the immediate, non-destructive rollback.
 */
export function resolveComposerSurfaceMode(
  settings: { devHubFeatures?: Partial<DevHubFeatureFlags> } | null | undefined,
): ComposerSurfaceMode {
  return settings?.devHubFeatures?.composerSurface === false ? "legacy" : "devhub";
}

/** True only when the composer-surface slice flag is applied. */
export function isComposerSurfaceApplied(
  features: Partial<DevHubFeatureFlags> | undefined,
): boolean {
  return features?.composerSurface === true;
}
