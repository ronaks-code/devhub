/**
 * The PURE parse phase of indexing one session transcript — shared by the main
 * thread (index-db.ts) and the optional indexing worker (index-worker.ts).
 *
 * "Pure" here means: it only READS the file and returns parsed accumulators. It does
 * NOT touch the DB, archive, or any shared cache — those stay single-writer on the
 * main thread. Extracting this keeps the worker path byte-for-byte identical to the
 * synchronous path (one source of truth, no divergence to drift out of sync).
 *
 * The scan is byte-offset INCREMENTAL: pass the prior accumulators as a `seed` plus
 * `startByte` to continue from where a previous pass stopped (transcripts are
 * append-only), or seed from zero for a full re-index.
 */
import { streamRawLines, usageFromMessage, isCommandOrMetaPrompt } from "./parser.js";
import type { TokenUsage } from "./types.js";
import { EMPTY_USAGE } from "./types.js";

/** Max characters of renderable text we mirror per message into the search store. */
export const MAX_SEARCH_TEXT = 4000;
/** Max characters of a tool_result body we mirror into the search store. */
export const MAX_TOOL_RESULT_TEXT = 2000;

/** One row of renderable text mirrored into the search store for a session. */
export interface SearchText {
  role: "user" | "assistant" | "tool";
  seq: number;
  text: string;
  /** Tool name for role="tool" rows (the invoked tool, or the tool a result belongs to). */
  toolName: string | null;
}

/**
 * One tool invocation harvested for the `tool_calls` analytics sidecar (index-db.ts).
 *
 * Unlike the search mirror (which the FTS layout pins to a fixed five columns), this is
 * a REGULAR table, so we can persist the two signals the mirror can't: whether the call
 * FAILED (`tool_result.is_error`) and HOW LONG it took (the timestamp delta between the
 * tool_use line and its matching tool_result line). Both degrade to null when the
 * transcript doesn't carry them, so toolStats reports real numbers without fabricating.
 *
 * One row per assistant `tool_use` block. `seq` is the same message seq the search rows
 * use (so a re-index reproduces the SAME identity); `ordinal` disambiguates several
 * tool_use blocks in one assistant message (0,1,2,… in transcript order). `isError`/
 * `durationMs` are filled in once the matching tool_result is seen (by tool_use_id), and
 * stay null if no result (or no usable timestamp) ever pairs with it.
 */
export interface ToolCall {
  /** The message seq of the assistant turn that emitted this tool_use. */
  seq: number;
  /** 0-based position of this tool_use among tool_use blocks at the same seq. */
  ordinal: number;
  /** The invoked tool's name (e.g. "Bash", "Edit", an MCP tool id). */
  toolName: string;
  /** ISO timestamp of the tool_use's transcript line, or null when the line had none. */
  ts: string | null;
  /** 1 when the matching tool_result was flagged is_error; 0 otherwise. */
  isError: number;
  /** Wall-clock ms from tool_use line to its matching tool_result line, when both have a ts. */
  durationMs: number | null;
}

/** Pull a non-empty `message.model` string off an assistant transcript line, or null. */
export function messageModel(message: unknown): string | null {
  const m =
    message && typeof message === "object" && !Array.isArray(message)
      ? (message as Record<string, unknown>)
      : undefined;
  const mdl = m?.model;
  return typeof mdl === "string" && mdl.trim() ? mdl.trim() : null;
}

