/**
 * Heuristic severity classifier for tool calls the agent is about to run.
 *
 * Pure, dependency-free, and framework-agnostic (no Node imports) so any face can
 * import it directly. Given a tool name and its raw `input`, it returns a coarse
 * risk band plus a short human reason:
 *
 *   - "dangerous"  irreversible / destructive / remote-code-exec shaped commands
 *                  (rm -rf /, git push --force, curl | sh, sudo, DROP DATABASE, …).
 *   - "caution"    edits/writes, network fetches, package installs, chmod, mv/cp —
 *                  things worth a glance before approving.
 *   - "safe"       read-only or otherwise low-impact (Read/Grep/Glob, `ls`, `git status`).
 *
 * This is a DISPLAY/triage signal, not a security boundary. It is intentionally
 * conservative (prefers to flag) and string-based; it can have false positives and
 * must never be the only thing standing between a user and a destructive action.
 */

/** Coarse risk band for a tool call. */
export type CommandSeverity = "safe" | "caution" | "dangerous";

/** A classification result: the band plus a short, human-readable reason. */
export interface CommandClassification {
  severity: CommandSeverity;
  /** One short phrase explaining the band (e.g. "recursive force remove"). */
  reason: string;
}

/** Tools that only read/observe — inherently safe regardless of input. */
const READ_ONLY_TOOLS = new Set([
  "Read",
  "Glob",
  "Grep",
  "NotebookRead",
  "WebFetch",
  "WebSearch",
  "TodoWrite",
  "TodoRead",
  "ListMcpResourcesTool",
  "ReadMcpResourceTool",
]);

/** Tools that modify files/notebooks — never destructive on their own, but worth a glance. */
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

/** Pull a string field off the tool input object, or null. */
function inputStr(input: unknown, key: string): string | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const v = (input as Record<string, unknown>)[key];
  return typeof v === "string" ? v : null;
}

/**
 * Ordered DANGEROUS patterns for shell command text. First match wins, so its
 * reason is the one surfaced. Each entry is a regex over the raw command string and
 * a short reason. Patterns are deliberately broad (favor flagging).
 */
