/**
 * Event-driven CONFIG updates: watch Claude Code's own configuration files/dirs and
 * emit a `config-changed` EngineEvent (carrying the changed path) so faces can
 * live-refresh the settings / agents / hooks / MCP views without a manual reload.
 *
 * What we watch (mirrors what {@link "../config/index.js"} reads):
 *   - ~/.claude/settings.json        (global hooks + permissions)
 *   - ~/.claude.json                 (mcpServers + per-project blocks)
 *   - ~/.claude/agents/              (subagent .md files)
 *   - ~/.claude/skills/              (skill SKILL.md files)
 *   - ~/.claude/commands/            (slash command .md files)
 *   - ~/.claude/CLAUDE.md            (global memory)
 *   - <projectCwd>/.claude/          (project settings / agents / hooks)  [optional]
 *
 * We deliberately DO NOT watch ~/.claude/projects (transcripts) — that's the
 * transcript watcher's job; mixing them would spam config-changed on every chat
 * token. Like the transcript watcher we debounce with awaitWriteFinish so an editor
 * writing a settings file in several syscalls fires one event, and ignoreInitial so
 * we don't replay the whole tree on startup.
 */
import chokidar from "chokidar";
import path from "node:path";
import os from "node:os";
import { claudeConfigDir } from "../paths.js";
import type { Engine } from "../index.js";

/** Options for {@link startConfigWatcher}. */
export interface ConfigWatcherOptions {
  /**
   * Extra project working directories whose `<cwd>/.claude` dir should also be
   * watched (project-scoped settings/agents/hooks). Defaults to none — the global
   * config under ~/.claude is always watched.
   */
  projectCwds?: string[];
}

/**
 * The set of config paths we watch, given the (override-aware) config dir + any
 * project cwds. Exported for unit testing without spinning up a real watcher.
 *
 * chokidar tolerates non-existent paths (it just watches for them to appear), so we
 * list everything unconditionally — a machine missing, say, ~/.claude/agents simply
 * has nothing to fire there until the dir is created.
 *
 * `claudeJsonPath` is passed in (rather than derived) because Claude Code keeps
 * `.claude.json` in $HOME even when CLAUDE_CONFIG_DIR relocates the config dir; the
 * caller resolves it (default: `~/.claude.json`).
 */
export function configWatchPaths(
  configDir: string,
  projectCwds: string[] = [],
  claudeJsonPath: string = path.join(os.homedir(), ".claude.json"),
): string[] {
  const paths = [
    path.join(configDir, "settings.json"),
    path.join(configDir, "CLAUDE.md"),
    path.join(configDir, "agents"),
    path.join(configDir, "skills"),
    path.join(configDir, "commands"),
    claudeJsonPath,
  ];
  for (const cwd of projectCwds) {
    paths.push(path.join(cwd, ".claude"));
    paths.push(path.join(cwd, "CLAUDE.md"));
  }
  return paths;
}

/**
 * Start watching Claude Code's config files/dirs; emit a `config-changed`
 * EngineEvent (with the absolute changed path) on each add/change/unlink. Returns a
 * stop() that closes the underlying chokidar watcher.
 *
 * The existing /api/events SSE forwards every EngineEvent, so faces receive these
 * with no extra wiring.
 */
export function startConfigWatcher(
  engine: Engine,
  opts: ConfigWatcherOptions = {},
): () => void {
  const watcher = chokidar.watch(configWatchPaths(claudeConfigDir(), opts.projectCwds), {
    ignoreInitial: true,
    // Depth keeps us off deep, noisy subtrees while still catching nested commands
    // (e.g. commands/git/commit.md) and project .claude/* files.
    depth: 4,
    awaitWriteFinish: { stabilityThreshold: 400, pollInterval: 100 },
  });

  const handle = (file: string): void => {
    engine.emitConfigChanged(file);
  };

  watcher.on("add", handle).on("change", handle).on("unlink", handle);
  // chokidar surfaces a dir add/unlink separately; forward those too so creating an
  // agents/ dir (or removing a project's .claude/) is observable.
  watcher.on("addDir", handle).on("unlinkDir", handle);

  return () => {
    void watcher.close();
  };
}
