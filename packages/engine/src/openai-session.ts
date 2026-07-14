/**
 * OpenAI live-chat engine: manages a multi-turn, chat-only session against the
 * OpenAI chat completions API with streaming.
 *
 * Mirrors the pattern in driver/cli.ts but calls OpenAI directly over HTTPS
 * instead of spawning the Claude CLI subprocess.
 */
import { EventEmitter } from "node:events";
import https from "node:https";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type OpenAIModel =
  | "gpt-5.4"
  | "gpt-5.4-mini"
  | "gpt-4.1"
  | "gpt-4.1-mini"
  | "o3"
  | "o4-mini";

export interface OpenAIMessage {
  role: "user" | "assistant" | "tool";
  content: string | null;
  tool_call_id?: string;
  name?: string;
  /** Raw tool_calls array present on assistant messages that invoke tools. */
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
}

export interface OpenAITurn {
  role: "user" | "assistant";
  content: string;
  toolCalls?: Array<{ id: string; name: string; args: string; result?: string }>;
  finishReason?: string;
  inputTokens?: number;
  outputTokens?: number;
  createdAt: string;
}

export interface OpenAISessionOptions {
  model?: OpenAIModel;
  cwd?: string;
  systemPrompt?: string;
}

export type OpenAIEvent =
  | { type: "token"; token: string }
  | { type: "tool_start"; id: string; name: string; args: string }
  | { type: "tool_end"; id: string; result: string; error?: boolean }
  | { type: "turn_done"; turn: OpenAITurn }
  | { type: "error"; message: string };

// ---------------------------------------------------------------------------
// Chat-completion request
// ---------------------------------------------------------------------------

export const DEFAULT_OPENAI_CHAT_SYSTEM_PROMPT =
  "You are a helpful conversational assistant. Answer the user's message directly and concisely.";

export interface OpenAICompletionRequestBody {
  model: OpenAIModel;
  stream: true;
  stream_options: { include_usage: true };
  messages: Array<OpenAIMessage | { role: "system"; content: string }>;
}

/**
 * Test-visible seam for the exact payload sent to OpenAI. Local tools are
 * intentionally absent from both the schema and the default system prompt.
 */
export function buildOpenAICompletionRequestBody(input: {
  model: OpenAIModel;
  messages: OpenAIMessage[];
  systemPrompt?: string;
}): OpenAICompletionRequestBody {
  return {
    model: input.model,
    stream: true,
    stream_options: { include_usage: true },
    messages: [
      {
        role: "system",
        content: input.systemPrompt ?? DEFAULT_OPENAI_CHAT_SYSTEM_PROMPT,
      },
      ...input.messages,
    ],
  };
}

// ---------------------------------------------------------------------------
// OpenAI SSE streaming helpers
// ---------------------------------------------------------------------------

/** A partial tool call being accumulated from streamed deltas. */
interface PendingToolCall {
  id: string;
  name: string;
  args: string; // accumulates argument JSON fragments
}

// ---------------------------------------------------------------------------
// OpenAISession
// ---------------------------------------------------------------------------

export class OpenAISession extends EventEmitter {
  readonly model: OpenAIModel;
  readonly cwd: string;
  /** Auditable capability flag. There is deliberately no option that can enable it. */
  readonly localToolsEnabled = false as const;
  private readonly systemPrompt: string;

  /** Running message history (excludes the system message). */
  messages: OpenAIMessage[] = [];

  /** One controller owns the complete in-flight turn, including any follow-up completion. */
  private inFlightController: AbortController | null = null;

  constructor(opts: OpenAISessionOptions = {}) {
    super();
    this.model = opts.model ?? "gpt-4.1";
    this.cwd = opts.cwd ?? process.cwd();
    this.systemPrompt = opts.systemPrompt ?? DEFAULT_OPENAI_CHAT_SYSTEM_PROMPT;
  }

  /** Abort the current in-flight HTTPS request, if any. */
  stop(): void {
    this.inFlightController?.abort();
  }