const DANGEROUS_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  // rm -rf and friends (recursive force delete). Catches -rf, -fr, -r -f, --recursive --force.
  { re: /\brm\b[^\n|;&]*(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r|--recursive\b[^\n|;&]*--force|--force\b[^\n|;&]*--recursive)/i, reason: "recursive force delete (rm -rf)" },
  // rm targeting a root-ish / very broad path.
  { re: /\brm\b[^\n|;&]*\s(\/|~|\$HOME|\.\.)(\s|$|\/)/i, reason: "remove of a root/home/parent path" },
  // Piping a remote download straight into a shell: curl … | sh / wget … | bash.
  { re: /\b(curl|wget|fetch)\b[^\n|]*\|\s*(sudo\s+)?(sh|bash|zsh|python[0-9.]*|node|perl|ruby)\b/i, reason: "pipe remote script into a shell (curl | sh)" },
  // Privilege escalation.
  { re: /\bsudo\b/i, reason: "runs with sudo (elevated privileges)" },
  { re: /\bsu\s+(-|root)\b/i, reason: "switches to the root user" },
  // Force-push rewrites remote history.
  { re: /\bgit\s+push\b[^\n|;&]*(--force\b|-f\b|--force-with-lease\b)/i, reason: "force-push rewrites remote history" },
  // Other history-destroying git ops.
  { re: /\bgit\s+reset\b[^\n|;&]*--hard\b/i, reason: "git reset --hard discards working changes" },
  { re: /\bgit\s+clean\b[^\n|;&]*-[a-z]*f/i, reason: "git clean -f deletes untracked files" },
  // Dropping databases / truncating tables (SQL or CLI flavors).
  { re: /\bdrop\s+(database|schema|table)\b/i, reason: "drops a database/table" },
  { re: /\btruncate\s+table\b/i, reason: "truncates a table" },
  { re: /\b(dropdb|mongo(sh)?\b[^\n]*\bdropDatabase|redis-cli\b[^\n]*\bflushall)/i, reason: "destroys database contents" },
  // Wide-open permissions.
  { re: /\bchmod\b[^\n|;&]*\b(-R\s+)?0?777\b/i, reason: "chmod 777 (world-writable permissions)" },
  // Disk-level destruction.
  { re: /\b(mkfs(\.[a-z0-9]+)?|fdisk|dd)\b[^\n]*\bof=\/dev\//i, reason: "writes directly to a block device" },
  { re: /\bdd\b[^\n]*\bof=\/dev\/(disk|sd|nvme|hd)/i, reason: "dd overwrites a disk device" },
  { re: /\bmkfs(\.[a-z0-9]+)?\b/i, reason: "formats a filesystem" },
  // Fork bomb.
  { re: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;/, reason: "fork bomb" },
  // Kill everything.
  { re: /\bkillall\b|\bkill\s+-9\s+-1\b|\bpkill\b\s+-9/i, reason: "force-kills processes broadly" },
  // Overwriting a critical system file via redirect.
  { re: />\s*\/(etc|dev|sys|proc|boot)\//i, reason: "overwrites a system path" },
];

/**
 * Ordered CAUTION patterns for shell command text. Checked only after the dangerous
 * set has passed. First match wins.
 */
const CAUTION_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  // Any non-recursive remove / move that can still lose data.
  { re: /\brm\b/i, reason: "removes files" },
  { re: /\b(mv|cp)\b/i, reason: "moves/copies files" },
  // Package installs / global tooling changes.
  { re: /\b(npm|pnpm|yarn|bun)\s+(install|add|i|remove|rm|uninstall|up|update)\b/i, reason: "changes installed packages" },
  { re: /\b(pip[0-9.]*|pipx)\s+(install|uninstall)\b/i, reason: "changes Python packages" },
  { re: /\b(brew|apt(-get)?|apk|yum|dnf|pacman)\s+(install|remove|uninstall|upgrade|update)\b/i, reason: "changes system packages" },
  // Network fetches (not piped to a shell — that's caught as dangerous above).
  { re: /\b(curl|wget|fetch)\b/i, reason: "fetches from the network" },
  // Permission / ownership changes (non-777 land here).
  { re: /\b(chmod|chown|chgrp)\b/i, reason: "changes file permissions/ownership" },
  // Writing to a file via redirect.
  { re: />>?\s*\S/, reason: "writes output to a file" },
  // Git operations that change state (commit/push/checkout/merge/rebase).
  { re: /\bgit\s+(push|commit|merge|rebase|checkout|switch|stash\s+drop|branch\s+-D)\b/i, reason: "changes git state" },
  // Moving/renaming via git.
  { re: /\bgit\s+rm\b/i, reason: "git rm removes tracked files" },
];

/**
 * Classify a single tool call into a severity band with a short reason.
 *
 * @param toolName  The invoked tool (e.g. "Bash", "Read", "Edit"). Case-sensitive
 *                  to match Claude's tool names; unknown tools fall back to input
 *                  heuristics / a neutral "caution".
 * @param input     The tool's raw input object (shape varies per tool).
 */
export function classifyCommand(toolName: string, input: unknown): CommandClassification {
  // Read-only tools are safe no matter what they're pointed at.
  if (READ_ONLY_TOOLS.has(toolName)) {
    return { severity: "safe", reason: "read-only operation" };
  }

  // File-mutating tools: caution. Flag a write that escapes the obvious project
  // tree (absolute path into a system dir, or a parent-relative `..` path).
  if (WRITE_TOOLS.has(toolName)) {
    const target = inputStr(input, "file_path") ?? inputStr(input, "notebook_path") ?? inputStr(input, "path");
    if (target && isSensitiveWritePath(target)) {
      return { severity: "dangerous", reason: "writes outside the project (system/parent path)" };
    }
    return { severity: "caution", reason: "modifies a file" };
  }

  // Shell commands carry the real risk: scan the command string.
  if (toolName === "Bash" || toolName === "BashOutput") {
    const cmd = inputStr(input, "command");
    if (!cmd || !cmd.trim()) return { severity: "safe", reason: "empty command" };
    return classifyShell(cmd);
  }

  // Unknown / MCP / other tools: neutral caution (we can't reason about effects).
  return { severity: "caution", reason: "unrecognized tool" };
}

