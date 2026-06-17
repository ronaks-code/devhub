/**
 * Streaming, tolerant reader for Claude Code transcript .jsonl files.
 *
 * Design constraints (from inspecting real files on disk):
 *  - Files can be HUGE (500MB+/74k lines) — never JSON.parse a whole file; stream lines,
 *    and for the detail view read only a tail window unless the file is small.
 *  - The schema evolves between client versions — read fields defensively, tolerate
 *    unknown `type`s and missing fields (no zod on the hot path; too slow at 74k lines).
 *  - `cwd` MUST be read from inside the file (folder names are lossy).
 *  - `ai-title` lines are appended repeatedly — the LAST one wins.
 *  - Large tool outputs are spilled to <sessionId>/tool-results/<id>.txt.
 */
import { createReadStream } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import path from "node:path";
import type {
  ContentBlock,
  NormalizedMessage,
  SubagentRef,
  TitleSource,
  TokenUsage,
} from "./types.js";
import { EMPTY_USAGE, MAX_INLINE_IMAGE_BYTES } from "./types.js";

// ---------------------------------------------------------------------------
// Low-level line access
// ---------------------------------------------------------------------------

export function safeParse(line: string): Record<string, unknown> | undefined {
  const s = line.trim();
  if (!s || (s[0] !== "{" && s[0] !== "[")) return undefined;
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** Stream parsed line objects from the start of a file (optionally capped). */
export async function* streamRawLines(
  filePath: string,
  opts: { maxLines?: number; startByte?: number } = {},
): AsyncGenerator<Record<string, unknown>> {
  const stream = createReadStream(filePath, {
    encoding: "utf8",
    start: opts.startByte ?? 0,
  });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  let n = 0;
  try {
    for await (const line of rl) {
      const obj = safeParse(line);
      if (!obj) continue;
      yield obj;
      if (opts.maxLines && ++n >= opts.maxLines) break;
    }
  } finally {
    rl.close();
    stream.destroy();
  }
}

/** Read the first `maxLines` parsed objects. */
export async function readHead(
  filePath: string,
  maxLines: number,
): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  for await (const obj of streamRawLines(filePath, { maxLines })) out.push(obj);
  return out;
}

/** Read the last `maxBytes` of a file and return the COMPLETE lines within. */
export async function readTail(
  filePath: string,
  maxBytes: number,
): Promise<{ lines: Record<string, unknown>[]; from: number; size: number }> {
  const fh = await open(filePath, "r");
  try {
    const st = await fh.stat();
    const size = st.size;
    const start = Math.max(0, size - maxBytes);
    const length = size - start;
    const buf = Buffer.alloc(Number(length));
    if (length > 0) await fh.read(buf, 0, Number(length), start);
    let text = buf.toString("utf8");
    // Drop a leading partial line unless we're at the true start of the file.
    if (start > 0) {
      const nl = text.indexOf("\n");
      text = nl >= 0 ? text.slice(nl + 1) : "";
    }
    const lines: Record<string, unknown>[] = [];
    for (const raw of text.split("\n")) {
      const obj = safeParse(raw);
      if (obj) lines.push(obj);
    }
    return { lines, from: start, size };
  } finally {
    await fh.close();
  }
}

