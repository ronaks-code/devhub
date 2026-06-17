import { CheckCircle2, Circle, CircleDot, ListChecks } from "lucide-react";
import type { PairedToolUse } from "../../lib/transcript";
import { cn } from "../../lib/utils";

/** A todo status as written by the TodoWrite tool. */
type TodoStatus = "pending" | "in_progress" | "completed";

interface TodoItem {
  content: string;
  status: TodoStatus;
  /** Present-tense label shown while in progress (Claude Code convention). */
  activeForm?: string;
}

/** Coerce one raw todo object into a typed item, tolerating odd shapes. */
function parseTodo(raw: unknown): TodoItem | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const content = typeof o.content === "string" ? o.content : null;
  if (!content) return null;
  const status: TodoStatus =
    o.status === "completed" || o.status === "in_progress" || o.status === "pending"
      ? (o.status as TodoStatus)
      : "pending";
  return {
    content,
    status,
    activeForm: typeof o.activeForm === "string" ? o.activeForm : undefined,
  };
}

/** Pull the todo list out of the tool input; [] when missing/malformed. */
function parseTodos(input: unknown): TodoItem[] {
  if (!input || typeof input !== "object") return [];
  const list = (input as Record<string, unknown>).todos;
  if (!Array.isArray(list)) return [];
  return list.map(parseTodo).filter((t): t is TodoItem => t !== null);
}

const STATUS_META: Record<
  TodoStatus,
  { icon: typeof Circle; iconCls: string; textCls: string }
> = {
  completed: {
    icon: CheckCircle2,
    iconCls: "text-emerald-400",
    textCls: "text-zinc-500 line-through",
  },
  in_progress: {
    icon: CircleDot,
    iconCls: "text-clay-400",
    textCls: "text-zinc-100 font-medium",
  },
  pending: {
    icon: Circle,
    iconCls: "text-zinc-600",
    textCls: "text-zinc-300",
  },
};

/**
 * Tool-specific renderer for the TodoWrite tool_use: shows the todo list as a
 * checklist with per-status icons/colors instead of raw JSON. In-progress items
 * use their present-tense `activeForm`; completed items get a strike-through.
 * Dispatched from MessageView when a tool_use's name is "TodoWrite".
 */
export function TodoWriteCard({ block }: { block: PairedToolUse }) {
  const todos = parseTodos(block.input);
  const done = todos.filter((t) => t.status === "completed").length;

  // Defensive fallback: an unparseable payload still renders as a labeled card
  // rather than vanishing.
  if (todos.length === 0) {
    return (
      <details className="my-1.5 rounded-lg border border-zinc-800 bg-zinc-900/40 open:bg-zinc-900/60">
        <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-1.5 text-xs font-medium text-clay-400">
          <ListChecks className="h-3.5 w-3.5" />
          <span>TodoWrite</span>
          <span className="text-zinc-600">· empty</span>
        </summary>
        <pre className="overflow-x-auto border-t border-zinc-800 px-3 py-2 font-mono text-[12px] text-zinc-400">
          {JSON.stringify(block.input, null, 2)}
        </pre>
      </details>
    );
  }

  return (
    <details
      className="my-1.5 overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900/40 open:bg-zinc-900/60"
      open
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-1.5 text-xs font-medium">
        <ListChecks className="h-3.5 w-3.5 text-clay-400" />
        <span className="text-clay-400">Todos</span>
        <span className="ml-auto inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium text-zinc-500">
          {done}/{todos.length} done
        </span>
      </summary>
      <ul className="border-t border-zinc-800 px-3 py-2">
        {todos.map((t, i) => {
          const meta = STATUS_META[t.status];
          const Icon = meta.icon;
          const label = t.status === "in_progress" && t.activeForm ? t.activeForm : t.content;
          return (
            <li key={i} className="flex items-start gap-2 py-0.5 text-[13px] leading-relaxed">
              <Icon className={cn("mt-0.5 h-3.5 w-3.5 shrink-0", meta.iconCls)} />
              <span className={meta.textCls}>{label}</span>
            </li>
          );
        })}
      </ul>
    </details>
  );
}
