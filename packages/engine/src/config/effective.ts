/**
 * The fully-merged EFFECTIVE configuration Claude Code would actually apply for a
 * project — one object a settings UI can render top-to-bottom — built on top of the
 * existing layered readers in this package:
 *
 *   - {@link resolveSettings}  (resolve.ts): per-key scope diff (which scope set what,
 *     who won). We surface that verbatim as `settings`, so every top-level
 *     settings.json key carries its winner + per-scope provenance.
 *   - {@link readSettings}     (index.ts): the MERGED hooks + accumulated permission
 *     lists the runtime applies. We surface those as `hooks` / `permissions`, with
 *     the contributing settings.json paths in `permissions.sources`.
 *   - {@link listAgents} / {@link listSkills} / {@link listCommands} /
 *     {@link listMcpServers}: the discoverable extensions. A project entry of the
 *     same NAME shadows the global one (project precedence), so we report each name
 *     ONCE — the active definition — plus a `shadowedBy` flag when a global was
 *     overridden by a project entry of the same name, and the full list of scopes a
 *     name appeared in (`scopes`) for provenance.
 *
 * This is a READ-ONLY composite view. It does not merge nested structures beyond what
 * the underlying readers already do, and it tolerates a half-configured machine: every
 * underlying reader swallows missing/corrupt files, so this never throws.
 *
 * Use this when a face wants "what is the EFFECTIVE config for project X, and where did
 * each piece come from"; use the individual readers when you only need one slice.
 */
import { resolveSettings } from "./resolve.js";
import type { ResolvedKey, ResolvedScope } from "./resolve.js";
import {
  readSettings,
  listAgents,
  listSkills,
  listCommands,
  listMcpServers,
} from "./index.js";
import type { ConfigScope, PermissionsConfig } from "./index.js";

/**
 * One active extension (agent / skill / command / mcp server), resolved across scopes.
 * `name` is the key we dedupe on; `scope` is where the WINNING definition lives;
 * `scopes` lists every scope the name appeared in (so the UI can show "also defined
 * globally"); `shadowedBy` is set when a lower-precedence (global) definition was
 * overridden by a higher one (project) of the same name.
 */
export interface EffectiveExtension {
  name: string;
  description: string | null;
  /** Scope of the WINNING definition (project beats global). */
  scope: ConfigScope;
  /** Every scope this name was defined in, in precedence order (global first). */
  scopes: ConfigScope[];
  /** Absolute path of the winning definition's file (where it lives). */
  filePath: string | null;
  /** When a project definition overrode a global one of the same name. */
  shadowedBy: ConfigScope | null;
}

/** The full effective config for one project, with provenance throughout. */
export interface EffectiveConfig {
  /** The project working directory this view was resolved for, or null for global-only. */
  projectCwd: string | null;
  /** Settings scope-diff: every top-level settings.json key, with winner + per-scope. */
  settings: ResolvedKey[];
  /** The settings scopes considered (lowest precedence first), with their file paths. */
  settingsScopes: ResolvedScope[];
  /** Merged hooks the runtime applies: event -> entries (later layers win per event). */
  hooks: Record<string, unknown[]>;
  /** Accumulated permission lists across layers + the settings.json files that fed them. */
  permissions: PermissionsConfig & { sources: string[] };
  /** Active agents (project shadows global by name). */
  agents: EffectiveExtension[];
  /** Active skills (project shadows global by name). */
  skills: EffectiveExtension[];
  /** Active slash commands (project shadows global by name). */
  commands: EffectiveExtension[];
  /** Active MCP servers (project shadows global by name). */
  mcpServers: EffectiveExtension[];
}

/** A minimal shape every config-lister entry shares, enough to dedupe by name + scope. */
interface NamedScoped {
  name: string;
  description?: string | null;
  scope: ConfigScope;
  filePath?: string;
}

/** global precedence is LOWER than project; a project entry of the same name wins. */
const SCOPE_RANK: Record<ConfigScope, number> = { global: 0, project: 1 };

/**
 * Dedupe a flat list of scoped, named entries (global first, then project — the order
 * every lister here returns) into the ACTIVE set: one entry per name, the highest-
 * precedence (project) definition winning. Records every scope a name appeared in and
 * flags a project override of a global as `shadowedBy: "project"`. Output is sorted by
 * name for a stable UI.
 */
function resolveActive(entries: NamedScoped[]): EffectiveExtension[] {
  const byName = new Map<string, EffectiveExtension>();
  for (const e of entries) {
    const prev = byName.get(e.name);
    if (!prev) {
      byName.set(e.name, {
        name: e.name,
        description: e.description ?? null,
        scope: e.scope,
        scopes: [e.scope],
        filePath: e.filePath ?? null,
        shadowedBy: null,
      });
      continue;
    }
    // Seen before: track the scope, and let the higher-precedence one win.
    if (!prev.scopes.includes(e.scope)) prev.scopes.push(e.scope);
    if (SCOPE_RANK[e.scope] > SCOPE_RANK[prev.scope]) {
      // A higher-precedence definition overrides: the previous winner is shadowed.
      prev.shadowedBy = e.scope;
      prev.scope = e.scope;
      prev.description = e.description ?? null;
      prev.filePath = e.filePath ?? null;
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Resolve the fully-merged EFFECTIVE config for `projectCwd` — settings (per-key scope
 * diff), merged hooks + permissions, and the active agents/skills/commands/mcp servers
 * — each with provenance. Omit `projectCwd` for a user/global-only view (no project or
 * local scopes are read).
 *
 * Tolerant by construction: every underlying reader swallows missing/corrupt files, so
 * a half-configured machine yields empty slices rather than throwing.
 */
export async function resolveEffectiveConfig(projectCwd?: string): Promise<EffectiveConfig> {
  // Run the independent readers concurrently — none depends on another's output.
  const [resolved, layered, agents, skills, commands, mcpServers] = await Promise.all([
    resolveSettings(projectCwd),
    readSettings(projectCwd),
    listAgents(projectCwd),
    listSkills(projectCwd),
    listCommands(projectCwd),
    listMcpServers(projectCwd),
  ]);

  return {
    projectCwd: projectCwd ?? null,
    settings: resolved.keys,
    settingsScopes: resolved.scopes,
    hooks: layered.hooks,
    permissions: { ...layered.permissions, sources: layered.sources },
    agents: resolveActive(agents),
    skills: resolveActive(skills),
    commands: resolveActive(commands),
    // MCP servers from config/index.ts carry no filePath (they live inside ~/.claude.json),
    // so filePath stays null for them — the scope still records global vs project.
    mcpServers: resolveActive(mcpServers),
  };
}