/** Read a string field off an arbitrary block object, trimmed and non-empty, or null. */
function blockStr(b: Record<string, unknown>, key: string): string | null {
  const v = b[key];
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** Map a tool_use block to "<ToolName>: <key input>" for search (one compact line). */
function toolUseLine(name: string, input: unknown): string | null {
  const io =
    input && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : undefined;
  const pick = (key: string): string | null => (io ? blockStr(io, key) : null);

  let detail: string | null = null;
  switch (name) {
    case "Bash":
      detail = pick("command");
      break;
    case "Edit":
    case "Write":
    case "MultiEdit":
    case "NotebookEdit":
      detail = pick("file_path") ?? pick("notebook_path");
      break;
    case "Read":
      detail = pick("file_path") ?? pick("path");
      break;
    case "Glob":
    case "Grep":
      detail = pick("pattern") ?? pick("path");
      break;
    default:
      // Unknown tool: a short JSON of its input so the args are still searchable.
      if (io) {
        try {
          detail = JSON.stringify(io);
        } catch {
          detail = null;
        }
      }
      break;
  }

  const line = detail ? `${name}: ${detail}` : name;
  const trimmed = line.trim();
  return trimmed ? trimmed.slice(0, MAX_SEARCH_TEXT) : null;
}

/**
 * Harvest tool I/O text from one message for search.
 * - assistant tool_use blocks -> "<ToolName>: <key input>" (role="tool", toolName set).
 * - user tool_result blocks    -> the (capped) result body (role="tool", toolName null).
 * Pushes a SearchText per block; the caller assigns/advances `seq`.
 */
export function toolTexts(type: string, message: unknown, seq: number): SearchText[] {
  const m =
    message && typeof message === "object" && !Array.isArray(message)
      ? (message as Record<string, unknown>)
      : undefined;
  const content = m?.content;
  if (!Array.isArray(content)) return [];

  const out: SearchText[] = [];
  for (const raw of content) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const b = raw as Record<string, unknown>;

    if (type === "assistant" && b.type === "tool_use") {
      const name = blockStr(b, "name") ?? "Tool";
      const line = toolUseLine(name, b.input);
      if (line) out.push({ role: "tool", seq, text: line, toolName: name });
    } else if (type === "user" && b.type === "tool_result") {
      const text = toolResultText(b.content);
      if (text) out.push({ role: "tool", seq, text, toolName: null });
    }
  }
  return out;
}

/**
 * Harvest tool invocations + results from one message for the `tool_calls` sidecar.
 * - assistant tool_use blocks  -> a partial {@link ToolCall} (toolName/seq/ordinal/ts,
 *   keyed by the block's tool_use id so its result can be paired later).
 * - user tool_result blocks     -> a `{ id, isError }` pairing (matched by tool_use_id).
 * Mirrors {@link toolTexts}'s block walk; returns nothing for messages without tool blocks.
 */
export function toolCallBlocks(
  type: string,
  message: unknown,
  seq: number,
  ts: string | null,
): { uses: Array<{ id: string | null } & ToolCall>; results: Array<{ id: string; isError: number }> } {
  const m =
    message && typeof message === "object" && !Array.isArray(message)
      ? (message as Record<string, unknown>)
      : undefined;
  const content = m?.content;
  const uses: Array<{ id: string | null } & ToolCall> = [];
  const results: Array<{ id: string; isError: number }> = [];
  if (!Array.isArray(content)) return { uses, results };

  let ordinal = 0;
  for (const raw of content) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const b = raw as Record<string, unknown>;
    if (type === "assistant" && b.type === "tool_use") {
      const name = blockStr(b, "name") ?? "Tool";
      const id = blockStr(b, "id");
      uses.push({ id, seq, ordinal: ordinal++, toolName: name, ts, isError: 0, durationMs: null });
    } else if (type === "user" && b.type === "tool_result") {
      const id = blockStr(b, "tool_use_id");
      if (id) results.push({ id, isError: b.is_error === true ? 1 : 0 });
    }
  }
  return { uses, results };
}

