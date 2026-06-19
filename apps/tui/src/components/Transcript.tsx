/**
 * Rich transcript rendering for the terminal face. Replaces the old plain
 * one-line-per-message `flattenMessage` in app.tsx with a proper Ink view that
 * keeps the SAME scroll-window contract: we still flatten a `NormalizedMessage[]`
 * into a flat list of STYLED ROWS so app.tsx can window over them with its
 * existing VISIBLE/scroll math (`rows.slice(scroll, scroll + VISIBLE)`). Each row
 * carries a `kind` tag so `<TranscriptRow>` can color/wrap it correctly:
 *
 *   - role headers      → You (orange) / Claude (cyan) / system (gray), bold
 *   - text blocks       → readable wrapping prose (wrap="end")
 *   - thinking blocks    → a dim "✶ thinking" marker + the (wrapped) thought
 *   - tool_use          → a labeled "⚙ Name" block + compact one-line args
 *   - tool_result        → "↳ ok"/"✗ error", error rows in red
 *   - edit/write diffs   → a colorized +/- diff (green adds, red removes)
 *
 * PURE rendering: it reads only the already-loaded messages + the app's scroll
 * offset, adds NO new dependency, and never touches the engine or disk.
 */
import React from "react";
import { Box, Text } from "ink";
import type { ContentBlock, NormalizedMessage } from "@devhub/engine/types";

/** Edit-shaped tools whose input we render as a colorized diff. */
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
/** Cap the diff we render per tool_use so one huge Write can't flood the window. */
const MAX_DIFF_LINES = 40;
/** Cap a single rendered text/thinking block's characters (whole transcript is windowed anyway). */
const MAX_BLOCK_CHARS = 4000;

/** One rendered row in the flattened transcript, tagged for coloring/wrapping. */
export type Row =
  | { kind: "header"; role: NormalizedMessage["role"]; label: string; meta: string }
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool"; name: string; args: string }
  | { kind: "result"; isError: boolean; text: string }
  | { kind: "diff-file"; path: string }
  | { kind: "diff-add"; text: string }
  | { kind: "diff-del"; text: string }
  | { kind: "diff-ctx"; text: string }
  | { kind: "spacer" };

