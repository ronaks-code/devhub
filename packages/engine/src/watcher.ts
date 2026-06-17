/**
 * Event-driven live updates: watch ~/.claude/projects for new/changed transcripts
 * and incrementally re-index them. depth:1 keeps us on top-level session files
 * (not the deep subagents/ trees), and awaitWriteFinish debounces busy live sessions.
 */
import chokidar from "chokidar";
import path from "node:path";
import { projectsDir } from "./paths.js";
import { INTERNAL_FOLDER_PATTERNS, isInternalFolder } from "./discovery.js";
import type { Engine } from "./index.js";

export function watchTranscripts(engine: Engine): () => void {
  const watcher = chokidar.watch(projectsDir(), {
    ignoreInitial: true,
    depth: 1,
    ignored: (p: string) => INTERNAL_FOLDER_PATTERNS.some((x) => p.includes(x)),
    awaitWriteFinish: { stabilityThreshold: 400, pollInterval: 100 },
  });

  const handle = (file: string): void => {
    if (file.endsWith(".jsonl")) void engine.onFileChanged(file);
  };

  // A deleted transcript (Claude Code's ~30-day auto-delete, or a manual rm) is NOT
  // a reason to forget the session: we keep the index row AND the gzip archive so it
  // stays viewable. Just note it — getSessionMessages already falls back to the
  // archive when the source is gone.
  const handleUnlink = (file: string): void => {
    if (!file.endsWith(".jsonl")) return;
    if (isInternalFolder(path.dirname(file))) return;
    console.info(`[engine] transcript removed (kept in index + archive): ${file}`);
  };

  watcher.on("add", handle).on("change", handle).on("unlink", handleUnlink);
  return () => {
    void watcher.close();
  };
}
