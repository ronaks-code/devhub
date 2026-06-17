import { memo } from "react";

/** One contiguous group of lines sharing a sign. */
type DiffLine = { sign: " " | "-" | "+"; text: string };

/** Parsed file-edit shape for the tools we special-case. */
export interface EditInput {
  filePath?: string;
  /** Each hunk = one old→new replacement (Edit/MultiEdit) or a whole-file write. */
  hunks: Array<{ oldStr: string; newStr: string }>;
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

/**
 * Pull file_path + old/new strings out of an Edit/Write/MultiEdit/NotebookEdit
 * tool input. Returns null when the input doesn't look like a file edit.
 */
export function parseEditInput(toolName: string, input: unknown): EditInput | null {
  if (!input || typeof input !== "object") return null;
  const o = input as Record<string, unknown>;
  const filePath = asString(o.file_path ?? o.filePath ?? o.notebook_path ?? o.notebookPath) || undefined;

  switch (toolName) {
    case "Edit": {
      if (typeof o.old_string !== "string" && typeof o.new_string !== "string") return null;
      return { filePath, hunks: [{ oldStr: asString(o.old_string), newStr: asString(o.new_string) }] };
    }
    case "Write": {
      if (typeof o.content !== "string") return null;
      // A Write replaces the whole file: render every line as an addition.
      return { filePath, hunks: [{ oldStr: "", newStr: asString(o.content) }] };
    }
    case "MultiEdit": {
      const edits = Array.isArray(o.edits) ? o.edits : null;
      if (!edits) return null;
      const hunks = edits
        .filter((e): e is Record<string, unknown> => !!e && typeof e === "object")
        .map((e) => ({ oldStr: asString(e.old_string), newStr: asString(e.new_string) }));
      if (hunks.length === 0) return null;
      return { filePath, hunks };
    }
    case "NotebookEdit": {
      // Cell edits: new_source replaces old. Treat as a single hunk.
      if (typeof o.new_source !== "string" && typeof o.new_string !== "string") return null;
      return {
        filePath,
        hunks: [{ oldStr: asString(o.old_source ?? o.old_string), newStr: asString(o.new_source ?? o.new_string) }],
      };
    }
    default:
      return null;
  }
}

/** Build a simple unified line list for one old→new replacement. */
function diffHunk(oldStr: string, newStr: string): DiffLine[] {
  const lines: DiffLine[] = [];
  const removed = oldStr === "" ? [] : oldStr.split("\n");
  const added = newStr === "" ? [] : newStr.split("\n");
  for (const t of removed) lines.push({ sign: "-", text: t });
  for (const t of added) lines.push({ sign: "+", text: t });
  return lines;
}

function LineRow({ line }: { line: DiffLine }) {
  const bg =
    line.sign === "+"
      ? "bg-emerald-500/10 text-emerald-200"
      : line.sign === "-"
        ? "bg-red-500/10 text-red-200"
        : "text-zinc-400";
  const marker =
    line.sign === "+" ? "text-emerald-500" : line.sign === "-" ? "text-red-500" : "text-zinc-700";
  return (
    <div className={`flex ${bg}`}>
      <span className={`w-4 shrink-0 select-none text-center ${marker}`}>{line.sign}</span>
      <span className="whitespace-pre-wrap break-words pr-3">{line.text || " "}</span>
    </div>
  );
}

/** Red/green unified diff for a parsed file edit. */
export const DiffView = memo(function DiffView({ edit }: { edit: EditInput }) {
  return (
    <div className="font-mono text-[12px] leading-relaxed">
      {edit.hunks.map((h, i) => (
        <div key={i} className={i > 0 ? "mt-2 border-t border-zinc-800 pt-2" : ""}>
          {diffHunk(h.oldStr, h.newStr).map((line, j) => (
            <LineRow key={j} line={line} />
          ))}
        </div>
      ))}
    </div>
  );
});
