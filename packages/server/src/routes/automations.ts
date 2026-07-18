/**
 * Scheduled Jobs / Automations dashboard: GET /api/automations
 *
 * Plain words: this is the "what's on cron/launchd, and is it healthy?" board.
 * Every machine in the fleet (M5 = this DevHub host, M1 = the OpenClaw host)
 * runs a handful of `launchd` automations — nightly gbrain maintenance, team
 * updates, MCP process reaping, and so on. Nobody remembers all of them, and
 * launchd itself has no notion of "what is this job FOR" — so this endpoint
 * runs `gen-jobs-registry` (packages/server/scripts/gen-jobs-registry.mjs) on
 * each host and merges the results with a human-purpose seed file.
 *
 * RESILIENCE (mirrors health.ts): M1 is reached over `ssh`, which can fail for
 * reasons that have nothing to do with the jobs themselves — Tailscale down,
 * M1 asleep, the generator not installed there yet. Any of that degrades the
 * M1 group to `{ reachable: false, jobs: [] }` rather than 500ing the whole
 * response; M5's own jobs (always locally reachable) still render.
 *
 * CACHING: `gen-jobs-registry` shells out to `launchctl print` per job, which
 * is not free, and `ssh` to M1 adds real round-trip latency. A dashboard tab
 * that auto-refreshes should not pay that cost every poll, so results are
 * cached for CACHE_MS and served stale-until-refetch.
 */
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import type { Engine } from "@devhub/engine";

/** One job record, as emitted by gen-jobs-registry.mjs. Kept in lockstep with
 * that script's `buildJob()` output shape. */
export interface AutomationJob {
  id: string;
  host: string;
  schedule_human: string | null;
  next_run: string | null;
  last_run: string | null;
  last_exit_status: number | null;
  status: "active" | "enabled" | "staged" | "failed" | string;
  purpose: string;
  owner: string | null;
  log_path: string | null;
  program: string | null;
}

export interface AutomationsGroup {
  /** Short host label the UI groups by ("M5" / "M1"), not the raw hostname. */
  host: "M5" | "M1";
  reachable: boolean;
  jobs: AutomationJob[];
  /** Best-effort reason the group is unreachable (ssh error, timeout, etc). */
  error?: string;
}

export interface AutomationsResponse {
  ok: true;
  groups: AutomationsGroup[];
  generatedAt: string;
}

/** How long to serve a cached result before re-running the generators. */
const CACHE_MS = 45_000;
/** Cap on both the local generator and the ssh round-trip to M1 — a hung ssh
 * (asleep host, dead tunnel) must not hang the dashboard. */
const PROBE_TIMEOUT_MS = 8_000;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GENERATOR_SCRIPT = path.resolve(HERE, "..", "..", "scripts", "gen-jobs-registry.mjs");

/** M1's Tailscale address (see the [[m1-tailscale-ip-corrected]] project note —
 * this is the current live IP; the host was previously reachable at a
 * now-dead address). */
const M1_HOST = "ronak@100.81.240.38";

let cache: { at: number; response: AutomationsResponse } | null = null;

/** Run a command with a hard timeout, returning parsed JSON on success or
 * `{ ok: false, error }` on any failure (non-zero exit, timeout, bad JSON).
 * Never throws — every caller treats a failure as "this host is unreachable
 * right now," not a fatal error. */
function runJson(
  cmd: string,
  args: string[],
): Promise<{ ok: true; jobs: AutomationJob[] } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { timeout: PROBE_TIMEOUT_MS, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const reason = err.killed ? "timed out" : stderr?.trim() || err.message;
          resolve({ ok: false, error: reason });
          return;
        }
        try {
          const jobs = JSON.parse(stdout) as AutomationJob[];
          resolve({ ok: true, jobs });
        } catch {
          resolve({ ok: false, error: "malformed generator output" });
        }
      },
    );
  });
}

/** M5's own jobs: run the generator script in-process (no ssh needed — this
 * IS the M5 host). Falls back to an empty, unreachable-flagged group on
 * failure so a broken generator degrades the dashboard, not crashes it. */
async function fetchM5(): Promise<AutomationsGroup> {
  const result = await runJson("node", [GENERATOR_SCRIPT]);
  if (!result.ok) {
    return { host: "M5", reachable: false, jobs: [], error: result.error };
  }
  return { host: "M5", reachable: true, jobs: result.jobs };
}

/**
 * M1's jobs: ssh over and run the same generator by name (installed at
 * `~/.local/bin/gen-jobs-registry` on M1 — NOT installed yet as of this
 * writing, which is a known deferred step, not a bug here). Any ssh failure
 * — unreachable host, missing binary, asleep machine — degrades to an
 * unreachable group; it never blocks M5's group from rendering.
 */
async function fetchM1(): Promise<AutomationsGroup> {
  const result = await runJson("ssh", [
    "-o",
    "ConnectTimeout=5",
    "-o",
    "BatchMode=yes",
    M1_HOST,
    "gen-jobs-registry",
  ]);
  if (!result.ok) {
    return { host: "M1", reachable: false, jobs: [], error: result.error };
  }
  return { host: "M1", reachable: true, jobs: result.jobs };
}

async function buildResponse(): Promise<AutomationsResponse> {
  const [m5, m1] = await Promise.all([fetchM5(), fetchM1()]);
  return { ok: true, groups: [m5, m1], generatedAt: new Date().toISOString() };
}

/** Wire GET /api/automations onto an app. `engine` is accepted (unused) to
 * keep this route's signature consistent with the rest of routes/*.ts, which
 * are all registered as `register*Routes(app, engine)`. */
export function registerAutomationsRoutes(app: FastifyInstance, _engine: Engine): void {
  app.get("/api/automations", async () => {
    const now = Date.now();
    if (cache && now - cache.at < CACHE_MS) {
      return cache.response;
    }
    const response = await buildResponse();
    cache = { at: now, response };
    return response;
  });
}
