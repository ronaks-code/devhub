/**
 * M7-WORKMODE-WIRING: thin HTTP client over the flag-gated `/api/work-mode` routes
 * (`packages/server/src/routes/work-mode.ts`). Kept deliberately separate from the
 * large `ProviderApiClient` in `provider-api.ts` — Work mode is not a Code-mode
 * provider task, and this client's only job is: fetch the real, server-resolved
 * flag, and fetch/create the real `WorkModeTask` the panel renders. It never
 * fabricates data locally; a disabled flag or a network failure both resolve to
 * "no task" (the panel's `enabled`/`task` gate, not a synthetic placeholder).
 */

export type WorkModeOutcomeStatus = "pending" | "in-progress" | "delivered" | "failed" | "cancelled";

export interface WorkModeTaskDto {
  readonly kind: "work";
  readonly id: string;
  readonly folderScope: { readonly root: string; readonly writablePaths?: readonly string[] };
  readonly progress: { readonly status: WorkModeOutcomeStatus; readonly summary: string; readonly updatedAt: string };
  readonly artifacts: readonly { readonly path: string; readonly kind: string; readonly createdAt: string }[];
  readonly deliverables: readonly {
    readonly id: string;
    readonly description: string;
    readonly satisfiedByArtifactPaths: readonly string[];
  }[];
}

export interface WorkModeTaskInput {
  readonly id: string;
  readonly provider: "openai" | "anthropic";
  readonly home: string;
  readonly nativeTaskId: string;
  readonly folderScope: { readonly root: string; readonly writablePaths?: readonly string[] };
  readonly permissionProfile: { readonly allowedActions: readonly string[]; readonly deniedActions?: readonly string[] };
}

export interface WorkModeApiClient {
  fetchStatus(): Promise<{ enabled: boolean }>;
  fetchTask(id: string): Promise<WorkModeTaskDto | null>;
  createTask(input: WorkModeTaskInput): Promise<WorkModeTaskDto | null>;
  /** Fetch the task if it already exists; otherwise create it. Never throws on the
   * expected "disabled"/"not found" paths — those resolve to `null`. */
  getOrCreateTask(input: WorkModeTaskInput): Promise<WorkModeTaskDto | null>;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export function createWorkModeApiClient(fetchImpl: typeof fetch = fetch): WorkModeApiClient {
  const fetchStatus = async (): Promise<{ enabled: boolean }> => {
    try {
      const response = await fetchImpl("/api/work-mode/status");
      if (!response.ok) return { enabled: false };
      const body = await readJson(response);
      return { enabled: (body as { enabled?: unknown })?.enabled === true };
    } catch {
      return { enabled: false };
    }
  };

  const fetchTask = async (id: string): Promise<WorkModeTaskDto | null> => {
    try {
      const response = await fetchImpl(`/api/work-mode/tasks/${encodeURIComponent(id)}`);
      if (!response.ok) return null;
      const body = await readJson(response);
      return (body as { task?: WorkModeTaskDto })?.task ?? null;
    } catch {
      return null;
    }
  };

  const createTask = async (input: WorkModeTaskInput): Promise<WorkModeTaskDto | null> => {
    try {
      const response = await fetchImpl("/api/work-mode/tasks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!response.ok) return null;
      const body = await readJson(response);
      return (body as { task?: WorkModeTaskDto })?.task ?? null;
    } catch {
      return null;
    }
  };

  const getOrCreateTask = async (input: WorkModeTaskInput): Promise<WorkModeTaskDto | null> => {
    const existing = await fetchTask(input.id);
    if (existing) return existing;
    return createTask(input);
  };

  return { fetchStatus, fetchTask, createTask, getOrCreateTask };
}

export const workModeApi: WorkModeApiClient = createWorkModeApiClient();

/**
 * Project a real `WorkModeTaskDto` into the panel's rendering-only view model.
 * `deliverableLabels` supplies the human label for a deliverable id the caller
 * already knows about (falls back to the id) — the DTO itself only carries
 * `description`, which this prefers when present.
 */
export function toWorkModeTaskView(
  task: WorkModeTaskDto,
  title: string,
): {
  title: string;
  folderScope: string;
  outcome: { summary: string; current: number; total: number };
  deliverables: { id: string; label: string; status: "ready" | "in-progress" | "pending" }[];
} {
  const total = task.deliverables.length;
  const ready = task.deliverables.filter((d) => d.satisfiedByArtifactPaths.length > 0).length;
  return {
    title,
    folderScope: task.folderScope.root,
    outcome: { summary: task.progress.summary, current: ready, total },
    deliverables: task.deliverables.map((deliverable) => ({
      id: deliverable.id,
      label: deliverable.description,
      status: deliverable.satisfiedByArtifactPaths.length > 0 ? "ready" : "pending",
    })),
  };
}
