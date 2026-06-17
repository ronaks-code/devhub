import { useMemo, useState } from "react";
import { Braces, Check, FileDiff, Pencil, RotateCcw, Terminal } from "lucide-react";
import { DiffView, parseEditInput } from "./DiffView";
import { cn } from "../lib/utils";

/** The Edit-family tools whose primary content we let the user revise. */
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/**
 * Which single field of a tool input is the load-bearing, human-editable value,
 * and how to splice an edited value back into a fresh input object. We only ever
 * surface ONE field for editing (the command / the content) so the affordance
 * stays legible; everything else falls back to editing the raw JSON.
 */
interface EditableField {
  /** Label shown above the editor. */
  label: string;
  /** The icon for the field's kind (terminal / file / braces). */
  icon: "bash" | "edit" | "json";
  /** Monospace single value the user edits (the command, the written content…). */
  value: string;
  /** Optional path/context shown beside the label (e.g. the file being written). */
  context?: string;
  /** Reconstruct a full tool input with the edited value spliced in. */
  apply: (next: string) => unknown;
}

function asRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" ? (input as Record<string, unknown>) : {};
}

/**
 * Decide what field of a tool input to expose for editing. Returns null when the
 * input has no single obvious editable value — the caller then offers raw-JSON
 * editing instead.
 *
 *  - Bash               → the `command` string.
 *  - Write              → the whole-file `content`.
 *  - Edit               → the `new_string` (what the old text becomes).
 *  - NotebookEdit       → the `new_source` (the replacement cell source).
 *  - MultiEdit / other  → null (too many parts to splice safely from one box;
 *                          fall back to raw JSON so the edit is still possible).
 */
function detectEditableField(toolName: string, input: unknown): EditableField | null {
  const o = asRecord(input);

  if (toolName === "Bash" && typeof o.command === "string") {
    return {
      label: "Command",
      icon: "bash",
      value: o.command,
      apply: (next) => ({ ...o, command: next }),
    };
  }

  if (toolName === "Write" && typeof o.content === "string") {
    return {
      label: "File contents",
      icon: "edit",
      value: o.content,
      context: typeof o.file_path === "string" ? o.file_path : undefined,
      apply: (next) => ({ ...o, content: next }),
    };
  }

  if (toolName === "Edit" && typeof o.new_string === "string") {
    return {
      label: "Replacement text (new_string)",
      icon: "edit",
      value: o.new_string,
      context: typeof o.file_path === "string" ? o.file_path : undefined,
      apply: (next) => ({ ...o, new_string: next }),
    };
  }

  if (toolName === "NotebookEdit" && typeof o.new_source === "string") {
    return {
      label: "Replacement cell source (new_source)",
      icon: "edit",
      value: o.new_source,
      apply: (next) => ({ ...o, new_source: next }),
    };
  }

  return null;
}

