/**
 * OPTIONAL off-thread parse phase for indexing, behind `CLAUDE_UI_INDEX_WORKER`.
 *
 * Why: parsing a multi-hundred-MB transcript (JSON.parse per line + text extraction)
 * is CPU-bound and blocks the event loop. Moving JUST the parse/scan to a worker
 * thread keeps the main thread responsive while a big backlog indexes.
 *
 * Hard rules (so behavior is identical and safe):
 *  - DEFAULT IS OFF. {@link workerScanEnabled} reads the env each call; when unset
 *    the synchronous in-process {@link scanSession} is used and nothing here runs.
 *  - SINGLE WRITER. The worker only READS the file and returns parsed rows; it never
 *    opens the DB. The main thread does every DB write + cache invalidation, so the
 *    aggregate cache can never go stale behind a second writer.
 *  - IDENTICAL OUTPUT. The worker runs the SAME {@link scanSession} as the main
 *    thread (one source of truth), so the parsed result is byte-for-byte the same.
 *  - GRACEFUL FALLBACK. Any worker failure (spawn error, crash, message error)
 *    rejects the call; the caller falls back to the synchronous scan, so a broken
 *    worker can never lose an index pass.
 *
 * This module is dual-role: imported as a CLIENT (the pool below) on the main thread,
 * and executed as the WORKER ENTRY when spawned (the `parentPort` branch at the end).
 */
import { Worker, isMainThread, parentPort } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { scanSession } from "./parse-session.js";
import type { ScanSeed, ScanResult } from "./parse-session.js";

/** Env flag (default OFF) that opts into the worker-thread parse path. */
export const INDEX_WORKER_ENV = "CLAUDE_UI_INDEX_WORKER";

/** True when the worker path is enabled. Read live so tests/runtime can toggle it. */
export function workerScanEnabled(): boolean {
  const v = process.env[INDEX_WORKER_ENV];
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/** Request sent to the worker: scan `filePath` from `startByte` with this seed. */
interface ScanRequest {
  filePath: string;
  startByte: number;
  seed: ScanSeed;
}

/** Worker reply: either the parsed result or a stringified error. */
type ScanReply = { ok: true; result: ScanResult } | { ok: false; error: string };

/**
 * A lazily-spawned, REUSED worker that runs scans serially. One long-lived worker
 * (not one-per-file) avoids per-file spawn cost; serial use keeps the protocol a
 * simple request/reply with no id bookkeeping. Created on first use so importing
 * this module is free when the worker path is off.
 */
class ScanWorkerPool {
  private worker: Worker | null = null;
  /** Resolves the in-flight scan's reply; null when idle. */
  private pending: ((reply: ScanReply) => void) | null = null;
  /** Serializes calls so one worker handles one scan at a time. */
  private queue: Promise<unknown> = Promise.resolve();

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    // Point the Worker at THIS module's URL; the `parentPort` branch below is its entry.
    // Inherit the parent's execArgv so a TS-aware loader (e.g. tsx's `--import`) carries
    // into the worker — that lets a `.ts` entry run in dev. In a compiled build the entry
    // is plain `.js` and needs no loader. If the worker can't load (no loader, missing
    // file), it errors and the caller falls back to the synchronous scan.
    const w = new Worker(fileURLToPath(import.meta.url), { execArgv: process.execArgv });
    w.on("message", (reply: ScanReply) => {
      const resolve = this.pending;
      this.pending = null;
      resolve?.(reply);
    });
    // On a fatal worker error/exit, reject any in-flight call and drop the worker so
    // the next call respawns. The caller treats a rejection as "fall back to sync".
    w.on("error", (err) => {
      const resolve = this.pending;
      this.pending = null;
      this.worker = null;
      resolve?.({ ok: false, error: err.message });
    });
    w.on("exit", () => {
      const resolve = this.pending;
      this.pending = null;
      this.worker = null;
      resolve?.({ ok: false, error: "index worker exited" });
    });
    // Idle the worker un-ref'd so it never blocks process exit; scan() ref()s it for
    // the duration of an in-flight request so an awaited scan keeps the loop alive.
    w.unref();
    this.worker = w;
    return w;
  }

  /** Run one scan on the worker; rejects on any worker failure (caller falls back). */
  scan(req: ScanRequest): Promise<ScanResult> {
    // Chain onto the queue so scans run one at a time over the single worker.
    const run = this.queue.then(
      () =>
        new Promise<ScanResult>((resolve, reject) => {
          const w = this.ensureWorker();
          // Hold the event loop open while THIS scan is in flight (constructor un-ref'd
          // it); re-unref when the reply lands so an idle worker doesn't block exit.
          w.ref();
          this.pending = (reply) => {
            w.unref();
            if (reply.ok) resolve(reply.result);
            else reject(new Error(reply.error));
          };
          w.postMessage(req);
        }),
    );
    // Keep the queue alive regardless of this call's outcome.
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Terminate the worker (if any). Safe to call when idle. */
  async close(): Promise<void> {
    const w = this.worker;
    this.worker = null;
    this.pending = null;
    if (w) await w.terminate();
  }
}

let pool: ScanWorkerPool | null = null;

/**
 * Scan `filePath` on the worker thread, returning the SAME {@link ScanResult} the
 * synchronous path produces. Rejects on any worker failure so the caller can fall
 * back to {@link scanSession} in-process. Only call when {@link workerScanEnabled}.
 */
export function runScanInWorker(
  filePath: string,
  startByte: number,
  seed: ScanSeed,
): Promise<ScanResult> {
  if (!pool) pool = new ScanWorkerPool();
  return pool.scan({ filePath, startByte, seed });
}

/** Tear down the shared worker (used on engine close / in tests). */
export async function closeScanWorker(): Promise<void> {
  if (pool) {
    await pool.close();
    pool = null;
  }
}

// --- Worker entry -----------------------------------------------------------
// When this file is loaded AS a worker (not the main thread), wait for scan requests
// and reply with the parsed result. The worker only reads the file; it never opens
// the DB. A scan/read error is reported back so the main thread falls back to sync.
if (!isMainThread && parentPort) {
  const port = parentPort;
  port.on("message", async (req: ScanRequest) => {
    try {
      const result = await scanSession(req.filePath, req.startByte, req.seed);
      port.postMessage({ ok: true, result } satisfies ScanReply);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      port.postMessage({ ok: false, error: msg } satisfies ScanReply);
    }
  });
}