/** Display label + header color group for a normalized role. */
function roleLabel(role: NormalizedMessage["role"]): string {
  if (role === "assistant") return "Claude";
  if (role === "user") return "You";
  return role; // system / attachment / hook / queue / meta
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

/** Compact, single-line view of a tool_use input (keys=values), whitespace-collapsed. */
function compactArgs(input: unknown): string {
  if (input == null) return "";
  if (typeof input !== "object") return asString(input).replace(/\s+/g, " ").slice(0, 200);
  const o = input as Record<string, unknown>;
  const parts: string[] = [];
  for (const [k, v] of Object.entries(o)) {
    // Skip the bulky edit payloads — those render as a diff below, not as args.
    if (k === "old_string" || k === "new_string" || k === "content" || k === "edits") continue;
    if (k === "old_source" || k === "new_source") continue;
    let val: string;
    if (typeof v === "string") val = v;
    else if (v == null || typeof v === "number" || typeof v === "boolean") val = String(v);
    else val = Array.isArray(v) ? `[${v.length}]` : "{…}";
    parts.push(`${k}=${val.replace(/\s+/g, " ")}`);
  }
  return parts.join("  ").slice(0, 200);
}

/** Edit payload pulled out of an Edit/Write/MultiEdit/NotebookEdit tool input. */
type EditHunk = { oldStr: string; newStr: string };
type EditInput = { filePath?: string; hunks: EditHunk[] };

/**
 * Pull file_path + old/new strings out of an edit-shaped tool input. Mirrors the
 * web face's `parseEditInput` field handling (duck-typed at runtime — no shared
 * import). Returns null when the input doesn't look like a file edit.
 */
function parseEditInput(toolName: string, input: unknown): EditInput | null {
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
      // A Write replaces the whole file: old side empty, every line an addition.
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

/** Split into lines without inventing a trailing empty line ("" → no lines). */
function toLines(s: string): string[] {
  return s === "" ? [] : s.split("\n");
}

/**
 * Emit diff rows for one hunk. Cheap and dependency-free: shared head/tail lines
 * are shown as context, the differing middle is removals then additions. Good
 * enough for the small edits these tools produce; the row list is capped by the
 * caller so a giant Write can't blow past the window budget.
 */
function diffRows(hunk: EditHunk): Row[] {
  const a = toLines(hunk.oldStr);
  const b = toLines(hunk.newStr);
  // Common prefix / suffix so an edit reads as "context · removed · added · context".
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  )
    tail++;

  const rows: Row[] = [];
  for (let i = 0; i < head; i++) rows.push({ kind: "diff-ctx", text: a[i] ?? "" });
  for (let i = head; i < a.length - tail; i++) rows.push({ kind: "diff-del", text: a[i] ?? "" });
  for (let i = head; i < b.length - tail; i++) rows.push({ kind: "diff-add", text: b[i] ?? "" });
  for (let i = 0; i < tail; i++) rows.push({ kind: "diff-ctx", text: a[a.length - tail + i] ?? "" });
  return rows;
}

/** Build the rows for one tool_use block (label + args, plus a diff for edits). */
function toolUseRows(b: Extract<ContentBlock, { type: "tool_use" }>): Row[] {
  const rows: Row[] = [{ kind: "tool", name: b.name, args: compactArgs(b.input) }];
  if (EDIT_TOOLS.has(b.name)) {
    const edit = parseEditInput(b.name, b.input);
    if (edit) {
      if (edit.filePath) rows.push({ kind: "diff-file", path: edit.filePath });
      const diff = edit.hunks.flatMap(diffRows);
      const shown = diff.slice(0, MAX_DIFF_LINES);
      rows.push(...shown);
      if (diff.length > shown.length) {
        rows.push({ kind: "diff-ctx", text: `… ${diff.length - shown.length} more diff lines` });
      }
    }
  }
  return rows;
}

/**
 * Flatten a normalized message into styled rows: a role header followed by one
 * group of rows per content block. Empty/whitespace-only text blocks are dropped
 * so the window isn't padded with blanks.
 */
export function flattenMessage(m: NormalizedMessage): Row[] {
  const rows: Row[] = [];
  const meta = [m.model, m.agentId ? `agent ${m.agentId}` : null].filter(Boolean).join(" · ");
  rows.push({ kind: "header", role: m.role, label: roleLabel(m.role), meta });

  for (const b of m.blocks) {
    if (b.type === "text") {
      const t = b.text.replace(/\s+$/g, "");
      if (t.trim()) rows.push({ kind: "text", text: t.slice(0, MAX_BLOCK_CHARS) });
    } else if (b.type === "thinking") {
      const t = b.text.trim();
      rows.push({ kind: "thinking", text: t.slice(0, MAX_BLOCK_CHARS) || "(empty)" });
    } else if (b.type === "tool_use") {
      rows.push(...toolUseRows(b));
    } else if (b.type === "tool_result") {
      const text = asString(b.content).replace(/\s+/g, " ").trim().slice(0, 300);
      rows.push({ kind: "result", isError: !!b.isError, text: text || (b.isError ? "error" : "ok") });
    } else if (b.type === "image") {
      rows.push({ kind: "result", isError: false, text: `🖼 image${b.mediaType ? ` (${b.mediaType})` : ""}` });
    }
    // "unknown" blocks contribute nothing renderable.
  }
  rows.push({ kind: "spacer" });
  return rows;
}

/** Flatten a whole transcript into the windowable styled-row list app.tsx scrolls. */
export function flattenMessages(messages: NormalizedMessage[]): Row[] {
  return messages.flatMap(flattenMessage);
}

/** Render one styled transcript row. */
export function TranscriptRow({ row }: { row: Row }) {
  switch (row.kind) {
    case "header": {
      const color = row.role === "assistant" ? "cyan" : row.role === "user" ? "#d97757" : "gray";
      return (
        <Text wrap="truncate-end">
          <Text color={color} bold>
            {row.label}
          </Text>
          {row.meta ? <Text color="gray" dimColor>{`  ${row.meta}`}</Text> : null}
        </Text>
      );
    }
    case "text":
      return <Text wrap="end">{row.text}</Text>;
    case "thinking":
      return (
        <Text color="gray" italic wrap="end">
          ✶ {row.text}
        </Text>
      );
    case "tool":
      return (
        <Text wrap="truncate-end">
          <Text color="magenta" bold>
            ⚙ {row.name}
          </Text>
          {row.args ? <Text color="gray">{`  ${row.args}`}</Text> : null}
        </Text>
      );
    case "result":
      return (
        <Text color={row.isError ? "red" : "green"} wrap="truncate-end">
          {row.isError ? "  ✗ " : "  ↳ "}
          {row.text}
        </Text>
      );
    case "diff-file":
      return (
        <Text color="gray" dimColor wrap="truncate-end">
          {"  "}
          {row.path}
        </Text>
      );
    case "diff-add":
      return (
        <Text color="green" wrap="truncate-end">
          {"  + "}
          {row.text}
        </Text>
      );
    case "diff-del":
      return (
        <Text color="red" wrap="truncate-end">
          {"  - "}
          {row.text}
        </Text>
      );
    case "diff-ctx":
      return (
        <Text color="gray" dimColor wrap="truncate-end">
          {"    "}
          {row.text}
        </Text>
      );
    case "spacer":
      return <Text> </Text>;
  }
}

/**
 * Windowed rich transcript. Renders `rows.slice(scroll, scroll + visible)` so it
 * slots straight into app.tsx's existing j/k/space scrolling (which owns `scroll`
 * and the keyboard). The app flattens once with {@link flattenMessages} and keeps
 * the row list in state, then hands a slice here.
 */
export function Transcript({
  rows,
  scroll,
  visible,
}: {
  rows: Row[];
  scroll: number;
  visible: number;
}) {
  const window = rows.slice(scroll, scroll + visible);
  return (
    <Box flexDirection="column">
      {window.map((row, i) => (
        <TranscriptRow key={scroll + i} row={row} />
      ))}
    </Box>
  );
}
