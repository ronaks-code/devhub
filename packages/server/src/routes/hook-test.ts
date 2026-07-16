/**
 * Hook dry-run: POST /api/hooks/test { cwd?, event, command, input? }
 *
 * Runs a single hook `command` the way Claude Code would — the hook receives a
 * JSON event payload on STDIN and may print to stdout/stderr and exit non-zero.
 * We synthesize that payload from `event` (+ any caller-supplied `input` fields),
 * spawn the command, and return `{ exitCode, stdout, stderr, timedOut }`. This is
 * a *test* surface: it lets the config UI try a hook before it's saved to a
 * settings.json, so the user can see what it would print / whether it blocks.
 *
 * SECURITY — cwd allowlist: when a `cwd` is given it must EXACTLY match a known
 * project's cwd (archived included); an unknown cwd is a 400, so we never run a
 * hook in an arbitrary host directory. With no `cwd` the hook runs in a neutral
 * temp dir (os.tmpdir()), never the server's own working directory.
 *
 * HOW IT RUNS: hook commands in Claude Code are shell snippets (e.g.
 * `jq -r '.tool_input.command'` or a script path with args), so we spawn through
 * the user's shell with `-c` — matching how the runtime invokes them. The env is
 * `process.env` overlaid with the `env` block from the layered settings.json
 * files (global first, then project — project wins), so a hook that expects a
 * configured variable sees it. A short timeout + SIGKILL caps a runaway hook, and
 * we cap captured output so a chatty hook can't balloon the response.
 */
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import os from "node:os";
import type { FastifyInstance } from "fastify";
import type { Engine } from "@devhub/engine";
import { config } from "@devhub/engine";

/** Hook events we'll synthesize a payload for. Mirrors Claude Code's hook events. */
const HOOK_EVENTS = [
  "PreToolUse",
  "PostToolUse",
  "UserPromptSubmit",
  "Notification",
  "Stop",
  "SubagentStop",
  "PreCompact",
  "SessionStart",
  "SessionEnd",
] as const;

type HookEvent = (typeof HOOK_EVENTS)[number];

/** Body schema: `event` + `command` required; `cwd` + `input` optional. */
const hookTestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["event", "command"],
  properties: {
    cwd: { type: "string", minLength: 1 },
    event: { type: "string", enum: [...HOOK_EVENTS] },
    command: { type: "string", minLength: 1, maxLength: 8192 },
    // Extra fields merged into the synthetic payload (e.g. tool_name, tool_input,
    // prompt). Free-form so the caller can shape a realistic event for their hook.
    input: { type: "object", additionalProperties: true },
  },
} as const;

interface HookTestBody {
  cwd?: string;
  event: HookEvent;
  command: string;
  input?: Record<string, unknown>;
}

/** Wall-clock cap on a single hook run before we SIGKILL it. */
const HOOK_TIMEOUT_MS = 10_000;
/** Cap on captured stdout/stderr so a chatty hook can't balloon the response. */
const MAX_CAPTURE_BYTES = 256 * 1024;

interface HookRunResult {
  exitCode: number | null;
  /** Signal that killed the process (e.g. "SIGKILL" on timeout), or null. */
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * Build the JSON payload a hook reads from stdin. We always include the event
 * name, a `cwd`, and a synthetic `session_id`; the caller's `input` fields are
 * spread on top so they can override / extend (e.g. supply a `tool_name` +
 * `tool_input` for a PreToolUse test). The keys mirror Claude Code's hook input
 * shape closely enough for a realistic dry run.
 */
function buildPayload(event: HookEvent, cwd: string, input?: Record<string, unknown>): string {
  const base: Record<string, unknown> = {
    session_id: "hook-test",
    transcript_path: "",
    cwd,
    hook_event_name: event,
  };
  return JSON.stringify({ ...base, ...input });
}

/**
 * Read the merged `env` block from the layered settings.json files (global first,
 * then project — project wins). We reuse the engine's `readSettings` ONLY for its
 * authoritative list of source files, then parse the `env` object out of each (the
 * layered reader itself doesn't surface `env`). Non-string values are skipped.
 */
async function readSettingsEnv(cwd?: string): Promise<Record<string, string>> {
  const layered = await config.readSettings(cwd);
  const env: Record<string, string> = {};
  for (const file of layered.sources) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(file, "utf8"));
    } catch {
      continue; // missing/corrupt — skip; readSettings tolerated it too
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    const block = (parsed as Record<string, unknown>).env;
    if (!block || typeof block !== "object" || Array.isArray(block)) continue;
    for (const [k, v] of Object.entries(block as Record<string, unknown>)) {
      if (typeof v === "string") env[k] = v;
    }
  }
  return env;
}

