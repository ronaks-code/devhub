/**
 * Index SUBAGENT transcript text into the search store so cross-project search finds
 * what a session's subagents said/did — not just the main transcript.
 *
 * Subagents live in separate files next to the session transcript, under
 * `<sessionDir>/subagents/**\/agent-*.jsonl` (one file per spawned agent). We scan
 * each, harvest the same renderable + tool I/O text the main indexer mirrors
 * (renderableText / toolTexts from parse-session.ts), and tag every row with the
 * agent's id so a hit can point back to which subagent it came from.
 *
 * STORAGE NOTE: the FTS mirror's columns are fixed at create time
 * (sessionId, role, seq, toolName, text). To carry the agentId WITHOUT a schema
 * migration, subagent rows reuse `role="subagent"` and stash the agentId in the
 * (otherwise-unused-for-chat) `toolName` column. The search layer reads it back from
 * there for `role="subagent"` rows. Main-transcript indexing is completely unchanged.
 */
import { readdir } from "node:fs/promises";
import path from "node:path";
import { streamRawLines } from "./parser.js";
import { renderableText, toolTexts } from "./parse-session.js";

/** Mirrored role marking a row as subagent text (vs. the main transcript's roles). */
export const SUBAGENT_ROLE = "subagent";

/**
 * One mirrored search row from a subagent transcript. Same shape as the main store's
 * {@link SearchText} but with a fixed `role` of {@link SUBAGENT_ROLE} and the
 * agent id carried in `toolName` (see the module note on why).
 */
export interface SubagentSearchText {
  role: typeof SUBAGENT_ROLE;
  seq: number;
  text: string;
  /** The owning subagent's id (agent-*.jsonl base name); stored in the FTS toolName slot. */
  toolName: string;
}

/** The subagents directory for a session, given the session's transcript path. */
export function subagentsDir(transcriptPath: string): string {
  const sessionId = path.basename(transcriptPath, ".jsonl");
  return path.join(path.dirname(transcriptPath), sessionId, "subagents");
}

/** Recursively collect `agent-*.jsonl` files under `dir` (tolerant of a missing dir). */
async function listAgentFiles(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return []; // no subagents dir — fine
  }
  const out: string[] = [];
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...(await listAgentFiles(full)));
    } else if (e.isFile() && e.name.endsWith(".jsonl") && e.name.startsWith("agent-")) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Harvest renderable + tool-I/O text from ONE subagent transcript file, tagged with
 * `agentId`. `startSeq` is the first seq to assign (so a caller can keep seqs unique
 * across files); returns the rows plus the next free seq.
 *
 * Reuses the exact main-indexer extraction (renderableText / toolTexts) so subagent
 * search behaves identically to main-transcript search (same caps, same command-line
 * mirroring). Every row carries `role="subagent"` and the agentId in `toolName`.
 */
export async function scanSubagentFile(
  filePath: string,
  agentId: string,
  startSeq: number,
): Promise<{ rows: SubagentSearchText[]; nextSeq: number }> {
  const rows: SubagentSearchText[] = [];
  let seq = startSeq;
  for await (const raw of streamRawLines(filePath)) {
    const type = typeof raw.type === "string" ? raw.type : "";
    if (type !== "user" && type !== "assistant") continue;
    const text = renderableText(type, raw.message);
    if (text) rows.push({ role: SUBAGENT_ROLE, seq, text, toolName: agentId });
    // Mirror the subagent's tool I/O too (command lines + tool_result bodies), tagged
    // with the agentId in `toolName` like the chat rows.
    for (const tt of toolTexts(type, raw.message, seq)) {
      rows.push({ role: SUBAGENT_ROLE, seq, text: tt.text, toolName: agentId });
    }
    seq++;
  }
  return { rows, nextSeq: seq };
}

/**
 * Scan EVERY subagent transcript for a session and return all mirrored rows,
 * tagged per agent. seqs are continuous across the session's subagent files (each
 * file picks up where the prior left off) so they're unique within the session's
 * subagent rows. Returns [] when the session has no subagents dir / no agent files.
 */
export async function scanSubagents(transcriptPath: string): Promise<SubagentSearchText[]> {
  const dir = subagentsDir(transcriptPath);
  const files = (await listAgentFiles(dir)).sort(); // deterministic order
  const out: SubagentSearchText[] = [];
  let seq = 0;
  for (const file of files) {
    const agentId = path.basename(file, ".jsonl");
    const { rows, nextSeq } = await scanSubagentFile(file, agentId, seq);
    out.push(...rows);
    seq = nextSeq;
  }
  return out;
}
