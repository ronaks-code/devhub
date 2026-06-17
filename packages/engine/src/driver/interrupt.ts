/**
 * Graceful child-process interrupt: escalate signals instead of a bare SIGTERM.
 *
 * A `claude` turn responds to SIGINT by cleanly stopping the current activity (the
 * same as the user pressing Ctrl-C), which lets it flush/close the transcript. Only
 * if it ignores that do we get heavier-handed:
 *
 *   1. SIGINT immediately            — ask it to stop politely.
 *   2. after `graceMs` (~2s): SIGTERM — if still alive, request termination.
 *   3. after `killMs`  (~1s more): SIGKILL — last resort, force it.
 *
 * The escalation timers are cleared as soon as the process exits, so a process that
 * stops on SIGINT never sees SIGTERM/SIGKILL. The behavior callers depend on (the
 * turn stops) is unchanged; this just stops more cleanly than the old single SIGTERM.
 */

/** A minimal view of the bits of a child process we touch — keeps this testable. */
export interface InterruptibleProcess {
  /** The OS pid, or undefined if the process never spawned. */
  pid?: number;
  /** True once the process has exited (Node's ChildProcess.killed is close enough for guarding). */
  killed?: boolean;
  /** Send a signal; returns false when the process is already gone. */
  kill(signal?: NodeJS.Signals | number): boolean;
  /** Subscribe to lifecycle events; we only use "exit"/"close". */
  once(event: string, listener: (...args: unknown[]) => void): unknown;
}

export interface GracefulInterruptOptions {
  /** Ms to wait after SIGINT before escalating to SIGTERM. Default 2000. */
  graceMs?: number;
  /** Ms to wait after SIGTERM before escalating to SIGKILL. Default 1000. */
  killMs?: number;
  /** Injectable timer fns for deterministic tests (default the globals). */
  setTimeoutFn?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeoutFn?: (handle: ReturnType<typeof setTimeout>) => void;
}

export const DEFAULT_GRACE_MS = 2000;
export const DEFAULT_KILL_MS = 1000;

/**
 * Begin a graceful interrupt of `child`: SIGINT now, then SIGTERM after `graceMs`,
 * then SIGKILL after a further `killMs`, stopping the escalation the moment the
 * process exits. Idempotent-ish and safe on an already-dead process (each `kill`
 * is guarded). Returns a `cancel()` that clears any pending escalation timers — call
 * it if you no longer need to keep escalating (e.g. teardown).
 */
export function gracefulInterrupt(
  child: InterruptibleProcess,
  opts: GracefulInterruptOptions = {},
): () => void {
  const graceMs = opts.graceMs ?? DEFAULT_GRACE_MS;
  const killMs = opts.killMs ?? DEFAULT_KILL_MS;
  const setT = opts.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
  const clearT = opts.clearTimeoutFn ?? ((h) => clearTimeout(h));

  const timers: Array<ReturnType<typeof setTimeout>> = [];
  let done = false;

  const cancel = (): void => {
    done = true;
    for (const t of timers) clearT(t);
    timers.length = 0;
  };

  // Stop escalating as soon as the process is gone (whichever event fires first).
  child.once("exit", cancel);
  child.once("close", cancel);

  /** Send a signal unless we've already stopped or the process is already dead. */
  const send = (signal: NodeJS.Signals): void => {
    if (done || child.killed) return;
    try {
      child.kill(signal);
    } catch {
      // Already exited between our guard and the kill — nothing to do.
    }
  };

  // 1) Ask politely, right now.
  send("SIGINT");

  // 2) Escalate to SIGTERM if it's still alive after the grace period.
  timers.push(
    setT(() => {
      send("SIGTERM");
      // 3) Escalate to SIGKILL after a further window if STILL alive.
      timers.push(setT(() => send("SIGKILL"), killMs));
    }, graceMs),
  );

  return cancel;
}