  /**
   * Send a user message, stream the response, handle tool calls, and emit events.
   * Loops until OpenAI stops requesting tool calls (finish_reason === "stop").
   */
  async send(userText: string): Promise<void> {
    if (this.inFlightController) {
      throw new Error("OpenAI session is busy");
    }

    const controller = new AbortController();
    this.inFlightController = controller;
    try {
      await this._send(userText, controller.signal);
    } finally {
      if (this.inFlightController === controller) {
        this.inFlightController = null;
      }
    }
  }

  private async _send(userText: string, signal: AbortSignal): Promise<void> {
    // Append the user turn to history.
    this.messages.push({ role: "user", content: userText });

    // Agentic loop: keep going as long as OpenAI returns tool calls.
    while (true) {
      let assistantText = "";
      let finishReason = "";
      let inputTokens: number | undefined;
      let outputTokens: number | undefined;
      const pendingCalls = new Map<number, PendingToolCall>();

      // ---- stream one completion ----
      try {
        await this._streamCompletion(
          (token) => {
            assistantText += token;
            this.emit("event", { type: "token", token } satisfies OpenAIEvent);
          },
          (index, id, name, argsDelta) => {
            let call = pendingCalls.get(index);
            if (!call) {
              call = { id: id ?? "", name: name ?? "", args: "" };
              pendingCalls.set(index, call);
            }
            if (id && !call.id) call.id = id;
            if (name && !call.name) call.name = name;
            if (argsDelta) call.args += argsDelta;
          },
          (reason) => {
            finishReason = reason;
          },
          (inp, out) => {
            inputTokens = inp;
            outputTokens = out;
          },
          signal,
        );
      } catch (err) {
        const msg = (err as Error).message ?? String(err);
        this.emit("event", { type: "error", message: msg } satisfies OpenAIEvent);
        return;
      }

      if (signal.aborted) return;

      const toolCallList = [...pendingCalls.values()];
      const hasToolCalls = toolCallList.length > 0;

      // Build the assistant history entry.
      const assistantMsg: OpenAIMessage = {
        role: "assistant",
        content: assistantText || null,
      };
      if (hasToolCalls) {
        assistantMsg.tool_calls = toolCallList.map((c) => ({
          id: c.id,
          type: "function" as const,
          function: { name: c.name, arguments: c.args },
        }));
      }
      this.messages.push(assistantMsg);

      if (!hasToolCalls) {
        // Terminal turn — emit turn_done and exit the loop.
        const finishedToolCalls: OpenAITurn["toolCalls"] = [];
        const turn: OpenAITurn = {
          role: "assistant",
          content: assistantText,
          toolCalls: finishedToolCalls.length ? finishedToolCalls : undefined,
          finishReason,
          inputTokens,
          outputTokens,
          createdAt: new Date().toISOString(),
        };
        this.emit("event", { type: "turn_done", turn } satisfies OpenAIEvent);
        return;
      }

      // ---- Execute each tool call sequentially and collect results ----
      const toolResults: Array<{ id: string; name: string; args: string; result: string; error: boolean }> = [];

      for (const call of toolCallList) {
        this.emit("event", {
          type: "tool_start",
          id: call.id,
          name: call.name,
          args: call.args,
        } satisfies OpenAIEvent);

        let result = "";
        let isError = false;
        try {
          result = await this._executeTool(call.name, call.args);
        } catch (err) {
          result = `Error: ${(err as Error).message}`;
          isError = true;
        }

        this.emit("event", {
          type: "tool_end",
          id: call.id,
          result,
          error: isError,
        } satisfies OpenAIEvent);

        toolResults.push({ id: call.id, name: call.name, args: call.args, result, error: isError });

        // Append tool result to history so OpenAI gets context.
        this.messages.push({
          role: "tool",
          tool_call_id: call.id,
          name: call.name,
          content: result,
        });
      }

      // Loop back — call OpenAI again with the tool results now in history.
    }
  }

  // ---------------------------------------------------------------------------
  // Private: stream one chat completion request
  // ---------------------------------------------------------------------------

