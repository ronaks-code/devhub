import { ShieldQuestion, Check, X } from "lucide-react";

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

function previewInput(input: unknown): string {
  try {
    if (input == null) return "";
    if (typeof input === "string") return input;
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

/**
 * Inline approve/deny card for one pending {t:"permission-request"} frame. The
 * Allow/Deny buttons report the decision via `onDecision`, which the host wires
 * to a {t:"permission-response", id, decision} send on the chat WebSocket.
 *
 * NOTE: the backend only emits permission-request on the persistent (stream-json)
 * session path, which is not the default per-turn driver — so this card is
 * plumbed end-to-end but may stay dormant until that path is enabled. It never
 * fabricates a decision: it only renders what the agent asked and forwards the
 * user's explicit Allow/Deny.
 */
export function PermissionCard({
  request,
  onDecision,
}: {
  request: PendingPermission;
  onDecision: (id: string, decision: "allow" | "deny") => void;
}) {
  const preview = previewInput(request.toolInput);
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

      {preview ? (
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words border-b border-amber-700/20 px-3 py-2 font-mono text-[11.5px] leading-relaxed text-zinc-300">
          {preview.length > 2000 ? `${preview.slice(0, 2000)}\n…` : preview}
        </pre>
      ) : null}

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

      <div className="flex items-center justify-end gap-2 px-3 py-2">
        <button
          onClick={() => onDecision(request.id, "deny")}
          className="inline-flex items-center gap-1.5 rounded-lg bg-zinc-800 px-3 py-1 text-[12px] font-medium text-zinc-300 ring-1 ring-zinc-700 transition hover:bg-zinc-700 hover:text-zinc-100"
        >
          <X className="h-3.5 w-3.5" />
          Deny
        </button>
        <button
          onClick={() => onDecision(request.id, "allow")}
          className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1 text-[12px] font-medium text-white transition hover:bg-emerald-500"
        >
          <Check className="h-3.5 w-3.5" />
          Allow
        </button>
      </div>
    </div>
  );
}
