/**
 * Client-side approximation of Claude Code's permission-rule matching, for the
 * PermissionsEditor's "tester" (does rule X match a tool call Y(input)?).
 *
 * This is a BEST-EFFORT mirror of the documented rule grammar, not the engine's
 * authoritative matcher (which we can't import — it's server-side). It's clearly
 * labeled "approximate" in the UI; the goal is a fast sanity check while editing
 * rules, not enforcement. Rules read:
 *
 *   Tool                      — matches any call to that tool, any input
 *   Tool(pattern)             — matches that tool when the input matches `pattern`
 *
 * The pattern is matched against a tool-specific "specifier" string:
 *   - Bash:  the command string (rules use a `prefix:*` convention, e.g.
 *            `Bash(git status:*)` ⇒ commands starting with "git status").
 *   - Read/Edit/Write/etc: the file path (glob with * and **).
 *   - everything else: the raw input coerced to a string, glob-matched.
 *
 * `*` matches within a path segment, `**` matches across segments, and a trailing
 * `:*` on a Bash rule means "this command prefix, then anything".
 */

/** A parsed permission rule: the tool name + an optional inner pattern. */
export interface ParsedRule {
  tool: string;
  /** The inner matcher, or null for a bare `Tool` rule (matches any input). */
  pattern: string | null;
}

/** Parse `Tool` or `Tool(pattern)` into its parts. Returns null when malformed. */
export function parseRule(rule: string): ParsedRule | null {
  const trimmed = rule.trim();
  if (!trimmed) return null;
  const open = trimmed.indexOf("(");
  if (open === -1) {
    // Bare tool name, e.g. "Bash".
    return /^[A-Za-z0-9_-]+$/.test(trimmed) ? { tool: trimmed, pattern: null } : null;
  }
  if (!trimmed.endsWith(")")) return null;
  const tool = trimmed.slice(0, open).trim();
  if (!/^[A-Za-z0-9_-]+$/.test(tool)) return null;
  const pattern = trimmed.slice(open + 1, -1);
  return { tool, pattern };
}

/** Escape a string for safe literal use inside a RegExp. */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Compile a glob-ish pattern (supporting `*` and `**`) to a RegExp anchored to
 * the whole string. `**` matches any characters (including `/`); a single `*`
 * matches any run of non-separator characters. A literal trailing `:*` (the Bash
 * "prefix then anything" convention) collapses to "rest is anything".
 */
function globToRe(pattern: string): RegExp {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        re += ".*";
        i++;
        // Swallow a trailing slash after ** so "src/**" matches "src/a/b".
        if (pattern[i + 1] === "/") i++;
      } else {
        re += "[^/]*";
      }
    } else {
      re += escapeRe(c);
    }
  }
  return new RegExp(`^${re}$`);
}

/**
 * Pull the tool-specific "specifier" out of a tool input — the string a rule's
 * pattern is matched against. Mirrors how Claude Code keys its rules: Bash on the
 * command, file tools on the path, otherwise a coerced string.
 */
export function specifierFor(tool: string, input: unknown): string {
  if (input == null) return "";
  if (typeof input === "string") return input;
  if (typeof input !== "object") return String(input);
  const o = input as Record<string, unknown>;
  if (tool === "Bash") {
    return typeof o.command === "string" ? o.command : "";
  }
  // File-oriented tools key on the path.
  const path = o.file_path ?? o.filePath ?? o.path ?? o.notebook_path ?? o.notebookPath;
  if (typeof path === "string") return path;
  // Fall back to a stable JSON for anything else.
  try {
    return JSON.stringify(o);
  } catch {
    return String(o);
  }
}

/**
 * Does `rule` match a call to `tool` with `specifier` (already extracted via
 * {@link specifierFor})? Tool names must match exactly. A bare-tool rule matches
 * any input. A Bash `prefix:*` pattern matches when the command starts with the
 * prefix. Otherwise the pattern is glob-matched against the specifier.
 */
export function ruleMatches(rule: ParsedRule, tool: string, specifier: string): boolean {
  if (rule.tool !== tool) return false;
  if (rule.pattern == null || rule.pattern === "" || rule.pattern === "*") return true;

  // Bash's "prefix:*" convention: everything before the final ":*" is a literal
  // command prefix the actual command must start with.
  if (tool === "Bash" && rule.pattern.endsWith(":*")) {
    const prefix = rule.pattern.slice(0, -2);
    return specifier === prefix || specifier.startsWith(prefix);
  }

  try {
    return globToRe(rule.pattern).test(specifier);
  } catch {
    return false;
  }
}

/**
 * Evaluate which bucket wins for a tool call, given the three rule lists, using
 * Claude Code's precedence: DENY beats ASK beats ALLOW; "default" when nothing
 * matches. Returns the decision plus the first matching rule string per bucket
 * (for explaining the result in the tester UI).
 */
export interface MatchOutcome {
  decision: "deny" | "ask" | "allow" | "default";
  matched: { allow: string | null; ask: string | null; deny: string | null };
}

export function evaluate(
  perms: { allow: string[]; ask: string[]; deny: string[] },
  tool: string,
  input: unknown,
): MatchOutcome {
  const specifier = specifierFor(tool, input);
  const firstMatch = (rules: string[]): string | null => {
    for (const r of rules) {
      const parsed = parseRule(r);
      if (parsed && ruleMatches(parsed, tool, specifier)) return r;
    }
    return null;
  };
  const matched = {
    deny: firstMatch(perms.deny),
    ask: firstMatch(perms.ask),
    allow: firstMatch(perms.allow),
  };
  const decision: MatchOutcome["decision"] = matched.deny
    ? "deny"
    : matched.ask
      ? "ask"
      : matched.allow
        ? "allow"
        : "default";
  return { decision, matched };
}
