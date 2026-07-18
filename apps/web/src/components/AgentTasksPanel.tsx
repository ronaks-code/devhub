import { Bot, CheckCircle2, Loader2, XCircle } from "lucide-react";
import { cn } from "../lib/utils.js";

export type AgentTaskStatus = "running" | "done" | "failed";

export interface AgentTask {
  id: string;
  label: string;
  status: AgentTaskStatus;
  output: string | null;
}

export interface AgentActivity {
  type?: "activity";
  activity: string;
  status: string;
  message: string | null;
  turnId: string | null;
  /** Direct provider events use itemId; collapsed timeline entries use nativeId. */
  itemId?: string | null;
  nativeId?: string | null;
}

const ACTIVE_STATUSES = new Set(["active", "inprogress", "pending", "pendinginit", "requested", "running", "started"]);
const FAILED_STATUSES = new Set(["declined", "error", "errored", "failed", "interrupted", "notfound"]);

function normalizedStatus(status: string): AgentTaskStatus {
  const value = status.replace(/[^a-z]/giu, "").toLowerCase();
  if (ACTIVE_STATUSES.has(value)) return "running";
  if (FAILED_STATUSES.has(value)) return "failed";
  return "done";
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function parseMessage(message: string | null): Record<string, unknown> | null {
  if (!message) return null;
  try {
    return record(JSON.parse(message));
  } catch {
    return null;
  }
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isAgentActivity(activity: string): boolean {
  return /(?:subagent|subAgent|collabAgent|background[-_ ]?(?:agent|task|work))/u.test(activity);
}

/** Collapse provider-native agent events into one live row per spawned agent. */
export function projectAgentTasks(events: readonly AgentActivity[]): AgentTask[] {
  const tasks = new Map<string, AgentTask>();
  for (const event of events) {
    if (!isAgentActivity(event.activity)) continue;
    const payload = parseMessage(event.message);
    const states = record(payload?.agentsStates);
    if (states && Object.keys(states).length > 0) {
      for (const [agentId, rawState] of Object.entries(states)) {
        const state = record(rawState);
        const previous = tasks.get(agentId);
        const prompt = text(payload?.prompt);
        const stateMessage = text(state?.message);
        tasks.set(agentId, {
          id: agentId,
          label: prompt ?? previous?.label ?? `Subagent ${agentId}`,
          status: normalizedStatus(text(state?.status) ?? event.status),
          output: stateMessage ?? previous?.output ?? null,
        });
      }
      continue;
    }

    const agentId = text(payload?.agentThreadId) ?? event.itemId ?? event.nativeId
      ?? `${event.turnId ?? "task"}:${event.activity}`;
    const previous = tasks.get(agentId);
    const label = text(payload?.label) ?? text(payload?.description) ?? text(payload?.prompt)
      ?? text(payload?.agentPath) ?? previous?.label ?? event.activity;
    const structuredOutput = text(payload?.output) ?? text(payload?.message);
    const output = structuredOutput ?? (payload ? JSON.stringify(payload, null, 2) : event.message) ?? previous?.output ?? null;
    tasks.set(agentId, {
      id: agentId,
      label,
      status: normalizedStatus(event.status),
      output,
    });
  }
  return [...tasks.values()];
}

const STATUS_STYLE: Record<AgentTaskStatus, string> = {
  running: "text-sky-300",
  done: "text-emerald-300",
  failed: "text-red-300",
};

function StatusIcon({ status }: { status: AgentTaskStatus }) {
  if (status === "running") return <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />;
  if (status === "done") return <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />;
  return <XCircle className="h-3.5 w-3.5" aria-hidden="true" />;
}

export function AgentTasksPanel({ tasks }: { tasks: readonly AgentTask[] }) {
  if (tasks.length === 0) return null;
  return (
    <section
      aria-label="Subagents and background tasks"
      className="shrink-0 border-b border-zinc-800/80 bg-zinc-950/70 px-4 py-2.5"
    >
      <div className="mb-1.5 flex items-center gap-2 text-[11px] font-medium uppercase tracking-wide text-zinc-500">
        <Bot className="h-3.5 w-3.5" aria-hidden="true" />
        Subagents &amp; background tasks
        <span className="text-zinc-600">{tasks.length}</span>
      </div>
      <div className="space-y-1">
        {tasks.map((task) => (
          <details key={task.id} className="rounded-md bg-zinc-900/60 ring-1 ring-zinc-800/80">
            <summary className="flex cursor-pointer list-none items-center gap-2 px-2.5 py-1.5 text-xs text-zinc-200">
              <span className={cn("inline-flex items-center gap-1", STATUS_STYLE[task.status])}>
                <StatusIcon status={task.status} />
                {task.status}
              </span>
              <span className="min-w-0 flex-1 truncate">{task.label}</span>
            </summary>
            {task.output ? (
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words border-t border-zinc-800 px-2.5 py-2 font-mono text-[11px] leading-relaxed text-zinc-400">
                {task.output}
              </pre>
            ) : (
              <div className="border-t border-zinc-800 px-2.5 py-2 text-[11px] text-zinc-600">No output yet</div>
            )}
          </details>
        ))}
      </div>
    </section>
  );
}
