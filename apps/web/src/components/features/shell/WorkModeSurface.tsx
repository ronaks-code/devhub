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
  // #9: opening Work used to show NOTHING until getOrCreateTask's round-trip
  // landed (the panel `return null`s without a task), so clicking it read as a
  // multi-second freeze. Surface a loading state so the panel can render its
  // chrome + a skeleton and populate progressively — without ever fabricating
  // task content (a settled null still renders nothing).
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!enabled || folderRoot.length === 0) {
      setTask(null);
      setLoading(false);
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
    // Only show the skeleton if the fetch is genuinely slow (>150ms): a fast
    // response paints the real panel with no skeleton flash, while a slow one
    // (the #9 freeze) gets an instant-feeling panel with a pending state instead
    // of a blank multi-second gap.
    const slowTimer = setTimeout(() => {
      if (!cancelled) setLoading(true);
    }, 150);
    void client
      .getOrCreateTask(input)
      .then((dto) => {
        if (cancelled) return;
        setTask(dto ? toWorkModeTaskView(dto, title) : null);
      })
      .catch(() => {
        // A failed fetch settles to "no task" (renders nothing) rather than
        // leaving a permanent loading skeleton up.
        if (!cancelled) setTask(null);
      })
      .finally(() => {
        if (cancelled) return;
        clearTimeout(slowTimer);
        setLoading(false);
      });
    return () => {
      cancelled = true;
      clearTimeout(slowTimer);
    };
  }, [enabled, provider, home, nativeTaskId, folderRoot, taskId, title, client]);

  return (
    <WorkModePanel
      enabled={enabled}
      task={task}
      loading={loading}
      onDismiss={onDismiss}
      {...(className !== undefined ? { className } : {})}
    />
  );
}
