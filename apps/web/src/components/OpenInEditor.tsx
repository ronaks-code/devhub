import { createContext, useContext, useState } from "react";
import { Check, ExternalLink, FileCode, Loader2 } from "lucide-react";
import { api } from "../lib/api";
import { NotImplementedError } from "../lib/api";
import { cn } from "../lib/utils";

/**
 * The active project's working directory, threaded down to deeply-nested file
 * affordances (tool cards, diffs, file lists) so an "open in editor" button can
 * POST { cwd, file } without prop-drilling through every renderer.
 *
 * Mirrors the SubagentContext pattern in TaskCard: the host (ChatPane /
 * TranscriptPane) wraps its message list in {@link CwdProvider value={cwd}}; a
 * pane without a known cwd leaves the default (null), and {@link OpenInEditor}
 * simply renders nothing — so historical/cwd-less contexts are unaffected.
 */
const CwdContext = createContext<string | null>(null);
export const CwdProvider = CwdContext.Provider;

/** Read the ambient project cwd, if any. Null when no provider is mounted. */
export function useCwd(): string | null {
  return useContext(CwdContext);
}

/**
 * A small "open in editor" button shown next to an on-disk file path. Calls
 * POST /api/open { cwd, target: "editor", file } so the server opens the file in
 * the user's configured editor.
 *
 * Plain words: click it and the file you're looking at (a diff, a Read card, a
 * changed-files row) pops open in your editor on the machine running the server.
 *
 * The button needs the project cwd to allowlist the open server-side. It reads
 * an explicit `cwd` prop first, then falls back to the ambient {@link CwdContext}.
 * With neither available it renders nothing (there's nothing safe to open). If
 * the server hasn't shipped POST /api/open yet, the call surfaces a
 * {@link NotImplementedError}; we degrade to a quiet "unavailable" title rather
 * than throwing, so the transcript never breaks.
 */
export function OpenInEditor({
  file,
  cwd: cwdProp,
  className,
  label = false,
}: {
  /** Absolute (or cwd-relative) path of the file to open. */
  file: string;
  /** Project cwd for the open; falls back to the ambient CwdContext when omitted. */
  cwd?: string | null;
  className?: string;
  /** Show the "Open" text label beside the icon (default: icon only). */
  label?: boolean;
}) {
  const ambient = useCwd();
  const cwd = cwdProp ?? ambient;
  const [state, setState] = useState<"idle" | "opening" | "done" | "unavailable" | "error">("idle");

  // Without a cwd there's nothing to allowlist against — skip the affordance.
  if (!cwd || !file) return null;

  const open = () => {
    setState("opening");
    api
      .open(cwd, file)
      .then(() => {
        setState("done");
        window.setTimeout(() => setState("idle"), 1500);
      })
      .catch((e) => {
        // A server without the route → quiet "unavailable"; anything else → "error".
        setState(e instanceof NotImplementedError ? "unavailable" : "error");
        window.setTimeout(() => setState("idle"), 2500);
      });
  };

  const title =
    state === "unavailable"
      ? "Opening files isn't available on this server"
      : state === "error"
        ? "Couldn't open the file"
        : `Open ${file} in your editor`;

  return (
    <button
      type="button"
      onClick={(e) => {
        // Stop the click from toggling the surrounding <details>/row it sits in.
        e.preventDefault();
        e.stopPropagation();
        if (state === "idle") open();
      }}
      title={title}
      aria-label={title}
      disabled={state === "opening"}
      className={cn(
        "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium transition disabled:opacity-50",
        state === "done"
          ? "text-emerald-400"
          : state === "unavailable" || state === "error"
            ? "text-zinc-600"
            : "text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200",
        className,
      )}
    >
      {state === "opening" ? (
        <Loader2 className="h-3 w-3 animate-spin" />
      ) : state === "done" ? (
        <Check className="h-3 w-3" />
      ) : state === "unavailable" || state === "error" ? (
        <ExternalLink className="h-3 w-3" />
      ) : (
        <FileCode className="h-3 w-3" />
      )}
      {label ? (
        <span>
          {state === "done"
            ? "Opened"
            : state === "unavailable"
              ? "Unavailable"
              : state === "error"
                ? "Failed"
                : "Open"}
        </span>
      ) : null}
    </button>
  );
}
