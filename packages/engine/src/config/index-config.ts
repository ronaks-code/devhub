/**
 * A flat, cross-artifact search over Claude Code's OWN configuration — the backing
 * query for a "config command palette". One call fans out across every config reader
 * in this package and returns a single ranked list of hits, so a face can jump to any
 * agent / skill / command / MCP server / settings key / hook / CLAUDE.md passage by
 * typing part of its name or content.
 *
 * What it searches (each via the existing reader in {@link ./index.js}):
 *   - agents        (name + description)            -> kind "agent"
 *   - skills        (name + description)            -> kind "skill"
 *   - commands      (name + description)            -> kind "command"
 *   - mcp servers   (name + command + args)         -> kind "mcp"
 *   - settings keys (top-level settings.json keys)  -> kind "setting"
 *   - hooks         (event name)                    -> kind "hook"
 *   - CLAUDE.md     (the doc CONTENT, line by line) -> kind "claudeMd"
 *
 * Matching is case-insensitive: a substring match ranks highest, then a lenient
 * subsequence ("fuzzy") match — so "skl" still finds "skills". A blank query returns
 * an empty list (a palette shows nothing until the user types). Read-only and tolerant
 * by construction: every underlying reader swallows missing/corrupt files, so a half-
 * configured machine yields fewer hits rather than throwing.
 */
import path from "node:path";
import { claudeConfigDir } from "../paths.js";
import {
  listAgents,
  listSkills,
  listCommands,
  listMcpServers,
  readSettings,
  readGlobalClaudeMd,
  readProjectClaudeMd,
} from "./index.js";
import type { ConfigScope } from "./index.js";

/** The artifact kind a {@link ConfigSearchHit} came from. */
export type ConfigArtifactKind =
  | "agent"
  | "skill"
  | "command"
  | "mcp"
  | "setting"
  | "hook"
  | "claudeMd";

/** One match from {@link searchConfig}. */
export interface ConfigSearchHit {
  /** Which config artifact this is. */
  kind: ConfigArtifactKind;
  /** The artifact's identifier (agent/skill/command/server name, settings key, hook event, or "CLAUDE.md"). */
  name: string;
  /** Where it lives (project entry shadows / supplements a global one of the same name). */
  scope: ConfigScope;
  /**
   * Absolute path of the file the artifact lives in. MCP servers + settings keys + hooks
   * have no standalone file (they're keys inside ~/.claude.json / settings.json), so this
   * is the containing config file, or null when not applicable.
   */
  file: string | null;
  /** A short human-readable excerpt (description, value preview, or the matched CLAUDE.md line). */
  snippet: string;
  /**
   * Match score (higher = better), used for the default ranking. Exposed so a caller can
   * re-sort or threshold; not meant for display.
   */
  score: number;
}

/** Settings keys are searched only by their NAME; this caps how long a value preview gets. */
const VALUE_PREVIEW_MAX = 80;
/** A matched CLAUDE.md line is trimmed to this many chars for the snippet. */
const LINE_SNIPPET_MAX = 160;

/**
 * Score `haystack` against the lower-cased `needle`. Returns 0 for no match, a positive
 * number otherwise (substring beats subsequence; an earlier / whole-word match beats a
 * later one). `needle` MUST already be lower-cased; `haystack` is lowered here.
 */
