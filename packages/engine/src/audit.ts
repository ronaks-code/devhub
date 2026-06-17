/**
 * Audit log of permission DECISIONS — a durable trail of what the user (or a
 * permission mode) allowed/denied for tool calls. Our own data, stored in the
 * `permission_audit` table; we never touch transcripts.
 *
 *  - Shares the TranscriptIndex's `node:sqlite` handle (no second connection).
 *  - The `permission_audit` table is created by the migration runner (see
 *    migrations.ts) and is ADDITIVE — appending here never drops/recreates a table
 *    that holds data.
 *  - One row per decision: an "allow"/"deny" verdict for a `toolName`, with an
 *    optional scope ("once"/"always"/"session"/…), a free-form reason, the owning
 *    sessionId, and an epoch-ms timestamp.
 *  - {@link logResultDenials} is the result-level helper the server calls when a
 *    turn ends: it records each `permission_denials` entry the CLI reported as an
 *    implicit "deny" decision, so denials that never surfaced an inline prompt
 *    still land in the audit trail.
 */
import type { DatabaseSync as SqliteDatabase, StatementSync } from "node:sqlite";
import type { PermissionDenial } from "./driver/types.js";
import { redactSecrets } from "./redact.js";

/** An allow/deny verdict for a tool call. */
export type AuditDecision = "allow" | "deny";

/** Input to {@link AuditStore.logDecision}: one permission decision to record. */
export interface AuditDecisionInput {
  /** Session the decision belongs to (null when not tied to a session). */
  sessionId?: string | null;
  /** The tool the decision is about (e.g. "Bash", "Edit"). */
  toolName: string;
  /** Whether the call was allowed or denied. */
  decision: AuditDecision;
  /** Optional scope of the decision (e.g. "once", "always", "session"). */
  scope?: string | null;
  /** Optional free-form reason / note shown alongside the verdict. */
  reason?: string | null;
  /** Decision time, epoch milliseconds. Defaults to Date.now() when omitted. */
  ts?: number;
}

/** A persisted permission-decision row. */
export interface AuditEntry {
  id: number;
  sessionId: string | null;
  toolName: string;
  decision: AuditDecision;
  scope: string | null;
  reason: string | null;
  /** Decision time, epoch milliseconds. */
  ts: number;
}

interface AuditRow {
  id: number | bigint;
  sessionId: string | null;
  toolName: string | null;
  decision: string | null;
  scope: string | null;
  reason: string | null;
  ts: number | bigint;
}

function num(v: number | bigint): number {
  return typeof v === "bigint" ? Number(v) : v;
}

function rowToEntry(row: AuditRow): AuditEntry {
  return {
    id: num(row.id),
    sessionId: row.sessionId ?? null,
    toolName: row.toolName ?? "tool",
    // Anything that isn't the literal "allow" reads back as "deny" (fail closed).
    decision: row.decision === "allow" ? "allow" : "deny",
    scope: row.scope ?? null,
    reason: row.reason ?? null,
    ts: num(row.ts),
  };
}

export class AuditStore {
  private insert: StatementSync;
  private selectAll: StatementSync;
  private selectForSession: StatementSync;

  /** Construct over the shared DatabaseSync handle (do NOT open a new connection). */
  constructor(private readonly db: SqliteDatabase) {
    this.insert = this.db.prepare(
      `INSERT INTO permission_audit (sessionId, toolName, decision, scope, reason, ts)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    // Newest first, then by id for a stable order among same-instant rows.
    this.selectAll = this.db.prepare(
      `SELECT id, sessionId, toolName, decision, scope, reason, ts
       FROM permission_audit ORDER BY ts DESC, id DESC LIMIT ?`,
    );
    this.selectForSession = this.db.prepare(
      `SELECT id, sessionId, toolName, decision, scope, reason, ts
       FROM permission_audit WHERE sessionId = ? ORDER BY ts DESC, id DESC LIMIT ?`,
    );
  }

  /**
   * Record one permission decision. `toolName` is trimmed (falls back to "tool"
   * when blank); `decision` is normalized to allow/deny; the free-text `reason` is
   * run through {@link redactSecrets} so a leaked key/token/connection-string never
   * lands in the log; `ts` defaults to now. Returns the stored entry (the returned
   * `reason` is the redacted value that was persisted).
   */
  logDecision(input: AuditDecisionInput): AuditEntry {
    const toolName = (input.toolName ?? "").trim() || "tool";
    const decision: AuditDecision = input.decision === "allow" ? "allow" : "deny";
    const sessionId = input.sessionId ?? null;
    const scope = input.scope ?? null;
    // `reason` is the only free-text field a caller passes through; mask any
    // credential-shaped substrings before it lands in the durable log. The other
    // fields (toolName/decision/scope) are constrained vocabularies and safe.
    const reason = input.reason != null ? redactSecrets(input.reason) : null;
    const ts = typeof input.ts === "number" ? input.ts : Date.now();
    const res = this.insert.run(sessionId, toolName, decision, scope, reason, ts);
    return { id: Number(res.lastInsertRowid), sessionId, toolName, decision, scope, reason, ts };
  }

  /**
   * Record the result-level `permission_denials` a turn reported as implicit "deny"
   * decisions (scope "result"). These are denials the CLI surfaced at turn end that
   * may never have shown an inline prompt — capturing them keeps the audit trail
   * complete. Returns the rows written (one per denial); empty when there are none.
   */
  logResultDenials(
    denials: PermissionDenial[],
    opts: { sessionId?: string | null; ts?: number } = {},
  ): AuditEntry[] {
    if (!denials || denials.length === 0) return [];
    const ts = typeof opts.ts === "number" ? opts.ts : Date.now();
    const out: AuditEntry[] = [];
    for (const d of denials) {
      out.push(
        this.logDecision({
          sessionId: opts.sessionId ?? null,
          toolName: d.toolName,
          decision: "deny",
          scope: "result",
          ts,
        }),
      );
    }
    return out;
  }

  /**
   * Recent audit entries, newest first. With `{ sessionId }` scopes to one session;
   * `{ limit }` caps the row count (default 100, clamped to 1..1000).
   */
  list(opts: { limit?: number; sessionId?: string | null } = {}): AuditEntry[] {
    const limit = Math.max(1, Math.min(opts.limit ?? 100, 1000));
    const rows =
      opts.sessionId != null
        ? (this.selectForSession.all(opts.sessionId, limit) as unknown as AuditRow[])
        : (this.selectAll.all(limit) as unknown as AuditRow[]);
    return rows.map(rowToEntry);
  }
}
