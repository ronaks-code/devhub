import { useEffect, useState } from "react";
import { WorkModePanel, type WorkModeTaskView } from "./WorkModePanel.js";
import {
  workModeApi as defaultWorkModeApi,
  toWorkModeTaskView,
  type WorkModeApiClient,
  type WorkModeTaskInput,
} from "../../../lib/work-mode-api.js";

export interface WorkModeSurfaceProps {
  /** The resolved `workMode` feature flag. `false` never issues a request and
   * never renders anything — the client-side mirror of the server's own re-check. */
  enabled: boolean;
  title: string;
  provider: "openai" | "anthropic";
  home: string;
  nativeTaskId: string;
  folderRoot: string;
  taskId: string;
  onDismiss?: () => void;
  client?: WorkModeApiClient;
  className?: string;
}

/**
 * Owns fetching (or, on first use, creating) the real `WorkModeTask` this
 * project's Work-mode surface renders, then hands the projection to the pure
 * `WorkModePanel`. `enabled=false` short-circuits before any network call — the
 * server independently re-checks the same flag, so this is belt-and-suspenders,
 * never the only gate.
 */
export function WorkModeSurface({
  enabled,
  title,
  provider,
  home,
  nativeTaskId,
  folderRoot,
  taskId,
  onDismiss,
  client = defaultWorkModeApi,
  className,
}: WorkModeSurfaceProps) {
  const [task, setTask] = useState<WorkModeTaskView | null>(null);

  useEffect(() => {
    if (!enabled || folderRoot.length === 0) {
      setTask(null);
      return;
    }
    let cancelled = false;
    const input: WorkModeTaskInput = {
      id: taskId,
      provider,
      home,
      nativeTaskId,
      folderScope: { root: folderRoot },
      permissionProfile: { allowedActions: ["progress:update", "artifact:record", "deliverable:add"] },
    };
    void client.getOrCreateTask(input).then((dto) => {
      if (cancelled) return;
      setTask(dto ? toWorkModeTaskView(dto, title) : null);
    });
    return () => {
      cancelled = true;
    };
  }, [enabled, provider, home, nativeTaskId, folderRoot, taskId, title, client]);

  return (
    <WorkModePanel
      enabled={enabled}
      task={task}
      onDismiss={onDismiss}
      {...(className !== undefined ? { className } : {})}
    />
  );
}
