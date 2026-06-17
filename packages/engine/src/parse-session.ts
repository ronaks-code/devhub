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
  };
}
