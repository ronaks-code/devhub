import { FileDiff, Terminal, Braces } from "lucide-react";
import { DiffView, parseEditInput } from "./DiffView";

/** The Edit-family tools whose input we can render as a red/green diff. */
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/** Pull a Bash command string out of a tool input, if present. */
function bashCommand(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const cmd = (input as Record<string, unknown>).command;
  return typeof cmd === "string" ? cmd : null;
}

/** Pretty-print arbitrary tool input (objects as indented JSON, strings as-is). */
function prettyInput(input: unknown): string {
  try {
    if (input == null) return "";
    if (typeof input === "string") return input;
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

/**
 * Renders the ACTUAL input of a pending tool call inside the PermissionCard so a
 * user can see exactly what they're approving — not a wall of raw JSON:
 *
 *  - Edit/Write/MultiEdit/NotebookEdit → a red/green diff (reuses DiffView), with
 *    the file path as a header, so the user reviews the proposed change directly.
 *  - Bash → the command line that will run (the part that matters for a verdict).
 *  - anything else → pretty-printed input (indented JSON / the raw string),
 *    which is also the fallback when an edit/bash input can't be parsed.
 *
 * Purely presentational: it never decides anything, it just makes the request
 * legible. The amber chrome lives in PermissionCard; this fills the body.
 */
export function PermissionCardBody({
  toolName,
  toolInput,
}: {
  toolName: string;
  toolInput: unknown;
}) {
  // 1) File edits → diff. parseEditInput returns null when the input doesn't
  //    look like a file edit, in which case we fall through to the pretty view.
  if (EDIT_TOOLS.has(toolName)) {
    const edit = parseEditInput(toolName, toolInput);
    if (edit) {
      return (
        <div className="border-b border-amber-700/20">
          <div className="flex items-center gap-2 px-3 py-1.5 text-[11px] text-amber-200/80">
            <FileDiff className="h-3.5 w-3.5 shrink-0 text-amber-300" />
            <span className="font-medium">{toolName}</span>
            {edit.filePath ? (
              <span className="truncate font-mono text-amber-200/60" title={edit.filePath}>
                {edit.filePath}
              </span>
            ) : null}
          </div>
          <div className="max-h-64 overflow-auto px-3 pb-2">
            <DiffView edit={edit} />
          </div>
        </div>
      );
    }
  }

  // 2) Bash → just the command line.
  const cmd = toolName === "Bash" ? bashCommand(toolInput) : null;
  if (cmd != null) {
    return (
      <div className="border-b border-amber-700/20">
        <div className="flex items-center gap-2 px-3 py-1.5 text-[11px] text-amber-200/80">
          <Terminal className="h-3.5 w-3.5 shrink-0 text-amber-300" />
          <span className="font-medium">Bash</span>
        </div>
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words px-3 pb-2 font-mono text-[12px] leading-relaxed text-zinc-200">
          {cmd}
        </pre>
      </div>
    );
  }

  // 3) Everything else → pretty input. Also the fallback for unparseable
  //    edit/bash inputs. Empty input renders nothing (no empty box).
  const pretty = prettyInput(toolInput);
  if (!pretty) return null;
  return (
    <div className="border-b border-amber-700/20">
      <div className="flex items-center gap-2 px-3 py-1.5 text-[11px] text-amber-200/80">
        <Braces className="h-3.5 w-3.5 shrink-0 text-amber-300" />
        <span className="font-medium">{toolName}</span>
      </div>
      <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words px-3 pb-2 font-mono text-[11.5px] leading-relaxed text-zinc-300">
        {pretty.length > 4000 ? `${pretty.slice(0, 4000)}\n…` : pretty}
      </pre>
    </div>
  );
}