// ---------------------------------------------------------------------------
// Field helpers (defensive)
// ---------------------------------------------------------------------------

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}
function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}
function obj(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

export function usageFromMessage(message: unknown): TokenUsage | undefined {
  const m = obj(message);
  const u = obj(m?.usage);
  if (!u) return undefined;
  return {
    inputTokens: num(u.input_tokens),
    outputTokens: num(u.output_tokens),
    cacheReadTokens: num(u.cache_read_input_tokens),
    cacheCreationTokens: num(u.cache_creation_input_tokens),
  };
}

function stringifyToolResult(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        const bo = obj(b);
        if (!bo) return "";
        if (bo.type === "text") return str(bo.text) ?? "";
        if (bo.type === "image") return "[image]";
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (content == null) return "";
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

/**
 * Approximate the decoded byte length of a base64 string without allocating the
 * buffer: 4 base64 chars encode 3 bytes, minus any trailing `=` padding.
 */
function base64ByteLength(b64: string): number {
  const len = b64.length;
  if (len === 0) return 0;
  const pad = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.floor((len * 3) / 4) - pad;
}

/**
 * Normalize an image content block, carrying the image so the UI can render it:
 *  - base64 source -> inline `data` (only when within {@link MAX_INLINE_IMAGE_BYTES};
 *    larger images degrade to mediaType-only so a payload can't balloon).
 *  - url/file/path source -> `assetPath` (the face resolves it via its allowlisted
 *    asset reader).
 *  - always carries `mediaType` when the source declares one.
 * All fields are optional, so a source-less image stays a bare `{ type: "image" }`.
 */
function imageBlock(bo: Record<string, unknown>): ContentBlock {
  const source = obj(bo.source);
  const mediaType = str(source?.media_type) ?? undefined;
  const out: ContentBlock = { type: "image" };
  if (mediaType) out.mediaType = mediaType;
  if (!source) return out;

  const sourceType = str(source.type);
  if (sourceType === "base64" || (source.data != null && sourceType !== "url")) {
    const data = str(source.data);
    if (data && base64ByteLength(data) <= MAX_INLINE_IMAGE_BYTES) {
      out.data = data;
    }
    return out;
  }

  // A referenced file/url: keep a path so the face can fetch it (allowlisted).
  const ref = str(source.url) ?? str(source.path) ?? str(source.file_path);
  if (ref) out.assetPath = ref;
  return out;
}

function blocksFromContent(content: unknown): ContentBlock[] {
  if (typeof content === "string") {
    return content ? [{ type: "text", text: content }] : [];
  }
  if (!Array.isArray(content)) return [];
  const out: ContentBlock[] = [];
  for (const b of content) {
    const bo = obj(b);
    if (!bo) continue;
    switch (bo.type) {
      case "text":
        out.push({ type: "text", text: str(bo.text) ?? "" });
        break;
      case "thinking":
        out.push({ type: "thinking", text: str(bo.thinking) ?? "" });
        break;
      case "tool_use":
        out.push({
          type: "tool_use",
          id: str(bo.id) ?? "",
          name: str(bo.name) ?? "",
          input: bo.input,
        });
        break;
      case "tool_result":
        out.push({
          type: "tool_result",
          toolUseId: str(bo.tool_use_id) ?? "",
          content: stringifyToolResult(bo.content),
          isError: bo.is_error === true,
        });
        break;
      case "image":
        out.push(imageBlock(bo));
        break;
      default:
        out.push({ type: "unknown", raw: bo });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Normalization: raw line -> NormalizedMessage (or null for pure metadata)
// ---------------------------------------------------------------------------

const META_TYPES = new Set([
  "ai-title",
  "custom-title",
  "summary",
  "mode",
  "permission-mode",
  "last-prompt",
  "file-history-snapshot",
  "agent-name",
  "agent-color",
  "pr-link",
]);

export function normalizeLine(
  raw: Record<string, unknown>,
  seq: number,
  agentId?: string,
): NormalizedMessage | null {
  const type = str(raw.type) ?? "unknown";
  if (META_TYPES.has(type)) return null;

  const base = {
    seq,
    uuid: str(raw.uuid),
    parentUuid: str(raw.parentUuid),
    timestamp: str(raw.timestamp),
    isSidechain: raw.isSidechain === true,
    ...(agentId ? { agentId } : {}),
  };

  if (type === "assistant") {
    const message = obj(raw.message);
    return {
      ...base,
      role: "assistant",
      type,
      model: str(message?.model) ?? undefined,
      blocks: blocksFromContent(message?.content),
      usage: usageFromMessage(message),
    };
  }

  if (type === "user") {
    const message = obj(raw.message);
    return { ...base, role: "user", type, blocks: blocksFromContent(message?.content) };
  }

  if (type === "system") {
    const text =
      str(raw.content) ??
      str(obj(raw.content)?.text) ??
      `[system: ${str(raw.subtype) ?? str(raw.level) ?? "event"}]`;
    return { ...base, role: "system", type, blocks: [{ type: "text", text }] };
  }

  if (type === "attachment") {
    // Overloaded: pasted/file context OR hook output ({type:"hook_success",...}).
    const a = obj(raw.attachment);
    const inner = a?.type ? str(a.type) : null;
    if (inner && inner.startsWith("hook")) {
      const hookName = str(a?.hookName) ?? "hook";
      const content = str(a?.content) ?? stringifyToolResult(a?.output) ?? "";
      return {
        ...base,
        role: "hook",
        type,
        blocks: [{ type: "text", text: `[${hookName}] ${content}`.trim() }],
      };
    }
    return {
      ...base,
      role: "attachment",
      type,
      blocks: [{ type: "text", text: stringifyToolResult(a ?? raw.attachment) }],
    };
  }

  if (type === "queue-operation") {
    return {
      ...base,
      role: "queue",
      type,
      blocks: [
        {
          type: "text",
          text: `[queued: ${str(raw.operation) ?? "op"}] ${stringifyToolResult(raw.content)}`,
        },
      ],
    };
  }

  // Unknown but non-meta line: keep it visible (tolerant), tagged for debugging.
  return { ...base, role: "meta", type, blocks: [{ type: "unknown", raw }] };
}

// ---------------------------------------------------------------------------
// Title resolution
// ---------------------------------------------------------------------------

function lastTitleOfType(
  lines: Record<string, unknown>[],
  type: string,
  field: string,
): string | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i]!;
    if (l.type === type) {
      const v = str(l[field]);
      if (v && v.trim()) return v.trim();
    }
  }
  return null;
}

/** Slash-command wrappers, caveats, and injected reminders that make poor titles. */
export function isCommandOrMetaPrompt(text: string): boolean {
  const t = text.trimStart();
  return (
    t.startsWith("<command-") ||
    t.startsWith("<local-command") ||
    t.startsWith("<system-reminder") ||
    t.startsWith("Caveat:") ||
    t.startsWith("[Request interrupted")
  );
}

function firstUserPrompt(lines: Record<string, unknown>[]): string | null {
  for (const l of lines) {
    if (l.type !== "user" || l.isMeta === true) continue;
    const content = obj(l.message)?.content;
    if (typeof content === "string" && content.trim() && !isCommandOrMetaPrompt(content)) {
      return content.trim().slice(0, 120);
    }
  }
  return null;
}

/** Resolve a human title from head + tail line samples (no custom name applied here). */
export function resolveTitle(
  head: Record<string, unknown>[],
  tail: Record<string, unknown>[],
  fallbackId: string,
): { title: string; source: TitleSource } {
  const ai = lastTitleOfType(tail, "ai-title", "aiTitle") ?? lastTitleOfType(head, "ai-title", "aiTitle");
  if (ai) return { title: ai, source: "ai-title" };
  const summary = lastTitleOfType(head, "summary", "summary") ?? lastTitleOfType(tail, "summary", "summary");
  if (summary) return { title: summary, source: "summary" };
  const prompt = firstUserPrompt(head);
  if (prompt) return { title: prompt, source: "first-prompt" };
  return { title: fallbackId.slice(0, 8), source: "session-id" };
}

export function findCwd(lines: Record<string, unknown>[]): string | null {
  for (const l of lines) {
    const c = str(l.cwd);
    if (c) return c;
  }
  return null;
}

export function findGitBranch(lines: Record<string, unknown>[]): string | null {
  for (const l of lines) {
    if (typeof l.gitBranch === "string") return l.gitBranch;
  }
  return null;
}

export function firstTimestamp(lines: Record<string, unknown>[]): string | null {
  for (const l of lines) {
    const t = str(l.timestamp);
    if (t) return t;
  }
  return null;
}

export function lastTimestamp(lines: Record<string, unknown>[]): string | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = str(lines[i]!.timestamp);
    if (t) return t;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Detail view: read messages for one session (tail-windowed for huge files)
// ---------------------------------------------------------------------------

const FULL_READ_THRESHOLD = 4 * 1024 * 1024; // read whole file under 4MB
const DEFAULT_TAIL_BYTES = 2 * 1024 * 1024;

export async function readSessionMessages(
  filePath: string,
  opts: { tailBytes?: number } = {},
): Promise<{
  messages: NormalizedMessage[];
  truncatedFromStart: boolean;
  rawLines: Record<string, unknown>[];
}> {
  const st = await stat(filePath);
  let rawLines: Record<string, unknown>[];
  let truncatedFromStart = false;

  if (st.size <= FULL_READ_THRESHOLD) {
    rawLines = [];
    for await (const obj of streamRawLines(filePath)) rawLines.push(obj);
  } else {
    const window = opts.tailBytes ?? DEFAULT_TAIL_BYTES;
    const tail = await readTail(filePath, window);
    rawLines = tail.lines;
    truncatedFromStart = tail.from > 0;
  }

  const messages: NormalizedMessage[] = [];
  let seq = 0;
  for (const raw of rawLines) {
    const m = normalizeLine(raw, seq);
    if (m) {
      messages.push(m);
      seq++;
    }
  }
  return { messages, truncatedFromStart, rawLines };
}

// ---------------------------------------------------------------------------
// Subagents (separate files under <sessionId>/subagents/.../agent-*.jsonl)
// ---------------------------------------------------------------------------

export async function listSubagentFiles(
  sessionDir: string,
): Promise<SubagentRef[]> {
  const subDir = path.join(sessionDir, "subagents");
  const refs: SubagentRef[] = [];
  await walkJsonl(subDir, (file) => {
    const baseName = path.basename(file, ".jsonl");
    if (!baseName.startsWith("agent-")) return;
    refs.push({ agentId: baseName, filePath: file });
  });
  return refs;
}

async function walkJsonl(dir: string, onFile: (file: string) => void): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // dir doesn't exist — fine
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await walkJsonl(full, onFile);
    else if (e.isFile() && e.name.endsWith(".jsonl")) onFile(full);
  }
}

/** Aggregate token usage across an array of normalized messages. */
export function aggregateUsage(messages: NormalizedMessage[]): TokenUsage {
  let u = { ...EMPTY_USAGE };
  for (const m of messages) {
    if (m.usage) {
      u.inputTokens += m.usage.inputTokens;
      u.outputTokens += m.usage.outputTokens;
      u.cacheReadTokens += m.usage.cacheReadTokens;
      u.cacheCreationTokens += m.usage.cacheCreationTokens;
    }
  }
  return u;
}
