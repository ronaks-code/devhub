/**
 * Branch (fork) a turn into a NEW conversation that inherits an existing session's
 * context.
 *
 * The `claude` CLI already supports this directly: `--fork-session` (verified against
 * `claude --help`: "When resuming, create a new session ID instead of reusing the
 * original (use with --resume or --continue)"). So a fork is just a normal `--resume
 * <sessionId>` turn with `--fork-session` added — the CLI replays the original
 * transcript as context but writes to a FRESH session id, leaving the source session
 * untouched. We surface that fresh id from the init `system` line (the same place a
 * normal turn's session id comes from).
 *
 * This module is the thin, reusable layer on top of the {@link AgentDriver}: it adds
 * the `fork` flag to the turn request and hands back the new session id once known.
 * The driver itself only needs to translate `req.fork` into the CLI flag (see
 * {@link forkCliArgs}); everything else (streaming, normalization, result) is the
 * existing per-turn path, unchanged.
 */
import type { AgentDriver, RunningTurn, TurnHandlers, TurnRequest } from "./types.js";

/**
 * The extra CLI args a forked turn needs, given a turn request. Returns `["--fork-session"]`
 * ONLY when `req.fork` is set AND there is a `sessionId` to fork from (the flag is
 * meaningless without `--resume`, and the CLI ignores it then anyway — we guard so the
 * argv stays clean). Returns `[]` otherwise, so a non-fork turn is byte-for-byte the
 * same command as before. Pure + tiny so the driver can splice it in and tests can
 * assert it directly.
 */
export function forkCliArgs(req: Pick<TurnRequest, "fork" | "sessionId">): string[] {
  return req.fork && req.sessionId ? ["--fork-session"] : [];
}

/** The outcome of a fork: the running turn plus a promise for the NEW session id. */
export interface ForkedTurn extends RunningTurn {
  /**
   * Resolves with the forked conversation's NEW session id once the init `system`
   * line arrives (it differs from the source `sessionId`). Resolves with `null` if the
   * turn ends before any session id was reported (e.g. the spawn failed).
   */
  newSessionId: Promise<string | null>;
}

/**
 * Run a turn that FORKS off an existing session: it inherits `sourceSessionId`'s
 * context but writes to a brand-new session. Equivalent to calling `driver.runTurn`
 * with `{ sessionId: sourceSessionId, fork: true, ... }`, but it also hands you the
 * new session id via {@link ForkedTurn.newSessionId} without you having to wire an
 * `onSession` handler yourself (your own `handlers.onSession`, if any, still fires too).
 *
 * Non-fork behavior is untouched — this only ADDS the fork flag and the id promise; it
 * never changes how a normal turn runs.
 */
export function forkTurn(
  driver: AgentDriver,
  req: TurnRequest & { sessionId: string },
  handlers: TurnHandlers = {},
): ForkedTurn {
  let resolveId: (id: string | null) => void = () => {};
  const newSessionId = new Promise<string | null>((resolve) => {
    resolveId = resolve;
  });
  let captured = false;

  // Wrap onSession to capture the forked id (the first session id reported is the new
  // fork's), while still forwarding to the caller's handler. The init line always
  // carries the resolved id, so this fires exactly once per turn.
  const wrapped: TurnHandlers = {
    ...handlers,
    onSession: (sessionId, init) => {
      if (!captured) {
        captured = true;
        resolveId(sessionId);
      }
      handlers.onSession?.(sessionId, init);
    },
  };

  const running = driver.runTurn({ ...req, fork: true }, wrapped);

  // If the turn ends without ever reporting a session id, resolve the promise with
  // whatever the result carried (or null) so callers awaiting it never hang.
  void running.done.then((result) => {
    if (!captured) {
      captured = true;
      resolveId(result?.sessionId ?? null);
    }
  });

  return {
    interrupt: () => running.interrupt(),
    done: running.done,
    newSessionId,
  };
}