function scoreMatch(haystack: string, needle: string): number {
  if (!needle) return 0;
  const hay = haystack.toLowerCase();

  // Exact equality is the strongest signal.
  if (hay === needle) return 1000;

  const idx = hay.indexOf(needle);
  if (idx >= 0) {
    // Substring: base 500, minus how deep into the string the match starts (earlier is
    // better), plus a bonus when it sits on a word boundary (start, or after a separator).
    const boundary = idx === 0 || /[^a-z0-9]/.test(hay[idx - 1] ?? "");
    return 500 - Math.min(idx, 400) + (boundary ? 50 : 0);
  }

  // Subsequence ("fuzzy"): every char of needle appears in order. Weakest match; score by
  // how tightly the chars cluster (a compact run beats chars scattered across the string).
  let h = 0;
  let firstAt = -1;
  let lastAt = -1;
  for (let n = 0; n < needle.length; n++) {
    const ch = needle[n]!;
    let found = -1;
    while (h < hay.length) {
      if (hay[h] === ch) {
        found = h;
        h++;
        break;
      }
      h++;
    }
    if (found < 0) return 0; // a needle char never appeared in order -> no match
    if (firstAt < 0) firstAt = found;
    lastAt = found;
  }
  const span = lastAt - firstAt + 1;
  // 200 base, minus the "spread" beyond the ideal (== needle.length) span. Floor at 1 so a
  // real subsequence match always outranks no match.
  return Math.max(1, 200 - (span - needle.length));
}

/**
 * Score a hit against several candidate texts (e.g. name + description) and keep the BEST.
 * Returns the winning score (0 when nothing matched any field).
 */
function bestScore(needle: string, ...fields: Array<string | null | undefined>): number {
  let best = 0;
  for (const f of fields) {
    if (!f) continue;
    const s = scoreMatch(f, needle);
    if (s > best) best = s;
  }
  return best;
}

/** Collapse a multi-line / over-long string into a single trimmed snippet. */
function previewOf(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? oneLine.slice(0, max - 1) + "…" : oneLine;
}

/** A compact, display-safe preview of an arbitrary settings VALUE. */
function valuePreview(value: unknown): string {
  let s: string;
  try {
    s = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    s = String(value);
  }
  return previewOf(s ?? "", VALUE_PREVIEW_MAX);
}

/**
 * Search across ALL of Claude Code's config artifacts for `query`, returning a flat,
 * relevance-ranked list of hits for a config command palette. Matching is case-
 * insensitive substring-then-fuzzy. Pass `projectCwd` to also include that project's
 * scoped agents/skills/commands/MCP servers/settings/CLAUDE.md (project entries are
 * reported alongside globals, each carrying its own `scope`). A blank query yields `[]`.
 *
 * `opts.limit` caps the result count (default 50). Results are sorted by score desc,
 * then kind, then name, for a stable ordering.
 */