  /**
   * Opens an HTTPS request to OpenAI, parses the SSE stream, and calls the
   * provided callbacks for each event kind. Resolves when the stream ends.
   */
  private _streamCompletion(
    onToken: (token: string) => void,
    onToolDelta: (index: number, id: string | undefined, name: string | undefined, argsDelta: string | undefined) => void,
    onFinishReason: (reason: string) => void,
    onUsage: (input: number, output: number) => void,
    signal: AbortSignal,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new Error("Request aborted by caller"));
        return;
      }

      const key = process.env.OPENAI_KEY;
      if (!key) {
        reject(new Error("OPENAI_KEY environment variable is not set"));
        return;
      }

      const body = JSON.stringify(
        buildOpenAICompletionRequestBody({
          model: this.model,
          systemPrompt: this.systemPrompt,
          messages: this.messages,
        }),
      );

      const options: https.RequestOptions = {
        hostname: "api.openai.com",
        path: "/v1/chat/completions",
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      };

      const req = https.request(options, (res) => {
        if (res.statusCode && res.statusCode >= 400) {
          let errBody = "";
          res.on("data", (c: Buffer) => { errBody += c.toString(); });
          res.on("end", () => {
            reject(new Error(`OpenAI API error ${res.statusCode}: ${errBody.slice(0, 500)}`));
          });
          return;
        }

        let buf = "";

        res.on("data", (chunk: Buffer) => {
          buf += chunk.toString("utf8");

          // Process complete SSE lines.
          let nlIdx: number;
          while ((nlIdx = buf.indexOf("\n")) !== -1) {
            const line = buf.slice(0, nlIdx).trimEnd();
            buf = buf.slice(nlIdx + 1);

            if (!line.startsWith("data: ")) continue;
            const payload = line.slice(6).trim();
            if (payload === "[DONE]") continue;

            let obj: Record<string, unknown>;
            try {
              obj = JSON.parse(payload) as Record<string, unknown>;
            } catch {
              continue;
            }

            // Usage (only on the final chunk when stream_options.include_usage is set)
            if (obj.usage && typeof obj.usage === "object") {
              const u = obj.usage as Record<string, unknown>;
              if (typeof u.prompt_tokens === "number" && typeof u.completion_tokens === "number") {
                onUsage(u.prompt_tokens, u.completion_tokens);
              }
            }

            const choices = obj.choices as Array<Record<string, unknown>> | undefined;
            if (!Array.isArray(choices) || choices.length === 0) continue;

            const choice = choices[0] as Record<string, unknown>;

            // finish_reason
            if (typeof choice.finish_reason === "string" && choice.finish_reason) {
              onFinishReason(choice.finish_reason);
            }

            const delta = choice.delta as Record<string, unknown> | undefined;
            if (!delta) continue;

            // Text token delta
            if (typeof delta.content === "string" && delta.content) {
              onToken(delta.content);
            }

            // Tool call deltas
            if (Array.isArray(delta.tool_calls)) {
              for (const tc of delta.tool_calls as Array<Record<string, unknown>>) {
                const idx = typeof tc.index === "number" ? tc.index : 0;
                const id = typeof tc.id === "string" ? tc.id : undefined;
                const fn = tc.function as Record<string, unknown> | undefined;
                const name = fn && typeof fn.name === "string" ? fn.name : undefined;
                const argsDelta = fn && typeof fn.arguments === "string" ? fn.arguments : undefined;
                onToolDelta(idx, id, name, argsDelta);
              }
            }
          }
        });

        res.on("end", () => resolve());
        res.on("error", reject);
      });

      req.on("error", reject);

      // Wire abort — destroy the request when stop() is called.
      signal.addEventListener("abort", () => {
        req.destroy(new Error("Request aborted by caller"));
      }, { once: true });

      req.write(body);
      req.end();
    });
  }

  // ---------------------------------------------------------------------------
  // Private: reject every unexpected local-tool request
  // ---------------------------------------------------------------------------

  private async _executeTool(name: string, _argsJson: string): Promise<string> {
    throw new Error(`Local tools are disabled for OpenAI Chat; blocked ${name}.`);
  }
}
