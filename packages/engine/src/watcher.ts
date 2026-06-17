/**
 * Event-driven live updates: watch ~/.claude/projects for new/changed transcripts
 * and incrementally re-index them. depth:1 keeps us on top-level session files
 * (not the deep subagents/ trees), and awaitWriteFinish debounces busy live sessions.
 */
import chokidar from "chokidar";
import { projectsDir } from "./paths.js";
import { INTERNAL_FOLDER_PATTERNS } from "./discovery.js";
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

  watcher.on("add", handle).on("change", handle);
  return () => {
    void watcher.close();
  };
}
