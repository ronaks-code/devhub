import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, ShieldQuestion, Check, X } from "lucide-react";
import { cn } from "../lib/utils";
import { EditableApproval } from "./EditableApproval";
import { DenyFeedback } from "./DenyFeedback";

/**
 * A pending tool-permission request, mirroring the {t:"permission-request"}
 * server frame (id + toolName + toolInput + optional suggestions). Kept local so
 * the component doesn't depend on the engine's Node-side types directly.
 */
export interface PendingPermission {
  id: string;
  toolName: string;
  toolInput: unknown;
  suggestions?: string[];
}

/**
 * How long an approval applies. Sent alongside allow/deny so the persistent path
 * can remember a decision instead of re-asking:
 *  - "once"    → this single tool call only.
 *  - "session" → for the rest of this live session.
 *  - "always"  → persist (future: write to settings/permission rules).
 * Deny is always implicitly "once" — we never persist a denial.
 */
export type PermissionScope = "once" | "session" | "always";

/** The decision a user makes on a request: a verdict plus (for allow) a scope. */
export interface PermissionDecision {
  decision: "allow" | "deny";
  scope: PermissionScope;
  /**
   * Optional free-text feedback that rides along on a DENY, sent as `message` in
   * the permission-response so a server on the persistent path can hand the
   * reason back to the model instead of a bare refusal. Absent for allow / a
   * plain deny.
   */
  message?: string;
  /**
   * Optional EDITED tool input the user revised before approving (via
   * EditableApproval). Rides along on an ALLOW as `updatedInput` in the
   * permission-response, so the persistent path runs the REVISED call instead of
   * the original. Absent when the user approved the input unchanged (the server
   * then uses the request's original input). Never present on a deny.
   */
  updatedInput?: unknown;
}

/** Allow buttons, one per scope — the label doubles as the affordance. */
const ALLOW_SCOPES: Array<{ scope: PermissionScope; label: string; title: string }> = [
  { scope: "once", label: "Once", title: "Allow this one call" },
  { scope: "session", label: "This session", title: "Allow for the rest of this session" },
  { scope: "always", label: "Always", title: "Always allow this tool (persisted)" },
];

/**
 * Inline approve/deny card for one pending {t:"permission-request"} frame. Allow
 * is offered at three scopes (Once / This session / Always); the chosen scope is
 * reported via `onDecision` so the host can forward it in the permission-response.
 *
 * NOTE: the backend only emits permission-request on the persistent (stream-json)
 * session path, which is not the default per-turn driver — so this card (and the
 * scope payload) is plumbed end-to-end but stays dormant until that path is
 * enabled. It never fabricates a decision: it only renders what the agent asked
 * and forwards the user's explicit choice.
 */