/** Flatten a tool_result `content` (string or block array) to a capped plain string. */
function toolResultText(content: unknown): string | null {
  let s: string;
  if (typeof content === "string") {
    s = content;
  } else if (Array.isArray(content)) {
    s = content
      .map((b) => {
        if (!b || typeof b !== "object" || Array.isArray(b)) return "";
        const bo = b as Record<string, unknown>;
        if (bo.type === "text" && typeof bo.text === "string") return bo.text;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  } else {
    return null;
  }
  const t = s.trim();
  return t ? t.slice(0, MAX_TOOL_RESULT_TEXT) : null;
}

/**
 * Pull the human-readable text out of a user/assistant transcript line for search.
 * - assistant: concatenate `text` blocks (skip thinking/tool_use/tool_result noise).
 * - user: only plain string content, and only when it isn't a command/meta wrapper.
 * Returns the (trimmed, capped) text or null when there's nothing worth indexing.
 */
export function renderableText(type: string, message: unknown): string | null {
  const m =
    message && typeof message === "object" && !Array.isArray(message)
      ? (message as Record<string, unknown>)
      : undefined;
  const content = m?.content;

  if (type === "assistant") {
    if (!Array.isArray(content)) return null;
    const parts: string[] = [];
    for (const b of content) {
      if (b && typeof b === "object" && (b as Record<string, unknown>).type === "text") {
        const t = (b as Record<string, unknown>).text;
        if (typeof t === "string" && t.trim()) parts.push(t);
      }
    }
    const joined = parts.join("\n").trim();
    return joined ? joined.slice(0, MAX_SEARCH_TEXT) : null;
  }

  if (type === "user") {
    if (typeof content !== "string") return null;
    const t = content.trim();
    if (!t || isCommandOrMetaPrompt(content)) return null;
    return t.slice(0, MAX_SEARCH_TEXT);
  }

  return null;
}

/**
 * Incremental seed: the accumulators carried over from a prior pass when continuing
 * from `startByte > 0`. All-zero/null for a full re-index (startByte === 0).
 */
export interface ScanSeed {
  messageCount: number;
  usage: TokenUsage;
  cwd: string | null;
  gitBranch: string | null;
  firstTs: string | null;
  lastTs: string | null;
  /** The already-stored model (preferred on a tie so an incremental pass doesn't flip). */
  incumbentModel: string | null;
  /** seq to assign to the first new search row (continues after prior messageCount). */
  startSeq: number;
  /**
   * Tool invocations carried forward from a prior pass (incremental append). A
   * tool_use seen in an earlier pass whose tool_result arrives in the appended tail can
   * still be paired here. Empty for a full scan; the caller seeds it from the prior
   * pass's accumulated rows on an incremental one.
   */
  toolCalls?: ToolCall[];
}

/** Everything the parse phase produces from scanning a transcript's bytes. */
export interface ScanResult {
  messageCount: number;
  usage: TokenUsage;
  cwd: string | null;
  gitBranch: string | null;
  firstTs: string | null;
  lastTs: string | null;
  /** How often each assistant model id was seen (seeded with the incumbent at 1). */
  modelCounts: Array<[string, number]>;
  /** The last assistant model seen (the incumbent when none seen). */
  lastModel: string | null;
  /** Last `ai-title` line seen (the latest wins), or null. */
  aiTitle: string | null;
  /** First `summary` line seen, or null. */
  summary: string | null;
  /** First real user prompt (skipping command/meta wrappers), capped to 120 chars. */
  firstPrompt: string | null;
  /** Mirrored renderable text rows for the search store. */
  searchTexts: SearchText[];
  /**
   * One row per assistant tool_use for the `tool_calls` analytics sidecar, each paired
   * (by tool_use id) with its tool_result's is_error + the timestamp-delta duration when
   * both lines carried a ts. On an incremental pass this includes the carried-forward
   * tool calls from the seed (so re-writing the session keeps the full set in lockstep
   * with the search rows).
   */
  toolCalls: ToolCall[];
}

/** Build a zero/null seed for a FULL scan (startByte === 0). */
export function emptySeed(): ScanSeed {
  return {
    messageCount: 0,
    usage: { ...EMPTY_USAGE },
    cwd: null,
    gitBranch: null,
    firstTs: null,
    lastTs: null,
    incumbentModel: null,
    startSeq: 0,
  };
}

/**
 * Scan a transcript from `startByte`, folding each line into the `seed` accumulators,
 * and return the parsed {@link ScanResult}. Reads the file ONLY — no DB, no archive,
 * no cache. Title/model RESOLUTION (picking the winning model, choosing a title
 * source) is left to the caller, which already owns that policy.
 */
export async function scanSession(
  filePath: string,
  startByte: number,
  seed: ScanSeed,
): Promise<ScanResult> {
  let messageCount = seed.messageCount;
  const usage: TokenUsage = { ...seed.usage };
  let cwd = seed.cwd;
  let gitBranch = seed.gitBranch;
  let firstTs = seed.firstTs;
  let lastTs = seed.lastTs;

  const modelCounts = new Map<string, number>();
  const incumbentModel = seed.incumbentModel;
  let lastModel: string | null = incumbentModel;
  if (incumbentModel) modelCounts.set(incumbentModel, 1);

  let aiTitle: string | null = null;
  let summary: string | null = null;
  let firstPrompt: string | null = null;

  const searchTexts: SearchText[] = [];
  let searchSeq = seed.startSeq;

  // tool_calls accumulation: every assistant tool_use becomes a ToolCall, paired with
  // its tool_result (by tool_use id) for is_error + a timestamp-delta duration. Carried
  // forward on an incremental pass so a result appended after its tool_use still pairs.
  const toolCalls: ToolCall[] = seed.toolCalls ? [...seed.toolCalls] : [];
  // Pending tool_use rows still awaiting their result THIS pass, keyed by tool_use id.
  // The id isn't persisted on a ToolCall (it's only needed within a pass to pair a result
  // to its use, and a tool_use + its result are virtually always in the same incremental
  // window), so carried-forward calls aren't re-keyed here: an unpaired call simply stays
  // null — the same graceful degradation toolStats already tolerates.
  const pendingByUseId = new Map<string, ToolCall>();

  for await (const raw of streamRawLines(filePath, { startByte })) {
    const type = typeof raw.type === "string" ? raw.type : "";
    const ts = typeof raw.timestamp === "string" ? raw.timestamp : null;
    if (ts) {
      if (!firstTs) firstTs = ts;
      lastTs = ts;
    }
    if (!cwd && typeof raw.cwd === "string") cwd = raw.cwd;
    if (gitBranch === null && typeof raw.gitBranch === "string") gitBranch = raw.gitBranch;
    if (type === "user" || type === "assistant") {
      messageCount++;
      const text = renderableText(type, raw.message);
      if (text) {
        searchTexts.push({ role: type, seq: searchSeq, text, toolName: null });
      }
      // Mirror tool I/O (assistant tool_use lines + user tool_result bodies) so
      // search covers what tools were run and what they returned. Same message
      // seq; counting/usage below is unchanged.
      for (const tt of toolTexts(type, raw.message, searchSeq)) {
        searchTexts.push(tt);
      }
      // Sidecar tool_calls: record each tool_use (pending its result), and complete any
      // pending call whose tool_result is seen here (set is_error + a duration when both
      // timestamps exist). Same `seq` as the search rows for a stable shared identity.
      const { uses, results } = toolCallBlocks(type, raw.message, searchSeq, ts);
      for (const u of uses) {
        const { id, ...call } = u;
        toolCalls.push(call);
        if (id) pendingByUseId.set(id, call);
      }
      for (const r of results) {
        const call = pendingByUseId.get(r.id);
        if (!call) continue;
        pendingByUseId.delete(r.id);
        call.isError = r.isError;
        // Duration only when BOTH the tool_use line and this result line carry a ts;
        // a non-negative delta guards against clock skew / out-of-order lines.
        if (call.ts && ts) {
          const d = Date.parse(ts) - Date.parse(call.ts);
          if (Number.isFinite(d) && d >= 0) call.durationMs = d;
        }
      }
      searchSeq++;
    }
    if (type === "assistant") {
      const u = usageFromMessage(raw.message);
      if (u) {
        usage.inputTokens += u.inputTokens;
        usage.outputTokens += u.outputTokens;
        usage.cacheReadTokens += u.cacheReadTokens;
        usage.cacheCreationTokens += u.cacheCreationTokens;
      }
      const mdl = messageModel(raw.message);
      if (mdl) {
        modelCounts.set(mdl, (modelCounts.get(mdl) ?? 0) + 1);
        lastModel = mdl;
      }
    }
    if (type === "ai-title" && typeof raw.aiTitle === "string") aiTitle = raw.aiTitle;
    if (type === "summary" && typeof raw.summary === "string") summary = raw.summary;
    if (!firstPrompt && type === "user") {
      const content = (raw.message as Record<string, unknown> | undefined)?.content;
      if (
        typeof content === "string" &&
        content.trim() &&
        raw.isMeta !== true &&
        !isCommandOrMetaPrompt(content)
      ) {
        firstPrompt = content.trim().slice(0, 120);
      }
    }
  }

  return {
    messageCount,
    usage,
    cwd,
    gitBranch,
    firstTs,
    lastTs,
    // Serialize the Map as entries so it survives a structured-clone hop to a worker.
    modelCounts: [...modelCounts.entries()],
    lastModel,
    aiTitle,
    summary,
    firstPrompt,
    searchTexts,
    toolCalls,
  };
}