/** Pretty-print arbitrary input for the raw-JSON editor / fallback. */
function prettyJson(input: unknown): string {
  try {
    if (input == null) return "";
    if (typeof input === "string") return input;
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

const FieldIcon = ({ kind }: { kind: EditableField["icon"] }) => {
  const cls = "h-3.5 w-3.5 shrink-0 text-amber-300";
  if (kind === "bash") return <Terminal className={cls} />;
  if (kind === "edit") return <FileDiff className={cls} />;
  return <Braces className={cls} />;
};

/**
 * Lets the user EDIT a pending tool call's input before approving it. Surfaces
 * the single load-bearing value (the Bash command / the written content) in a
 * monospace textarea; for inputs without one obvious field it offers raw-JSON
 * editing. The (possibly edited) value is reported up via `onChange` as a full
 * `updatedInput` object so PermissionCard can ride it along in the
 * permission-response — exactly what the persistent path needs to run the
 * REVISED call instead of the original.
 *
 * Edit-aware but never destructive: it starts from the original input, so an
 * untouched approval forwards the original `updatedInput` unchanged (semantically
 * a no-op). Purely a controlled editor — it decides nothing.
 */
export function EditableApproval({
  toolName,
  toolInput,
  onChange,
}: {
  toolName: string;
  toolInput: unknown;
  /**
   * Reports the current edited input (a full tool-input object), or null when
   * the user hasn't diverged from the original (so the caller can omit
   * `updatedInput` entirely and forward a plain allow).
   */
  onChange: (updatedInput: unknown | null) => void;
}) {
  const field = useMemo(() => detectEditableField(toolName, toolInput), [toolName, toolInput]);
  // The original value the editor starts from + resets to. For a field-edit it's
  // that field's string; for the raw-JSON fallback it's the pretty-printed input.
  const original = useMemo(
    () => (field ? field.value : prettyJson(toolInput)),
    [field, toolInput],
  );
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(original);

  // True once the textarea diverges from the original — drives the "edited" pill
  // and decides whether we report an updatedInput or null (a no-op approval).
  const dirty = value !== original;

  // For the Edit/Write family, preview the edited replacement as a red/green diff
  // so the user sees exactly what they're about to approve, live as they type.
  const editPreview = useMemo(() => {
    if (!field || field.icon !== "edit") return null;
    const previewInput = field.apply(value);
    return parseEditInput(toolName, previewInput);
  }, [field, value, toolName]);

  const commit = (next: string) => {
    setValue(next);
    if (!field) {
      // Raw-JSON editor: parse on change; only report a valid object, else null
      // (the caller keeps the original input). We never forward malformed JSON.
      if (next === original) {
        onChange(null);
        return;
      }
      try {
        onChange(JSON.parse(next));
      } catch {
        onChange(null); // invalid JSON mid-edit → don't propagate a broken input
      }
      return;
    }
    onChange(next === field.value ? null : field.apply(next));
  };

  const reset = () => {
    setValue(original);
    onChange(null);
  };

  // The raw-JSON fallback only previews when the current text is valid JSON.
  const jsonValid = useMemo(() => {
    if (field) return true;
    if (!editing) return true;
    try {
      JSON.parse(value);
      return true;
    } catch {
      return false;
    }
  }, [field, editing, value]);

  return (
    <div className="border-b border-amber-700/20">
      <div className="flex items-center gap-2 px-3 py-1.5 text-[11px] text-amber-200/80">
        <FieldIcon kind={field?.icon ?? "json"} />
        <span className="font-medium">{field ? field.label : `${toolName} input`}</span>
        {field?.context ? (
          <span className="truncate font-mono text-amber-200/60" title={field.context}>
            {field.context}
          </span>
        ) : null}
        {dirty ? (
          <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-200">
            edited
          </span>
        ) : null}
        {editing ? (
          <button
            onClick={reset}
            disabled={!dirty}
            className="ml-auto inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10.5px] font-medium text-zinc-400 transition hover:bg-zinc-800 hover:text-zinc-200 disabled:opacity-40"
            title="Revert to the original input"
          >
            <RotateCcw className="h-3 w-3" />
            Reset
          </button>
        ) : (
          <button
            onClick={() => setEditing(true)}
            className="ml-auto inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10.5px] font-medium text-amber-200/80 transition hover:bg-amber-500/15 hover:text-amber-100"
            title="Edit this input before approving"
          >
            <Pencil className="h-3 w-3" />
            Edit
          </button>
        )}
      </div>

      {editing ? (
        <div className="px-3 pb-2">
          <textarea
            value={value}
            onChange={(e) => commit(e.target.value)}
            spellCheck={false}
            rows={Math.min(16, Math.max(3, value.split("\n").length))}
            className={cn(
              "w-full resize-y rounded-lg bg-zinc-950/80 px-2.5 py-2 font-mono text-[12px] leading-relaxed text-zinc-100 ring-1 focus:outline-none",
              jsonValid
                ? "ring-amber-700/40 focus:ring-amber-500/50"
                : "ring-red-700/60 focus:ring-red-500/60",
            )}
          />
          {!field && !jsonValid ? (
            <div className="mt-1 text-[10.5px] text-red-400">
              Not valid JSON — fix it to approve the edited input (or Reset).
            </div>
          ) : null}
          {/* Live diff preview for Edit/Write replacements, so the user reviews
              the precise change their edits would approve. */}
          {editPreview ? (
            <div className="mt-2 max-h-48 overflow-auto rounded-lg bg-zinc-950/60 p-2 ring-1 ring-amber-700/20">
              <DiffView edit={editPreview} />
            </div>
          ) : null}
        </div>
      ) : (
        // Collapsed view: the value as it stands (original or edited), read-only.
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words px-3 pb-2 font-mono text-[12px] leading-relaxed text-zinc-200">
          {value.length > 4000 ? `${value.slice(0, 4000)}\n…` : value || "(empty)"}
        </pre>
      )}

      {dirty ? (
        <div className="flex items-center gap-1.5 px-3 pb-2 text-[10.5px] text-amber-300/80">
          <Check className="h-3 w-3" />
          Allow will run your edited input.
        </div>
      ) : null}
    </div>
  );
}
