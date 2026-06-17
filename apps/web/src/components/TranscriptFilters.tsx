import { useMemo } from "react";
import { Filter, AlertCircle, Brain, X } from "lucide-react";
import type { MessageRole, NormalizedMessage } from "../lib/types";
import { cn } from "../lib/utils";

/**
 * Client-side transcript filter state. Applied AFTER tool pairing (so a tool_use
 * card and its result count as one item). All filters are subtractive; an empty
 * filter set shows everything.
 */
export interface TranscriptFilterState {
  /** Only show messages with these roles. Empty = all roles. */
  roles: Set<MessageRole>;
  /** Only show messages that use one of these tool names. Empty = no tool filter. */
  tools: Set<string>;
  /** Only keep messages that contain a tool error (or are otherwise an error). */
  errorsOnly: boolean;
  /** Strip `thinking` blocks from rendered messages. */
  hideThinking: boolean;
}

export const EMPTY_FILTERS: TranscriptFilterState = {
  roles: new Set(),
  tools: new Set(),
  errorsOnly: false,
  hideThinking: false,
};

/** True when nothing is being filtered (lets callers skip the transform entirely). */
export function isEmptyFilter(f: TranscriptFilterState): boolean {
  return (
    f.roles.size === 0 && f.tools.size === 0 && !f.errorsOnly && !f.hideThinking
  );
}

/** Roles worth offering as chips (the conversational + tool-bearing ones). */
const ROLE_CHIPS: MessageRole[] = ["user", "assistant", "system"];

function messageHasError(m: NormalizedMessage): boolean {
  return m.blocks.some((b) => b.type === "tool_result" && b.isError === true);
}

function messageToolNames(m: NormalizedMessage): string[] {
  const out: string[] = [];
  for (const b of m.blocks) if (b.type === "tool_use" && b.name) out.push(b.name);
  return out;
}

/**
 * Apply the filter set to a (already tool-paired) message list. Returns a new
 * array; messages that don't match are dropped, and `hideThinking` shallow-clones
 * matching messages with their thinking blocks removed. Messages emptied by
 * hiding thinking are dropped so we don't render blank bubbles.
 */
export function applyFilters(
  messages: NormalizedMessage[],
  f: TranscriptFilterState,
): NormalizedMessage[] {
  if (isEmptyFilter(f)) return messages;
  const out: NormalizedMessage[] = [];
  for (const m of messages) {
    if (f.roles.size > 0 && !f.roles.has(m.role)) continue;
    if (f.errorsOnly && !messageHasError(m)) continue;
    if (f.tools.size > 0) {
      const names = messageToolNames(m);
      if (!names.some((n) => f.tools.has(n))) continue;
    }
    if (f.hideThinking && m.blocks.some((b) => b.type === "thinking")) {
      const blocks = m.blocks.filter((b) => b.type !== "thinking");
      if (blocks.length === 0) continue; // nothing left to show
      out.push({ ...m, blocks });
      continue;
    }
    out.push(m);
  }
  return out;
}

function Chip({
  active,
  onClick,
  children,
  title,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11.5px] font-medium ring-1 transition",
        active
          ? "bg-clay-500/15 text-clay-300 ring-clay-500/30 hover:bg-clay-500/25"
          : "bg-zinc-900 text-zinc-400 ring-zinc-800 hover:bg-zinc-800 hover:text-zinc-200",
      )}
    >
      {children}
    </button>
  );
}

/**
 * The filter bar shown above the transcript. Stateless w.r.t. the messages — it
 * derives the available tool names from the current list and renders one chip per
 * role / tool plus the errors-only and hide-thinking toggles. State lives in the
 * pane; this just toggles it.
 */
export function TranscriptFilters({
  messages,
  value,
  onChange,
}: {
  messages: NormalizedMessage[];
  value: TranscriptFilterState;
  onChange: (next: TranscriptFilterState) => void;
}) {
  // Distinct tool names present in this transcript, sorted for stable chip order.
  const toolNames = useMemo(() => {
    const set = new Set<string>();
    for (const m of messages) for (const n of messageToolNames(m)) set.add(n);
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [messages]);

  const toggleRole = (role: MessageRole) => {
    const roles = new Set(value.roles);
    if (roles.has(role)) roles.delete(role);
    else roles.add(role);
    onChange({ ...value, roles });
  };

  const toggleTool = (tool: string) => {
    const tools = new Set(value.tools);
    if (tools.has(tool)) tools.delete(tool);
    else tools.add(tool);
    onChange({ ...value, tools });
  };

  const dirty = !isEmptyFilter(value);

  return (
    <div className="flex flex-wrap items-center gap-1.5 border-b border-zinc-800/80 bg-zinc-900/20 px-5 py-2">
      <Filter className="h-3.5 w-3.5 shrink-0 text-zinc-600" />

      {ROLE_CHIPS.map((role) => (
        <Chip
          key={role}
          active={value.roles.has(role)}
          onClick={() => toggleRole(role)}
          title={`Show ${role} messages`}
        >
          {role}
        </Chip>
      ))}

      {toolNames.length > 0 ? <span className="mx-0.5 h-3.5 w-px bg-zinc-800" /> : null}
      {toolNames.map((tool) => (
        <Chip
          key={tool}
          active={value.tools.has(tool)}
          onClick={() => toggleTool(tool)}
          title={`Only messages using ${tool}`}
        >
          <span className="font-mono">{tool}</span>
        </Chip>
      ))}

      <span className="mx-0.5 h-3.5 w-px bg-zinc-800" />
      <Chip
        active={value.errorsOnly}
        onClick={() => onChange({ ...value, errorsOnly: !value.errorsOnly })}
        title="Only messages containing a tool error"
      >
        <AlertCircle className="h-3 w-3" />
        Errors only
      </Chip>
      <Chip
        active={value.hideThinking}
        onClick={() => onChange({ ...value, hideThinking: !value.hideThinking })}
        title="Hide thinking blocks"
      >
        <Brain className="h-3 w-3" />
        Hide thinking
      </Chip>

      {dirty ? (
        <button
          type="button"
          onClick={() => onChange(EMPTY_FILTERS)}
          className="ml-auto inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-200"
          title="Clear all filters"
        >
          <X className="h-3 w-3" />
          Clear
        </button>
      ) : null}
    </div>
  );
}
