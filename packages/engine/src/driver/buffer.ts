/**
 * Bounded line-splitter for child-process stdout.
 *
 * Splits a byte stream into newline-delimited lines, feeding each COMPLETE line to
 * `onLine`. The "pending" buffer (bytes seen since the last newline) is capped: a
 * misbehaving process that emits a multi-megabyte line WITHOUT a newline can no
 * longer grow the buffer without bound and exhaust memory.
 *
 * Behavior for NORMAL lines is byte-for-byte identical to a naive splitter: every
 * complete line (everything up to a `\n`) is delivered untouched, in order.
 *
 * Overflow policy (only triggers on a single oversized partial line): once the
 * pending buffer would exceed `maxBytes`, we stop accumulating and DROP further
 * bytes of that same line until its terminating newline arrives. The truncated
 * prefix (exactly `maxBytes` worth) is still delivered as one line, and `onOverflow`
 * fires once per overflow event so callers can log/observe it. Subsequent lines are
 * unaffected.
 */

/** Default pending-buffer cap: 8 MB. Generous for any real stream-json line. */
export const DEFAULT_MAX_LINE_BYTES = 8 * 1024 * 1024;

export interface LineSplitter {
  /** Feed a chunk of bytes; complete lines are emitted to `onLine`. */
  push: (chunk: Buffer) => void;
  /** Emit any trailing (non-empty, whitespace-trimmed) partial line and reset. */
  flush: () => void;
}

export interface LineSplitterOptions {
  /** Max bytes to retain for a single un-terminated line (default 8 MB). */
  maxBytes?: number;
  /**
   * Called once each time a single line overflows `maxBytes`. `droppedBytes` is the
   * number of bytes discarded for that line (counted up to its terminating newline).
   */
  onOverflow?: (droppedBytes: number) => void;
}

/**
 * Create a bounded line-splitter. `onLine` receives each complete line (newline
 * stripped). See the module docblock for the overflow policy.
 */
export function createLineSplitter(
  onLine: (line: string) => void,
  opts: LineSplitterOptions = {},
): LineSplitter {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_LINE_BYTES;
  const onOverflow = opts.onOverflow;

  // Accumulated text of the current (still-incomplete) line.
  let buf = "";
  // True while we are mid-line and have already hit the cap: drop bytes of THIS
  // line until its newline, then resume normally.
  let overflowing = false;
  // Count of bytes dropped for the current overflowing line (for the callback).
  let dropped = 0;

  return {
    push(chunk: Buffer) {
      let text = chunk.toString();
      // Splice newly arrived text against any pending partial line, emitting every
      // complete line. We scan `text` for newlines so we never materialize a giant
      // combined string when the pending buffer is already in overflow.
      let start = 0;
      while (start <= text.length) {
        const nl = text.indexOf("\n", start);
        if (nl < 0) {
          // No more newlines in this chunk: the remainder extends the current line.
          const rest = text.slice(start);
          if (overflowing) {
            dropped += rest.length; // still dropping this oversized line
          } else if (buf.length + rest.length > maxBytes) {
            // Crossing the cap: keep exactly up to maxBytes, drop the rest, and
            // enter overflow until this line's newline shows up.
            const keep = Math.max(0, maxBytes - buf.length);
            dropped = rest.length - keep;
            buf += rest.slice(0, keep);
            overflowing = true;
          } else {
            buf += rest;
          }
          break;
        }

        // A complete line ends at `nl` (exclusive).
        if (overflowing) {
          // We were dropping an oversized line; account for the dropped tail, emit
          // the truncated prefix we kept, then reset overflow state.
          dropped += nl - start;
          onOverflow?.(dropped);
          onLine(buf);
          buf = "";
          overflowing = false;
          dropped = 0;
        } else {
          const segment = text.slice(start, nl);
          if (buf.length + segment.length > maxBytes) {
            // The line completes but is over the cap: keep maxBytes, report overflow.
            const keep = Math.max(0, maxBytes - buf.length);
            onOverflow?.(segment.length - keep);
            onLine(buf + segment.slice(0, keep));
          } else {
            onLine(buf + segment);
          }
          buf = "";
        }
        start = nl + 1;
      }
    },

    flush() {
      if (overflowing) {
        // Trailing oversized line with no terminating newline: emit the kept prefix.
        onOverflow?.(dropped);
        if (buf.trim()) onLine(buf);
        buf = "";
        overflowing = false;
        dropped = 0;
        return;
      }
      if (buf.trim()) onLine(buf);
      buf = "";
    },
  };
}