export function PermissionCard({
  request,
  onDecision,
  queueCount = 1,
  queuePosition = 0,
  onNext,
  onPrev,
  editFocusToken,
}: {
  request: PendingPermission;
  onDecision: (id: string, decision: PermissionDecision) => void;
  /** Total pending requests (for the "1 of N" header). 1 = no queue chrome. */
  queueCount?: number;
  /** 0-based index of THIS request in the queue. */
  queuePosition?: number;
  /** Step to the next / previous queued request (shown only when queueCount > 1). */
  onNext?: () => void;
  onPrev?: () => void;
  /**
   * Bump this number to scroll the card into view and focus its editable input
   * (driven by the "E" approval-keyboard binding). Undefined = no focus request.
   */
  editFocusToken?: number;
}) {
  // When true, the Deny button has opened the optional feedback box (the buttons
  // row hides while it's up). Reset implicitly when the card unmounts on decide.
  const [denying, setDenying] = useState(false);
  // The user's EDITED tool input (from EditableApproval), or null when unchanged
  // from the request's original. Rides along on an allow as `updatedInput`.
  const [editedInput, setEditedInput] = useState<unknown | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  // React to an "E" (edit) keypress: scroll the card into view and focus the
  // first editable control inside it (the EditableApproval textarea/input).
  useEffect(() => {
    if (editFocusToken == null) return;
    const el = cardRef.current;
    if (!el) return;
    el.scrollIntoView({ block: "nearest" });
    const field = el.querySelector<HTMLElement>("textarea, input");
    field?.focus();
  }, [editFocusToken]);

  const hasQueue = queueCount > 1;

  return (
    <div ref={cardRef} className="mx-4 my-2 overflow-hidden rounded-xl border border-amber-700/50 bg-amber-500/5">
      <div className="flex items-center gap-2 border-b border-amber-700/30 px-3 py-2">
        <ShieldQuestion className="h-4 w-4 shrink-0 text-amber-400" />
        <span className="text-[12.5px] font-medium text-amber-200">
          Permission requested
        </span>
        {hasQueue ? (
          <span className="flex items-center gap-1 text-[11px] text-amber-200/70">
            <button
              onClick={onPrev}
              className="rounded p-0.5 transition hover:bg-amber-500/15 hover:text-amber-100"
              title="Previous request (K)"
              aria-label="Previous request"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </button>
            <span className="tabular-nums">
              {queuePosition + 1} of {queueCount}
            </span>
            <button
              onClick={onNext}
              className="rounded p-0.5 transition hover:bg-amber-500/15 hover:text-amber-100"
              title="Next request (J)"
              aria-label="Next request"
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </span>
        ) : null}
        <code className="ml-auto rounded bg-amber-500/10 px-1.5 py-0.5 font-mono text-[11px] text-amber-200">
          {request.toolName}
        </code>
      </div>

      {/* The actual tool input, rendered meaningfully AND editable: the user can
          revise the command / contents before approving. The edited value (when
          changed) rides along on Allow as `updatedInput`. */}
      <EditableApproval
        toolName={request.toolName}
        toolInput={request.toolInput}
        onChange={setEditedInput}
      />

      {request.suggestions && request.suggestions.length > 0 ? (
        <ul className="space-y-0.5 border-b border-amber-700/20 px-3 py-2 text-[11.5px] text-zinc-400">
          {request.suggestions.map((s, i) => (
            <li key={i} className="flex gap-1.5">
              <span className="text-amber-500/70">•</span>
              <span className="min-w-0 break-words">{s}</span>
            </li>
          ))}
        </ul>
      ) : null}

      {/* Deny opens an optional feedback box (DenyFeedback); confirming there
          dispatches the deny with the typed message. Allow buttons decide
          immediately. */}
      {denying ? (
        <DenyFeedback
          onConfirm={(message) =>
            onDecision(request.id, { decision: "deny", scope: "once", message })
          }
          onCancel={() => setDenying(false)}
        />
      ) : (
        <div className="flex flex-wrap items-center gap-2 px-3 py-2">
          <button
            onClick={() => setDenying(true)}
            className="inline-flex items-center gap-1.5 rounded-lg bg-zinc-800 px-3 py-1 text-[12px] font-medium text-zinc-300 ring-1 ring-zinc-700 transition hover:bg-zinc-700 hover:text-zinc-100"
            title="Deny (D)"
          >
            <X className="h-3.5 w-3.5" />
            Deny
            <ApprovalKbd>D</ApprovalKbd>
          </button>

          <div className="ml-auto flex items-center gap-1.5">
            <span className="mr-0.5 text-[11px] text-amber-200/70">Allow:</span>
            {ALLOW_SCOPES.map(({ scope, label, title }, i) => (
              <button
                key={scope}
                title={`${title}${scope === "once" ? " (A)" : scope === "session" ? " (S)" : ""}`}
                onClick={() =>
                  onDecision(request.id, {
                    decision: "allow",
                    scope,
                    // Only attach the edited input when the user actually changed it
                    // (null = approved unchanged → server uses the original input).
                    ...(editedInput != null ? { updatedInput: editedInput } : {}),
                  })
                }
                className={cn(
                  "inline-flex items-center gap-1.5 px-3 py-1 text-[12px] font-medium text-white transition",
                  // The primary "Once" is solid; the broader scopes are tinted so
                  // the safest choice reads as the default.
                  i === 0
                    ? "rounded-lg bg-emerald-600 hover:bg-emerald-500"
                    : "rounded-lg bg-emerald-600/15 text-emerald-200 ring-1 ring-emerald-600/40 hover:bg-emerald-600/25",
                )}
              >
                {i === 0 ? <Check className="h-3.5 w-3.5" /> : null}
                {label}
                {scope === "once" ? <ApprovalKbd>A</ApprovalKbd> : null}
                {scope === "session" ? <ApprovalKbd>S</ApprovalKbd> : null}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** A small inline keyboard-hint chip shown on the approval buttons. */
function ApprovalKbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="rounded bg-black/20 px-1 py-0.5 text-[9px] font-semibold leading-none opacity-80 ring-1 ring-white/10">
      {children}
    </kbd>
  );
}
