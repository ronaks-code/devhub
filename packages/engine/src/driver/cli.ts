/**
 * CLI-subprocess driver. Spawns `claude -p --output-format stream-json` per turn,
 * inheriting the user's local login (no API key). Reuses the M1 parser to normalize
 * assistant/user lines, so the chat UI renders identically to the history viewer.
 */
import { spawn } from "node:child_process";
import { normalizeLine, usageFromMessage } from "../parser.js";
import type {
  AgentDriver,
  RunningTurn,
  SessionInit,
  TurnHandlers,
  TurnRequest,
  TurnResult,
} from "./types.js";

const CLAUDE_BIN = process.env.CLAUDE_UI_CLAUDE_BIN?.trim() || "claude";

export class CliDriver implements AgentDriver {
  runTurn(req: TurnRequest, handlers: TurnHandlers): RunningTurn {
    const args = ["-p", req.prompt, "--output-format", "stream-json", "--verbose"];
    // Stream partial tokens by default; opt out only when explicitly disabled.
    const includePartial = req.includePartial !== false;
    if (includePartial) args.push("--include-partial-messages");
    if (req.sessionId) args.push("--resume", req.sessionId);
    if (req.model) args.push("--model", req.model);
    args.push("--permission-mode", req.permissionMode ?? "acceptEdits");

    const child = spawn(CLAUDE_BIN, args, {
      cwd: req.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });

    let sessionId: string | null = req.sessionId ?? null;
    let seq = 0;
    let finalResult: TurnResult | null = null;
    let stderr = "";

    const handleLine = (line: string): void => {
      const s = line.trim();
      if (!s) return;
      let m: Record<string, unknown>;
      try {
        m = JSON.parse(s) as Record<string, unknown>;
      } catch {
        return;
      }
      const t = m.type as string | undefined;

      if (t === "system") {
        if (m.subtype === "init") {
          sessionId = (m.session_id as string) ?? sessionId;
          const init: SessionInit = {
            sessionId: sessionId ?? "",
            model: (m.model as string) ?? null,
            cwd: (m.cwd as string) ?? null,
            tools: Array.isArray(m.tools) ? (m.tools as string[]) : [],
            permissionMode: (m.permissionMode as string) ?? null,
            slashCommands: Array.isArray(m.slash_commands) ? (m.slash_commands as string[]) : [],
          };
          if (sessionId) handlers.onSession?.(sessionId, init);
        } else {
          handlers.onStatus?.({ kind: (m.subtype as string) ?? "system" });
        }
      } else if (t === "stream_event") {
        // Partial-message frames from --include-partial-messages. Emit text-token
        // deltas only; ignore message_start/stop, content_block_start/stop,
        // message_delta, thinking_delta, signature_delta, etc. The final full
        // "assistant" message still arrives below and is emitted via onMessage.
        const event = m.event as Record<string, unknown> | undefined;
        if (event && event.type === "content_block_delta") {
          const delta = event.delta as Record<string, unknown> | undefined;
          if (delta && delta.type === "text_delta" && typeof delta.text === "string") {
            handlers.onDelta?.(delta.text);
          }
        }
      } else if (t === "assistant" || t === "user") {
        const norm = normalizeLine(m, seq);
        if (norm) {
          seq += 1;
          handlers.onMessage?.(norm);
        }
      } else if (t === "result") {
        const usageObj = m.usage as Record<string, unknown> | undefined;
        finalResult = {
          sessionId: (m.session_id as string) ?? sessionId,
          subtype: (m.subtype as string) ?? "unknown",
          isError: m.is_error === true,
          costUsd: typeof m.total_cost_usd === "number" ? m.total_cost_usd : 0,
          usage: usageObj ? usageFromMessage({ usage: usageObj }) : undefined,
          denials: Array.isArray(m.permission_denials)
            ? (m.permission_denials as Array<Record<string, unknown>>).map((d) => ({
                toolName: (d.tool_name as string) ?? "tool",
                toolInput: d.tool_input,
              }))
            : [],
          resultText: typeof m.result === "string" ? m.result : undefined,
        };
        handlers.onResult?.(finalResult);
      }
    };

    const done = new Promise<TurnResult | null>((resolve) => {
      let buf = "";
      child.stdout.on("data", (d: Buffer) => {
        buf += d.toString();
        let i: number;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          handleLine(line);
        }
      });
      child.stderr.on("data", (d: Buffer) => {
        stderr += d.toString();
      });
      child.on("error", (e) => {
        handlers.onError?.(e.message);
        resolve(null);
      });
      child.on("close", (code) => {
        if (buf.trim()) handleLine(buf);
        if (!finalResult && code !== 0) {
          handlers.onError?.(stderr.trim() || `claude exited with code ${code}`);
        }
        resolve(finalResult);
      });
    });

    return {
      interrupt() {
        child.kill("SIGTERM");
      },
      done,
    };
  }
}

let singleton: CliDriver | null = null;
export function createDriver(): AgentDriver {
  if (!singleton) singleton = new CliDriver();
  return singleton;
}