/**
 * Classify a raw shell command string. Dangerous patterns win over caution; if
 * nothing matches and the command looks read-only, it's safe.
 */
export function classifyShell(command: string): CommandClassification {
  const cmd = command.trim();
  for (const { re, reason } of DANGEROUS_PATTERNS) {
    if (re.test(cmd)) return { severity: "dangerous", reason };
  }
  for (const { re, reason } of CAUTION_PATTERNS) {
    if (re.test(cmd)) return { severity: "caution", reason };
  }
  if (isReadOnlyShell(cmd)) return { severity: "safe", reason: "read-only command" };
  // Anything else that runs a shell command we don't recognize: low-key caution.
  return { severity: "caution", reason: "runs a shell command" };
}

/** A small allowlist of inspect-only shell heads (first word of each chained part). */
const READ_ONLY_HEADS = new Set([
  "ls", "cat", "pwd", "echo", "head", "tail", "less", "more", "stat", "file",
  "wc", "which", "whoami", "date", "env", "printenv", "uname", "df", "du",
  "find", "grep", "rg", "fd", "tree", "diff", "sort", "uniq", "cut", "awk", "sed",
  "ps", "top", "id", "groups", "hostname",
]);

/** Git subcommands that only read repo state. */
const READ_ONLY_GIT = new Set(["status", "log", "diff", "show", "branch", "remote", "config", "blame", "describe", "rev-parse", "ls-files", "shortlog", "tag"]);

/**
 * True when every `;`/`&&`/`||`/`|`-separated segment of `cmd` begins with a
 * known read-only head (and a bare `git` segment uses a read-only subcommand).
 * Conservative: any unrecognized segment makes the whole thing non-read-only.
 */
function isReadOnlyShell(cmd: string): boolean {
  const segments = cmd.split(/\s*(?:\|\||&&|\||;)\s*/).map((s) => s.trim()).filter(Boolean);
  if (segments.length === 0) return false;
  for (const seg of segments) {
    const parts = seg.split(/\s+/);
    const head = parts[0] ?? "";
    if (head === "git") {
      const sub = parts[1] ?? "";
      if (!READ_ONLY_GIT.has(sub)) return false;
      continue;
    }
    if (!READ_ONLY_HEADS.has(head)) return false;
  }
  return true;
}

/**
 * True when a write target path looks like it escapes the project tree: an absolute
 * path into a system directory, a home-config path, or a parent-relative `..` path.
 * A relative or plainly-in-tree path is fine (caution, not dangerous).
 */
function isSensitiveWritePath(p: string): boolean {
  const t = p.trim();
  if (!t) return false;
  // Parent-relative escape.
  if (/(^|\/)\.\.(\/|$)/.test(t)) return true;
  // Absolute paths into well-known system / config locations.
  if (/^\/(etc|usr|bin|sbin|var|boot|sys|proc|dev|lib|opt|System|Library|Applications)(\/|$)/.test(t)) {
    return true;
  }
  // Home dotfiles / shell rc / ssh keys (e.g. ~/.ssh/…, /Users/x/.bashrc).
  if (/(^~|\/)\.(ssh|aws|gnupg|kube|docker|bash_profile|bashrc|zshrc|profile|gitconfig|npmrc)(\/|$)/.test(t)) {
    return true;
  }
  return false;
}
