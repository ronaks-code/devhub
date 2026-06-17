import { ShieldQuestion, Check, X } from "lucide-react";
import { cn } from "../lib/utils";
import { PermissionCardBody } from "./PermissionCardBody";

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
}: {
  request: PendingPermission;
  onDecision: (id: string, decision: PermissionDecision) => void;
}) {
  return (
    <div className="mx-4 my-2 overflow-hidden rounded-xl border border-amber-700/50 bg-amber-500/5">
      <div className="flex items-center gap-2 border-b border-amber-700/30 px-3 py-2">
        <ShieldQuestion className="h-4 w-4 shrink-0 text-amber-400" />
        <span className="text-[12.5px] font-medium text-amber-200">
          Permission requested
        </span>
        <code className="ml-auto rounded bg-amber-500/10 px-1.5 py-0.5 font-mono text-[11px] text-amber-200">
          {request.toolName}
        </code>
      </div>

      {/* The actual tool input, rendered meaningfully (diff / command / pretty
          JSON) so the user reviews exactly what they're approving. */}
      <PermissionCardBody toolName={request.toolName} toolInput={request.toolInput} />

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

      <div className="flex flex-wrap items-center gap-2 px-3 py-2">
        <button
          onClick={() => onDecision(request.id, { decision: "deny", scope: "once" })}
          className="inline-flex items-center gap-1.5 rounded-lg bg-zinc-800 px-3 py-1 text-[12px] font-medium text-zinc-300 ring-1 ring-zinc-700 transition hover:bg-zinc-700 hover:text-zinc-100"
        >
          <X className="h-3.5 w-3.5" />
          Deny
        </button>

        <div className="ml-auto flex items-center gap-1.5">
          <span className="mr-0.5 text-[11px] text-amber-200/70">Allow:</span>
          {ALLOW_SCOPES.map(({ scope, label, title }, i) => (
            <button
              key={scope}
              title={title}
              onClick={() => onDecision(request.id, { decision: "allow", scope })}
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
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