/**
 * Spawn `command` through the shell with the event payload on stdin. NEVER rejects:
 * a non-zero exit, a spawn error, or a timeout all resolve to a typed result. Output
 * is capped at {@link MAX_CAPTURE_BYTES} per stream.
 */
function runHook(
  command: string,
  payload: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<HookRunResult> {
  return new Promise((resolve) => {
    const shell = process.env.SHELL || "/bin/sh";
    let child;
    try {
      child = spawn(shell, ["-c", command], {
        cwd,
        env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (err) {
      resolve({
        exitCode: null,
        signal: null,
        stdout: "",
        stderr: err instanceof Error ? err.message : String(err),
        timedOut: false,
      });
      return;
    }

    let out = "";
    let errOut = "";
    let timedOut = false;
    let settled = false;

    const append = (buf: string, chunk: Buffer): string =>
      buf.length >= MAX_CAPTURE_BYTES
        ? buf
        : (buf + chunk.toString("utf8")).slice(0, MAX_CAPTURE_BYTES);

    child.stdout?.on("data", (c: Buffer) => {
      out = append(out, c);
    });
    child.stderr?.on("data", (c: Buffer) => {
      errOut = append(errOut, c);
    });

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }, HOOK_TIMEOUT_MS);

    const finish = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode, signal, stdout: out, stderr: errOut, timedOut });
    };

    child.on("error", (err) => {
      // Spawn-time failure (e.g. shell not found): surface as stderr, no exit code.
      errOut = append(errOut, Buffer.from(String(err instanceof Error ? err.message : err)));
      finish(null, null);
    });
    child.on("close", (code, signal) => finish(code, signal));

    // Feed the synthetic event on stdin, then close it so a hook that reads to EOF
    // (e.g. a `jq` filter) doesn't hang waiting for more input.
    try {
      child.stdin?.write(payload);
      child.stdin?.end();
    } catch {
      /* stdin may already be closed if the child exited instantly */
    }
  });
}

/** Wire POST /api/hooks/test onto an app, backed by the engine for the cwd allowlist. */
export function registerHookTestRoutes(app: FastifyInstance, engine: Engine): void {
  /** True when `cwd` is a known project path (archived projects included). */
  const isKnownCwd = (cwd: string): boolean =>
    engine.getProjects({ includeArchived: true }).some((p) => p.cwd === cwd);

  app.post<{ Body: HookTestBody }>(
    "/api/hooks/test",
    { schema: { body: hookTestSchema } },
    async (req, reply) => {
      const { cwd, event, command, input } = req.body;

      // cwd allowlist: a given cwd must be a known project; with none we run in a
      // neutral temp dir, never the server's own working directory.
      if (cwd !== undefined && !isKnownCwd(cwd)) {
        return reply.code(400).send({ error: "unknown cwd" });
      }
      const runDir = cwd ?? os.tmpdir();

      const settingsEnv = await readSettingsEnv(cwd);
      const env: NodeJS.ProcessEnv = { ...process.env, ...settingsEnv };

      const payload = buildPayload(event, runDir, input);
      const result = await runHook(command, payload, runDir, env);

      return {
        ok: result.exitCode === 0 && !result.timedOut,
        exitCode: result.exitCode,
        signal: result.signal,
        stdout: result.stdout,
        stderr: result.stderr,
        timedOut: result.timedOut,
      };
    },
  );
}
