/**
 * Live chat screen for the terminal face. Proves the "one brain, many faces"
 * design end-to-end: it drives a real turn IN-PROCESS via the engine's
 * `createDriver().runTurn` — NO HTTP server — and streams the response live:
 *   - onDelta  → appends token-by-token assistant text into the live bubble
 *   - onMessage→ renders tool calls compactly (⚙ name / ↳ result)
 *   - onResult → shows the turn's cost + token usage
 *
 * The prompt input is a minimal controlled field built on Ink's `useInput`
 * (printable chars + backspace + enter), so we add NO new dependency. Esc
 * returns to the browse screens.
 */
import React, { useCallback, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import { createDriver } from "@claude-ui/engine";
import type {
  AgentDriver,
  RunningTurn,
  TurnResult,
} from "@claude-ui/engine/driver";
import type { NormalizedMessage, ProjectSummary } from "@claude-ui/engine/types";

const DEFAULT_MODEL = "claude-haiku-4-5";
const VISIBLE = 14; // transcript window height
const MAX_LINES = 500; // cap the in-memory transcript so a long turn can't grow unbounded

/** One rendered line in the chat log, tagged for coloring. */
type Line =
  | { kind: "you"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "tool"; text: string }
  | { kind: "result"; text: string }
  | { kind: "error"; text: string };

/** Compact one-liner for a tool_use / tool_result block (mirrors the browse view). */
function toolSummary(m: NormalizedMessage): string | null {
  const parts: string[] = [];
  for (const b of m.blocks) {
    if (b.type === "tool_use") parts.push(`⚙ ${b.name}`);
    else if (b.type === "tool_result") parts.push(`↳ ${b.isError ? "error" : "result"}`);
  }
  if (parts.length === 0) return null;
  return parts.join("  ").replace(/\s+/g, " ").slice(0, 120);
}

function fmtCost(usd: number): string {
  if (usd <= 0) return "$0.00";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

export function Chat({
  project,
  onExit,
}: {
  project: ProjectSummary;
  onExit: () => void;
}) {
  const [input, setInput] = useState("");
  const [lines, setLines] = useState<Line[]>([]);
  const [busy, setBusy] = useState(false);
  const [sessionId, setSessionId] = useState<string | undefined>(undefined);

  // Live assistant text accumulates here while a turn streams. We keep the
  // streaming buffer in a ref (avoids a setState per token churning React) and
  // mirror it to state for rendering. -1 means "no live bubble".
  const liveRef = useRef<string>("");
  const driverRef = useRef<AgentDriver | null>(null);
  const turnRef = useRef<RunningTurn | null>(null);
  const [live, setLive] = useState<string | null>(null);

  const push = useCallback((line: Line) => {
    setLines((prev) => {
      const next = prev.length >= MAX_LINES ? prev.slice(prev.length - MAX_LINES + 1) : prev;
      return [...next, line];
    });
  }, []);

  const send = useCallback(
    (prompt: string) => {
      const text = prompt.trim();
      if (!text || busy) return;
      push({ kind: "you", text });
      setInput("");
      setBusy(true);
      liveRef.current = "";
      setLive("");

      const driver = driverRef.current ?? (driverRef.current = createDriver());
      const turn = driver.runTurn(
        {
          cwd: project.cwd,
          prompt: text,
          sessionId,
          model: DEFAULT_MODEL,
          permissionMode: "acceptEdits",
        },
        {
          onSession: (id) => setSessionId(id),
          onDelta: (chunk) => {
            liveRef.current += chunk;
            setLive(liveRef.current);
          },
          onMessage: (m) => {
            // Tool calls render compactly; the assistant's prose already streamed
            // via onDelta, so we don't re-emit text-only assistant messages here.
            const summary = toolSummary(m);
            if (summary) push({ kind: "tool", text: summary });
          },
          onResult: (r: TurnResult) => {
            // Flush the streamed text into a permanent assistant line.
            const finalText = liveRef.current.trim();
            if (finalText) push({ kind: "assistant", text: finalText });
            else if (r.resultText) push({ kind: "assistant", text: r.resultText.trim() });
            liveRef.current = "";
            setLive(null);
            const usage = r.usage;
            const tok = usage
              ? ` · ${usage.inputTokens + usage.outputTokens} tok`
              : "";
            const flag = r.isError ? ` · ${r.subtype}` : "";
            push({ kind: "result", text: `${fmtCost(r.costUsd)}${tok}${flag}` });
            setBusy(false);
            turnRef.current = null;
          },
          onError: (err) => {
            liveRef.current = "";
            setLive(null);
            push({ kind: "error", text: err.slice(0, 200) });
            setBusy(false);
            turnRef.current = null;
          },
        },
      );
      turnRef.current = turn;
    },
    [busy, project.cwd, push, sessionId],
  );

  useInput((char, key) => {
    if (key.escape) {
      // Esc: interrupt an in-flight turn, otherwise leave to browse.
      if (busy && turnRef.current) {
        turnRef.current.interrupt();
        return;
      }
      onExit();
      return;
    }
    if (key.return) {
      send(input);
      return;
    }
    if (key.delete || key.backspace) {
      setInput((s) => s.slice(0, -1));
      return;
    }
    // Ignore other control keys (arrows, ctrl-combos, tab); accept printable text.
    if (char && !key.ctrl && !key.meta) {
      setInput((s) => s + char);
    }
  });

  // Build the visible transcript window (log lines + the streaming live bubble).
  const log: Line[] = live !== null ? [...lines, { kind: "assistant", text: live }] : lines;
  const window = log.slice(Math.max(0, log.length - VISIBLE));

  return (
    <Box flexDirection="column">
      <Text color="cyan" bold>
        Chat · {project.name}
      </Text>
      <Text color="gray">
        {project.cwd} · {DEFAULT_MODEL} · acceptEdits
      </Text>

      <Box flexDirection="column" marginTop={1} minHeight={VISIBLE}>
        {window.length === 0 ? (
          <Text color="gray">Type a message and press ⏎ to chat with Claude.</Text>
        ) : (
          window.map((l, i) => <LogLine key={log.length - window.length + i} line={l} />)
        )}
      </Box>

      <Box marginTop={1}>
        <Text color={busy ? "yellow" : "#d97757"}>{busy ? "… " : "› "}</Text>
        <Text>{input}</Text>
        {!busy && <Text color="gray">▌</Text>}
      </Box>

      <Box marginTop={1}>
        <Text color="gray" dimColor>
          {busy
            ? "streaming… · esc interrupt"
            : "type · ⏎ send · ⌫ delete · esc back"}
        </Text>
      </Box>
    </Box>
  );
}

function LogLine({ line }: { line: Line }) {
  if (line.kind === "you") {
    return (
      <Text wrap="truncate-end">
        <Text color="#d97757" bold>
          You{" "}
        </Text>
        {line.text}
      </Text>
    );
  }
  if (line.kind === "assistant") {
    return (
      <Text wrap="end">
        <Text color="cyan" bold>
          Claude{" "}
        </Text>
        {line.text}
      </Text>
    );
  }
  if (line.kind === "tool") {
    return (
      <Text color="magenta" wrap="truncate-end">
        {"  "}
        {line.text}
      </Text>
    );
  }
  if (line.kind === "error") {
    return (
      <Text color="red" wrap="truncate-end">
        ✗ {line.text}
      </Text>
    );
  }
  // result
  return (
    <Text color="gray" wrap="truncate-end">
      {"  "}✓ {line.text}
    </Text>
  );
}
