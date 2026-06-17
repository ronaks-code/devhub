import { useEffect, useRef, useState } from "react";
import { MessageSquareX, X } from "lucide-react";

/**
 * Optional feedback box shown when a user is about to DENY a permission request.
 * Lets them tell the agent *why* (e.g. "use the staging DB, not prod") — the note
 * rides along in the permission-response as `message`, so a server on the
 * persistent path can hand it back to the model instead of a bare refusal.
 *
 * Plain words: instead of just saying "no", you can leave a sticky note. The note
 * is optional — Deny without typing anything still works exactly as before.
 *
 * Purely a controlled input + confirm/cancel: it never decides anything itself.
 * PermissionCard owns the actual deny dispatch and passes the typed message up.
 */
export function DenyFeedback({
  onConfirm,
  onCancel,
}: {
  /** Deny with the (trimmed) feedback message, or undefined when left blank. */
  onConfirm: (message?: string) => void;
  /** Dismiss the feedback box without denying (back to the buttons). */
  onCancel: () => void;
}) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);

  // Focus the note on open so a user can immediately type or just hit Enter.
  useEffect(() => {
    ref.current?.focus();
  }, []);

  const confirm = () => {
    const trimmed = text.trim();
    onConfirm(trimmed ? trimmed : undefined);
  };

  return (
    <div className="border-t border-amber-700/30 px-3 py-2.5">
      <div className="mb-1.5 flex items-center gap-1.5 text-[11.5px] font-medium text-amber-200/80">
        <MessageSquareX className="h-3.5 w-3.5 shrink-0 text-amber-300" />
        Deny with feedback (optional)
      </div>
      <textarea
        ref={ref}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          // Cmd/Ctrl+Enter confirms; Escape cancels — keeps hands on keyboard.
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            confirm();
          } else if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
        rows={2}
        placeholder="Tell the agent why, or what to do instead… (leave blank for a plain deny)"
        spellCheck={false}
        className="w-full resize-y rounded-lg bg-zinc-900 px-2.5 py-1.5 text-[12.5px] leading-relaxed text-zinc-200 ring-1 ring-zinc-700 placeholder:text-zinc-600 focus:outline-none focus:ring-amber-500/40"
      />
      <div className="mt-2 flex items-center gap-2">
        <button
          onClick={confirm}
          className="inline-flex items-center gap-1.5 rounded-lg bg-red-600/90 px-3 py-1 text-[12px] font-medium text-white transition hover:bg-red-600"
        >
          <X className="h-3.5 w-3.5" />
          Deny
        </button>
        <button
          onClick={onCancel}
          className="rounded-lg px-2.5 py-1 text-[12px] font-medium text-zinc-400 transition hover:bg-zinc-800 hover:text-zinc-200"
        >
          Cancel
        </button>
        <span className="ml-auto text-[10.5px] text-zinc-600">⌘↵ to deny · esc to cancel</span>
      </div>
    </div>
  );
}
