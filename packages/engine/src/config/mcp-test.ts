/**
 * Best-effort connectivity test for a configured MCP server.
 *
 * Two transports:
 *  - stdio  — spawn the server's `command`+`args`, send a JSON-RPC `initialize`
 *             request on stdin, and wait (briefly) for a well-formed response. A
 *             clean `initialize` result is the strongest signal; if the process
 *             merely starts and stays alive past the timeout without crashing, we
 *             still report ok (some servers don't speak until a tool is called).
 *  - http/sse — a reachability probe of the configured `url` (fetch with a short
 *             timeout). Any HTTP response — even 4xx — proves the endpoint is up;
 *             only a network-level failure / timeout counts as unreachable.
 *
 * This NEVER touches transcripts and only reads the server definition the caller
 * passes in. It spawns the user's own configured command (same one Claude Code
 * would run), so it carries no more risk than launching the server normally.
 */
import { spawn } from "node:child_process";
import type { McpServerDef } from "./index.js";

/** Outcome of a server test: ok + latency, or a human-readable error. */
export interface McpTestResult {
  ok: boolean;
  /** Round-trip / startup time in ms (best-effort), when we got far enough to time it. */
  latencyMs?: number;
  /** Why the test failed (empty/absent on success). */
  error?: string;
}

/** Default time budget for the whole probe (handshake or reachability). */
const DEFAULT_TIMEOUT_MS = 5000;

/** The JSON-RPC `initialize` request we send to an stdio server. */
function initializeRequest(): string {
  return (
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "claude-ui", version: "0.0.1" },
      },
    }) + "\n"
  );
}

/**
 * Test one MCP server definition. `opts.timeoutMs` bounds the whole probe.
 * Dispatches on transport: stdio servers get a spawn + handshake; http/sse servers
 * get a reachability check. Resolves (never rejects) with an {@link McpTestResult}.
 */
export async function testMcpServer(
  def: McpServerDef,
  opts: { timeoutMs?: number } = {},
): Promise<McpTestResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const type = (def.type ?? "stdio").toLowerCase();

  if (type === "http" || type === "sse") {
    const url = typeof def.raw.url === "string" ? def.raw.url : null;
    if (!url) return { ok: false, error: `${type} server has no url` };
    return testHttp(url, timeoutMs);
  }

  // Default / explicit stdio.
  if (!def.command || !def.command.trim()) {
    return { ok: false, error: "stdio server has no command" };
  }
  return testStdio(def, timeoutMs);
}

/**
 * Reachability probe for an http/sse endpoint. Any HTTP status (incl. 4xx/5xx)
 * means the endpoint is up — we're checking connectivity, not authorization. Only
 * a network error or the timeout firing counts as unreachable.
 */
async function testHttp(url: string, timeoutMs: number): Promise<McpTestResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    await fetch(url, { method: "GET", signal: controller.signal });
    return { ok: true, latencyMs: Date.now() - started };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const reason = controller.signal.aborted ? `timed out after ${timeoutMs}ms` : msg;
    return { ok: false, latencyMs: Date.now() - started, error: reason };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Spawn an stdio server and attempt a JSON-RPC `initialize` handshake. Resolves ok
 * on a valid `initialize` response (with latency). If the process stays alive to the
 * timeout without crashing, we still resolve ok (a server that simply doesn't reply
 * before being asked to do work). A non-zero early exit or spawn error fails the test.
 */
function testStdio(def: McpServerDef, timeoutMs: number): Promise<McpTestResult> {
  return new Promise<McpTestResult>((resolve) => {
    const started = Date.now();
    let settled = false;
    const env: NodeJS.ProcessEnv = { ...process.env };
    const rawEnv = def.raw.env;
    if (rawEnv && typeof rawEnv === "object" && !Array.isArray(rawEnv)) {
      for (const [k, v] of Object.entries(rawEnv as Record<string, unknown>)) {
        if (typeof v === "string") env[k] = v;
      }
    }

    let child;
    try {
      child = spawn(def.command!, def.args, {
        stdio: ["pipe", "pipe", "pipe"],
        env,
      });
    } catch (err) {
      resolve({ ok: false, error: err instanceof Error ? err.message : String(err) });
      return;
    }

    const finish = (result: McpTestResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Tear the process down — we only wanted to probe it.
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      resolve(result);
    };

    // If we get a clean initialize response, we're done. Tolerate partial/multi-line
    // stdout (a server may interleave logs); parse each complete line as JSON-RPC.
    let buffer = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line) as Record<string, unknown>;
          if (msg && msg.id === 1 && ("result" in msg || "error" in msg)) {
            if ("error" in msg && msg.error) {
              const e = msg.error as Record<string, unknown>;
              finish({ ok: false, latencyMs: Date.now() - started, error: String(e.message ?? "initialize error") });
            } else {
              finish({ ok: true, latencyMs: Date.now() - started });
            }
            return;
          }
        } catch {
          // Not JSON (a log line) — ignore and keep reading.
        }
      }
    });

    child.on("error", (err) => {
      finish({ ok: false, error: err instanceof Error ? err.message : String(err) });
    });

    child.on("exit", (code, signal) => {
      // A clean handshake already finishes us; a SIGKILL is our own teardown.
      if (settled || signal === "SIGKILL") return;
      if (code === 0) {
        // Exited cleanly before replying — treat as started-ok (best-effort).
        finish({ ok: true, latencyMs: Date.now() - started });
      } else {
        finish({ ok: false, error: `process exited with code ${code ?? "null"} (signal ${signal ?? "none"})` });
      }
    });

    // Kick off the handshake.
    try {
      child.stdin?.write(initializeRequest());
    } catch {
      /* server closed stdin already; the timeout / exit handler will resolve */
    }

    // Timeout: a still-running server that never replied is reported ok (it started),
    // since some servers stay quiet until asked to do real work.
    const timer = setTimeout(() => {
      finish({ ok: true, latencyMs: Date.now() - started });
    }, timeoutMs);
  });
}
