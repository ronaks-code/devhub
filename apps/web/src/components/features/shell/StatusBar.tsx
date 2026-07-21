import { StatusDot } from "../../ui/StatusDot.js";

/**
 * StatusBar — the 26px ambient status strip under the main surface only (§2.1/§3.7).
 * Its signature job: surface "N need you — oldest {age}" on EVERY route whenever the
 * count > 0, so a waiting agent is never invisible. Everything here is real data from
 * the app-root useStatsPolling join; a segment renders only when its value exists.
 * Non-interactive, so it doubles as a Tauri window-drag region (§4).
 */
export interface StatusBarProps {
  runningCount: number;
  needsYouCount: number;
  /** Epoch ms of the oldest waiting session, for the "oldest {age}" hint. */
  oldestNeedsYouAt?: number | null;
  monthToDateUsd?: number;
  projectName?: string;
  branch?: string | null;
}

function ago(ms: number | null | undefined): string {
  if (!ms) return "";
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export function StatusBar({
  runningCount,
  needsYouCount,
  oldestNeedsYouAt,
  monthToDateUsd,
  projectName,
  branch,
}: StatusBarProps) {
  const oldest = ago(oldestNeedsYouAt);
  return (
    <div className="dh-statusbar-inner" data-tauri-drag-region>
      <div className="dh-status-left" data-tauri-drag-region>
        {projectName ? <span className="dh-status-seg">{projectName}</span> : null}
        {branch ? <span className="dh-status-seg dh-status-branch">{`⎇ ${branch}`}</span> : null}
      </div>

      {needsYouCount > 0 ? (
        <span className="dh-status-attention" data-dh-attention="" role="status">
          {`⚠ ${needsYouCount} need you${oldest ? ` — oldest ${oldest}` : ""}`}
        </span>
      ) : null}

      <div className="dh-status-right" data-tauri-drag-region>
        <span className="dh-status-seg">
          <StatusDot status={runningCount > 0 ? "running" : "idle"} />
          {`${runningCount} running`}
        </span>
        {typeof monthToDateUsd === "number" ? (
          <span className="dh-status-seg">{`$${monthToDateUsd.toFixed(0)} MTD`}</span>
        ) : null}
      </div>
    </div>
  );
}
