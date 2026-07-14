import { createHash } from "node:crypto";
import { redactSecrets } from "../../redact.js";
import { MAX_DIAGNOSTIC_RAW_CHARS } from "../backend-diagnostics.js";

export const CLAUDE_BACKEND_DIAGNOSTIC_MAX_RECORDS = 4_096;
export const CLAUDE_BACKEND_DIAGNOSTIC_MAX_EVENT_ID_CHARS = 4_096;
const TASK_SCOPE = /^[A-Za-z0-9_-]{43}$/u;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface ClaudeBackendDiagnosticRecordInput {
  readonly taskScope: string;
  readonly sessionId: string;
  readonly generation: number;
  readonly eventId: string;
  readonly raw: string;
  readonly truncated: boolean;
}

export interface ClaudeBackendDiagnosticRecord extends ClaudeBackendDiagnosticRecordInput {}

export interface ClaudeBackendDiagnosticSnapshot {
  readonly records: readonly Readonly<ClaudeBackendDiagnosticRecord>[];
  readonly accepted: number;
  readonly collisions: number;
  readonly dropped: number;
  readonly duplicates: number;
  readonly evicted: number;
}

export interface ClaudeBackendDiagnosticOwnership {
  readonly taskScope: string;
  readonly sessionId: string;
  readonly generation: number;
}

export function claudeBackendDiagnosticTaskScope(canonicalHome: string): string {
  if (typeof canonicalHome !== "string" || canonicalHome.length === 0) {
    throw new TypeError("Claude backend diagnostic home is invalid");
  }
  return createHash("sha256")
    .update("devhub:claude-backend-diagnostic:v1\0", "utf8")
    .update(canonicalHome, "utf8")
    .digest("base64url");
}

function positiveBound(value: unknown): number {
  if (
    typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 ||
    value > CLAUDE_BACKEND_DIAGNOSTIC_MAX_RECORDS
  ) throw new TypeError("Claude backend diagnostic bound is invalid");
  return value;
}

function exactRecord(value: unknown): Readonly<ClaudeBackendDiagnosticRecord> | null {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const keys = Reflect.ownKeys(value);
    if (
      keys.length !== 6 ||
      !keys.includes("taskScope") || !keys.includes("sessionId") ||
      !keys.includes("generation") ||
      !keys.includes("eventId") || !keys.includes("raw") || !keys.includes("truncated")
    ) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of [
      "taskScope",
      "sessionId",
      "generation",
      "eventId",
      "raw",
      "truncated",
    ] as const) {
      const descriptor = descriptors[key];
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) return null;
    }
    const taskScope = descriptors.taskScope!.value;
    const sessionId = descriptors.sessionId!.value;
    const generation = descriptors.generation!.value;
    const eventId = descriptors.eventId!.value;
    const raw = descriptors.raw!.value;
    const truncated = descriptors.truncated!.value;
    if (
      typeof taskScope !== "string" || !TASK_SCOPE.test(taskScope) ||
      typeof sessionId !== "string" || !UUID.test(sessionId) ||
      typeof generation !== "number" || !Number.isSafeInteger(generation) || generation < 1 ||
      typeof eventId !== "string" || eventId.length === 0 ||
      eventId.length > CLAUDE_BACKEND_DIAGNOSTIC_MAX_EVENT_ID_CHARS ||
      /[\u0000-\u001f\u007f]/u.test(eventId) ||
      typeof raw !== "string" || raw.length > MAX_DIAGNOSTIC_RAW_CHARS ||
      typeof truncated !== "boolean"
    ) return null;
    const redacted = redactSecrets(raw);
    return Object.freeze({
      taskScope,
      sessionId,
      generation,
      eventId,
      raw: redacted.slice(0, MAX_DIAGNOSTIC_RAW_CHARS),
      truncated: truncated || redacted.length > MAX_DIAGNOSTIC_RAW_CHARS,
    });
  } catch {
    return null;
  }
}

function recordsEqual(
  left: Readonly<ClaudeBackendDiagnosticRecord>,
  right: Readonly<ClaudeBackendDiagnosticRecord>,
): boolean {
  return left.raw === right.raw && left.truncated === right.truncated;
}

/** Bounded process-memory retention. No filesystem, logs, telemetry, or browser surface. */
export class ClaudeBackendDiagnosticStore {
  private readonly maxRecords: number;
  private readonly records = new Map<string, Readonly<ClaudeBackendDiagnosticRecord>>();
  private accepted = 0;
  private collisions = 0;
  private dropped = 0;
  private duplicates = 0;
  private evicted = 0;

  constructor(maxRecords: number) {
    this.maxRecords = positiveBound(maxRecords);
  }

  retain(
    value: ClaudeBackendDiagnosticRecordInput,
    ownership?: Readonly<ClaudeBackendDiagnosticOwnership>,
  ): Readonly<ClaudeBackendDiagnosticRecord> | null {
    const record = exactRecord(value);
    if (record === null) {
      this.dropped += 1;
      return null;
    }
    if (
      ownership !== undefined && (
        record.taskScope !== ownership.taskScope ||
        record.sessionId !== ownership.sessionId ||
        record.generation !== ownership.generation
      )
    ) {
      this.dropped += 1;
      return null;
    }
    const scope = `${record.taskScope}\u0000${record.sessionId}\u0000${record.eventId}`;
    const previous = this.records.get(scope);
    if (previous !== undefined) {
      if (recordsEqual(previous, record)) {
        this.duplicates += 1;
      } else {
        this.collisions += 1;
        this.dropped += 1;
      }
      return null;
    }
    while (this.records.size >= this.maxRecords) {
      const oldest = this.records.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.records.delete(oldest);
      this.evicted += 1;
    }
    this.records.set(scope, record);
    this.accepted += 1;
    return record;
  }

  snapshot(): Readonly<ClaudeBackendDiagnosticSnapshot> {
    return Object.freeze({
      records: Object.freeze([...this.records.values()]),
      accepted: this.accepted,
      collisions: this.collisions,
      dropped: this.dropped,
      duplicates: this.duplicates,
      evicted: this.evicted,
    });
  }
}
