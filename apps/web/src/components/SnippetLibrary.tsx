import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  FileText,
  Pencil,
  Plus,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { cn } from "../lib/utils";
import { readCompat, writeCompat } from "../lib/compat-storage";

/**
 * A reusable prompt template the user saves to insert later. `body` may contain
 * `{placeholders}` (any `{name}` token) the user fills in before inserting, e.g.
 * "Refactor {file} to use {pattern}". Stored entirely in localStorage — no server
 * round-trip — so it works the same offline and never touches the engine.
 */
export interface Snippet {
  id: string;
  title: string;
  body: string;
  /** epoch ms of last edit, for "most-recently-used-ish" ordering. */
  updatedAt: number;
}

const STORAGE_KEY = "devhub:snippets";

/** A few starter templates so the library isn't empty on first open. */
const SEED: Omit<Snippet, "id" | "updatedAt">[] = [
  {
    title: "Explain this code",
    body: "Explain what {file} does, step by step, like I'm new to this codebase.",
  },
  {
    title: "Write tests",
    body: "Write thorough unit tests for {file}. Cover edge cases and error paths.",
  },
  {
    title: "Fix the bug",
    body: "There's a bug: {symptom}. Find the root cause and fix it. Don't add temporary workarounds.",
  },
];

function makeId(): string {
  return `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Read snippets from localStorage; SSR- and corruption-safe (returns []). */
function readSnippets(): Snippet[] {
  try {
    const raw = readCompat(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (s): s is Snippet =>
        !!s &&
        typeof s === "object" &&
        typeof (s as Snippet).id === "string" &&
        typeof (s as Snippet).title === "string" &&
        typeof (s as Snippet).body === "string",
    );
  } catch {
    return [];
  }
}

function writeSnippets(list: Snippet[]): void {
  writeCompat(STORAGE_KEY, JSON.stringify(list));
}

/** Extract the unique `{placeholder}` names from a body, in first-seen order. */
export function extractPlaceholders(body: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /\{([a-zA-Z0-9_ -]+)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const name = m[1]!.trim();
    if (name && !seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

/** Substitute filled values into a body, leaving any unfilled `{name}` as-is. */
export function fillPlaceholders(body: string, values: Record<string, string>): string {
  return body.replace(/\{([a-zA-Z0-9_ -]+)\}/g, (whole, raw: string) => {
    const key = raw.trim();
    const v = values[key];
    return v != null && v !== "" ? v : whole;
  });
}

/**
 * The snippets manager: a localStorage-backed CRUD list of prompt templates with
 * insert-into-composer. Rendered as an overlay panel; the ChatPane opens it via a
 * button or "/" trigger and receives the resolved text through `onInsert`.
 */
export function SnippetLibrary({
  open,
  onClose,
  onInsert,
}: {
  open: boolean;
  onClose: () => void;
  /** Called with the (placeholder-filled) snippet body to drop into the composer. */
  onInsert: (text: string) => void;
}) {
  const [snippets, setSnippets] = useState<Snippet[]>([]);
  const [query, setQuery] = useState("");
  // null = not editing; "new" sentinel for a fresh draft; otherwise an id.
  const [editing, setEditing] = useState<Snippet | "new" | null>(null);
  // The snippet whose placeholders the user is currently filling (insert flow).
  const [filling, setFilling] = useState<Snippet | null>(null);

  // Load once when the panel first opens (cheap; localStorage is sync). Seed the
  // store the very first time so the library isn't empty.
  useEffect(() => {
    if (!open) return;
    const existing = readSnippets();
    if (existing.length === 0 && readCompat(STORAGE_KEY) == null) {
      const seeded = SEED.map((s) => ({ ...s, id: makeId(), updatedAt: Date.now() }));
      writeSnippets(seeded);
      setSnippets(seeded);
    } else {
      setSnippets(existing);
    }
  }, [open]);

  // Reset transient sub-views whenever the panel closes.
  useEffect(() => {
    if (!open) {
      setEditing(null);
      setFilling(null);
      setQuery("");
    }
  }, [open]);

  const persist = useCallback((next: Snippet[]) => {
    const sorted = [...next].sort((a, b) => b.updatedAt - a.updatedAt);
    setSnippets(sorted);
    writeSnippets(sorted);
  }, []);

  const saveSnippet = useCallback(
    (draft: { id?: string; title: string; body: string }) => {
      const title = draft.title.trim() || "Untitled";
      const body = draft.body;
      if (draft.id) {
        persist(
          snippets.map((s) =>
            s.id === draft.id ? { ...s, title, body, updatedAt: Date.now() } : s,
          ),
        );
      } else {
        persist([{ id: makeId(), title, body, updatedAt: Date.now() }, ...snippets]);
      }
      setEditing(null);
    },
    [snippets, persist],
  );

  const deleteSnippet = useCallback(
    (id: string) => persist(snippets.filter((s) => s.id !== id)),
    [snippets, persist],
  );

  // Insert: if the body has placeholders, open the fill form first; otherwise
  // insert straight away.
  const startInsert = useCallback(
    (s: Snippet) => {
      if (extractPlaceholders(s.body).length > 0) {
        setFilling(s);
      } else {
        onInsert(s.body);
        onClose();
      }
    },
    [onInsert, onClose],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return snippets;
    return snippets.filter(
      (s) => s.title.toLowerCase().includes(q) || s.body.toLowerCase().includes(q),
    );
  }, [snippets, query]);

  // Close on Escape from the overlay (when not inside a deeper sub-form, which
  // handle their own cancel).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !editing && !filling) {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, editing, filling, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-40 flex items-start justify-center bg-black/50 p-4 pt-[12vh]"
      onClick={onClose}
    >
      <div
        className="flex max-h-[70vh] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-950 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-2 border-b border-zinc-800 px-4 py-3">
          <FileText className="h-4 w-4 text-clay-400" />
          <span className="text-[13px] font-semibold text-zinc-100">Snippet library</span>
          <span className="text-[11px] text-zinc-600">{snippets.length}</span>
          <button
            onClick={() => setEditing("new")}
            className="ml-auto inline-flex items-center gap-1.5 rounded-lg bg-clay-500/15 px-2.5 py-1 text-[12px] font-medium text-clay-300 ring-1 ring-clay-500/30 transition hover:bg-clay-500/25"
          >
            <Plus className="h-3.5 w-3.5" />
            New
          </button>
          <button
            onClick={onClose}
            className="inline-flex items-center justify-center rounded-md p-1 text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-200"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {filling ? (
          <PlaceholderForm
            snippet={filling}
            onCancel={() => setFilling(null)}
            onInsert={(text) => {
              onInsert(text);
              onClose();
            }}
          />
        ) : editing ? (
          <SnippetEditor
            snippet={editing === "new" ? null : editing}
            onCancel={() => setEditing(null)}
            onSave={saveSnippet}
          />
        ) : (
          <>
            {/* Search */}
            <div className="flex items-center gap-2 border-b border-zinc-800 px-4 py-2">
              <Search className="h-3.5 w-3.5 text-zinc-600" />
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search snippets…"
                className="w-full bg-transparent text-[13px] text-zinc-100 placeholder:text-zinc-600 focus:outline-none"
              />
            </div>

            {/* List */}
            <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
              {filtered.length === 0 ? (
                <div className="px-3 py-10 text-center text-[12px] text-zinc-600">
                  {snippets.length === 0
                    ? "No snippets yet — create one with New."
                    : "No snippets match your search."}
                </div>
              ) : (
                <ul className="flex flex-col gap-1">
                  {filtered.map((s) => {
                    const ph = extractPlaceholders(s.body);
                    return (
                      <li
                        key={s.id}
                        className="group rounded-lg px-3 py-2 transition hover:bg-zinc-900"
                      >
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => startInsert(s)}
                            className="min-w-0 flex-1 text-left"
                            title="Insert into composer"
                          >
                            <div className="truncate text-[13px] font-medium text-zinc-100">
                              {s.title}
                            </div>
                            <div className="truncate text-[11.5px] text-zinc-500">{s.body}</div>
                          </button>
                          {ph.length > 0 ? (
                            <span
                              className="shrink-0 rounded bg-sky-500/10 px-1.5 py-0.5 text-[10px] font-medium text-sky-300"
                              title={`Placeholders: ${ph.join(", ")}`}
                            >
                              {ph.length} field{ph.length === 1 ? "" : "s"}
                            </span>
                          ) : null}
                          <button
                            onClick={() => setEditing(s)}
                            className="shrink-0 rounded p-1 text-zinc-500 opacity-0 transition hover:bg-zinc-800 hover:text-zinc-200 group-hover:opacity-100"
                            title="Edit"
                            aria-label="Edit snippet"
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </button>
                          <button
                            onClick={() => deleteSnippet(s.id)}
                            className="shrink-0 rounded p-1 text-zinc-500 opacity-0 transition hover:bg-red-500/15 hover:text-red-300 group-hover:opacity-100"
                            title="Delete"
                            aria-label="Delete snippet"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** Create/edit form for one snippet. `snippet=null` is a fresh draft. */
function SnippetEditor({
  snippet,
  onCancel,
  onSave,
}: {
  snippet: Snippet | null;
  onCancel: () => void;
  onSave: (draft: { id?: string; title: string; body: string }) => void;
}) {
  const [title, setTitle] = useState(snippet?.title ?? "");
  const [body, setBody] = useState(snippet?.body ?? "");
  const ph = useMemo(() => extractPlaceholders(body), [body]);
  const canSave = body.trim().length > 0;

  return (
    <div className="flex flex-col gap-3 px-4 py-3">
      <input
        autoFocus
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Title (e.g. Write tests)"
        className="w-full rounded-lg bg-zinc-900 px-3 py-2 text-[13px] text-zinc-100 placeholder:text-zinc-600 ring-1 ring-zinc-800 focus:outline-none focus:ring-clay-500/40"
      />
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={6}
        placeholder="Prompt body. Use {placeholders} for fields to fill in, e.g. Refactor {file}…"
        className="w-full resize-y rounded-lg bg-zinc-900 px-3 py-2 text-[13px] leading-relaxed text-zinc-100 placeholder:text-zinc-600 ring-1 ring-zinc-800 focus:outline-none focus:ring-clay-500/40"
      />
      {ph.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-zinc-500">
          <span>Placeholders:</span>
          {ph.map((p) => (
            <span key={p} className="rounded bg-sky-500/10 px-1.5 py-0.5 font-mono text-sky-300">
              {`{${p}}`}
            </span>
          ))}
        </div>
      ) : null}
      <div className="flex items-center justify-end gap-2">
        <button
          onClick={onCancel}
          className="rounded-lg bg-zinc-800 px-3 py-1.5 text-[12px] font-medium text-zinc-300 ring-1 ring-zinc-700 transition hover:bg-zinc-700"
        >
          Cancel
        </button>
        <button
          onClick={() => onSave({ id: snippet?.id, title, body })}
          disabled={!canSave}
          className="inline-flex items-center gap-1.5 rounded-lg bg-clay-500 px-3 py-1.5 text-[12px] font-medium text-white transition hover:bg-clay-600 disabled:opacity-40"
        >
          <Check className="h-3.5 w-3.5" />
          Save
        </button>
      </div>
    </div>
  );
}

/** Fill-in form shown before inserting a snippet that has `{placeholders}`. */
function PlaceholderForm({
  snippet,
  onCancel,
  onInsert,
}: {
  snippet: Snippet;
  onCancel: () => void;
  onInsert: (text: string) => void;
}) {
  const fields = useMemo(() => extractPlaceholders(snippet.body), [snippet.body]);
  const [values, setValues] = useState<Record<string, string>>({});
  const firstRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    firstRef.current?.focus();
  }, []);

  const preview = useMemo(() => fillPlaceholders(snippet.body, values), [snippet.body, values]);

  return (
    <div className="flex flex-col gap-3 px-4 py-3">
      <div className="text-[12px] font-medium text-zinc-300">{snippet.title}</div>
      <div className="flex flex-col gap-2">
        {fields.map((f, i) => (
          <label key={f} className="flex flex-col gap-1">
            <span className="font-mono text-[11px] text-sky-300">{`{${f}}`}</span>
            <input
              ref={i === 0 ? firstRef : undefined}
              value={values[f] ?? ""}
              onChange={(e) => setValues((v) => ({ ...v, [f]: e.target.value }))}
              placeholder={`Value for ${f}`}
              className="w-full rounded-lg bg-zinc-900 px-3 py-1.5 text-[13px] text-zinc-100 placeholder:text-zinc-600 ring-1 ring-zinc-800 focus:outline-none focus:ring-clay-500/40"
            />
          </label>
        ))}
      </div>
      <div className="rounded-lg bg-zinc-900/60 px-3 py-2 text-[12px] leading-relaxed text-zinc-400 ring-1 ring-zinc-800">
        <div className="mb-1 text-[10px] uppercase tracking-wide text-zinc-600">Preview</div>
        <div className="whitespace-pre-wrap break-words">{preview}</div>
      </div>
      <div className="flex items-center justify-end gap-2">
        <button
          onClick={onCancel}
          className="rounded-lg bg-zinc-800 px-3 py-1.5 text-[12px] font-medium text-zinc-300 ring-1 ring-zinc-700 transition hover:bg-zinc-700"
        >
          Back
        </button>
        <button
          onClick={() => onInsert(preview)}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-lg bg-clay-500 px-3 py-1.5 text-[12px] font-medium text-white transition hover:bg-clay-600",
          )}
        >
          <Check className="h-3.5 w-3.5" />
          Insert
        </button>
      </div>
    </div>
  );
}