export async function searchConfig(
  query: string,
  projectCwd?: string,
  opts: { limit?: number } = {},
): Promise<ConfigSearchHit[]> {
  const needle = (query ?? "").trim().toLowerCase();
  if (!needle) return [];
  const limit = opts.limit ?? 50;

  // Fan out the independent readers concurrently — none depends on another's output.
  const [agents, skills, commands, mcpServers, settings, globalMd, projectMd] = await Promise.all([
    listAgents(projectCwd),
    listSkills(projectCwd),
    listCommands(projectCwd),
    listMcpServers(projectCwd),
    readSettings(projectCwd),
    readGlobalClaudeMd(),
    projectCwd ? readProjectClaudeMd(projectCwd) : Promise.resolve(null),
  ]);

  const hits: ConfigSearchHit[] = [];

  // --- Agents (name + description) ---
  for (const a of agents) {
    const score = bestScore(needle, a.name, a.description);
    if (score > 0) {
      hits.push({
        kind: "agent",
        name: a.name,
        scope: a.scope,
        file: a.filePath,
        snippet: a.description ? previewOf(a.description, LINE_SNIPPET_MAX) : a.name,
        score,
      });
    }
  }

  // --- Skills (name + description) ---
  for (const s of skills) {
    const score = bestScore(needle, s.name, s.description);
    if (score > 0) {
      hits.push({
        kind: "skill",
        name: s.name,
        scope: s.scope,
        file: s.filePath,
        snippet: s.description ? previewOf(s.description, LINE_SNIPPET_MAX) : s.name,
        score,
      });
    }
  }

  // --- Commands (name + description) ---
  for (const c of commands) {
    const score = bestScore(needle, c.name, c.description);
    if (score > 0) {
      hits.push({
        kind: "command",
        name: c.name,
        scope: c.scope,
        file: c.filePath,
        snippet: c.description ? previewOf(c.description, LINE_SNIPPET_MAX) : c.name,
        score,
      });
    }
  }

  // --- MCP servers (name + command + args). They live inside ~/.claude.json, so the file
  //     is that config file (global) — there's no standalone per-server file. ---
  const claudeJson = path.join(claudeConfigDir(), ".claude.json"); // best-effort label only
  for (const m of mcpServers) {
    const score = bestScore(needle, m.name, m.command, m.args.join(" "), m.type);
    if (score > 0) {
      const cmd = [m.command, ...m.args].filter(Boolean).join(" ");
      hits.push({
        kind: "mcp",
        name: m.name,
        scope: m.scope,
        file: null, // entry is a key inside ~/.claude.json, not a standalone file
        snippet: cmd || m.type || m.name,
        score,
      });
    }
  }
  void claudeJson; // documented intent above; not surfaced as a file path

  // --- Settings keys (match on KEY name only; show a value preview as the snippet). The
  //     contributing settings.json files are in settings.sources (lowest precedence first;
  //     the last is the highest, so we attribute project-scoped when a project file fed it). ---
  const settingsFile = settings.sources.length > 0 ? settings.sources[settings.sources.length - 1]! : null;
  const settingsScope: ConfigScope = projectCwd && settings.sources.length > 1 ? "project" : "global";
  // settings.permissions/hooks are derived views; the raw per-key map isn't returned by
  // readSettings, but the merged permissions + hooks keys ARE the user-facing knobs. We
  // surface permission LIST entries and hook EVENTS below; here we expose the permission
  // sub-keys (allow/deny/ask) as searchable settings keys when they hold entries.
  for (const permKey of ["allow", "deny", "ask"] as const) {
    const list = settings.permissions[permKey];
    if (list.length === 0) continue;
    const keyName = `permissions.${permKey}`;
    // Match the key name OR any rule inside the list (e.g. "Bash(npm:*)").
    const score = bestScore(needle, keyName, ...list);
    if (score > 0) {
      hits.push({
        kind: "setting",
        name: keyName,
        scope: settingsScope,
        file: settingsFile,
        snippet: valuePreview(list),
        score,
      });
    }
  }

  // --- Hooks (match the event name; snippet counts the configured entries). ---
  for (const [event, entries] of Object.entries(settings.hooks)) {
    const score = scoreMatch(event, needle);
    if (score > 0) {
      hits.push({
        kind: "hook",
        name: event,
        scope: settingsScope,
        file: settingsFile,
        snippet: `${entries.length} hook${entries.length === 1 ? "" : "s"} on ${event}`,
        score,
      });
    }
  }

  // --- CLAUDE.md (search the CONTENT line by line; surface the best-matching line). ---
  for (const doc of [globalMd, projectMd]) {
    if (!doc) continue;
    let bestLineScore = 0;
    let bestLine = "";
    for (const rawLine of doc.content.split("\n")) {
      const line = rawLine.trim();
      if (!line) continue;
      const s = scoreMatch(line, needle);
      if (s > bestLineScore) {
        bestLineScore = s;
        bestLine = line;
      }
    }
    if (bestLineScore > 0) {
      hits.push({
        kind: "claudeMd",
        name: "CLAUDE.md",
        scope: doc.scope,
        file: doc.filePath,
        snippet: previewOf(bestLine, LINE_SNIPPET_MAX),
        score: bestLineScore,
      });
    }
  }

  // Stable ranking: score desc, then kind asc, then name asc.
  hits.sort(
    (a, b) =>
      b.score - a.score ||
      a.kind.localeCompare(b.kind) ||
      a.name.localeCompare(b.name) ||
      a.scope.localeCompare(b.scope),
  );

  return hits.slice(0, limit);
}
