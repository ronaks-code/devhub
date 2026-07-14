import { randomUUID } from "node:crypto";
import path from "node:path";
import { USER_CANCELLED_STATUS } from "../../provider-status-contract.js";
import { normalizeProviderNativeId } from "../native-id.js";
import {
  canonicalizeProviderHome,
  createNativeTaskKey,
} from "../task-key.js";
import type {
  NativeTurnRef,
  ProviderEventSink,
  ProviderRequestResponse,
  UserInput,
} from "../types.js";
import type { ClaudeCliPermissionMode } from "./cli-process.js";
import { ClaudeControlPeer } from "./control-peer.js";
import {
  ClaudeBackendDiagnosticStore,
  claudeBackendDiagnosticTaskScope,
  type ClaudeBackendDiagnosticRecord,
  type ClaudeBackendDiagnosticSnapshot,
} from "./backend-diagnostic-store.js";
import {
  ClaudeEventNormalizer,
  type ClaudeNormalizedBackendEvent,
  type ClaudeNormalizedEventBatch,
} from "./event-normalizer.js";
import {
  buildClaudeRequestedModelObservation,
  ClaudeModelEvidenceLedger,
  type ClaudeModelEvidenceSnapshot,
} from "./model-evidence.js";
import { ClaudePermissionBridge } from "./permission-bridge.js";

export const CLAUDE_TASK_RUNTIME_MAX_REPLAY_EVENTS = 100_000;
export const CLAUDE_TASK_RUNTIME_MAX_INPUT_CHARS = 1_048_576;
export const CLAUDE_TASK_RUNTIME_DEFAULT_MAX_BACKEND_DIAGNOSTICS = 256;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const PERMISSION_MODES = new Set<ClaudeCliPermissionMode>([
  "manual",
  "acceptEdits",
  "auto",
  "dontAsk",
  "plan",
]);

export type ClaudeTaskRuntimeErrorCode =
  | "INVALID_CONFIGURATION"
  | "NOT_STARTED"
  | "SHUTDOWN"
  | "TURN_ACTIVE"
  | "TURN_MISMATCH"
  | "WRITE_FAILED"
  | "REPLAY_COLLISION"
  | "REPLAY_CAPACITY";

export class ClaudeTaskRuntimeError extends Error {
  readonly code: ClaudeTaskRuntimeErrorCode;

  constructor(code: ClaudeTaskRuntimeErrorCode, message: string) {
    super(message);
    this.name = "ClaudeTaskRuntimeError";
    this.code = code;
    Object.freeze(this);
  }
}

export type ClaudeTaskRuntimeLaunch = "new" | "resume";

export interface ClaudeTaskRuntimeProcessOptions {
  readonly executable: string;
  readonly configHome: string;
  readonly cwd: string;
  readonly sessionId: string;
  readonly launch: ClaudeTaskRuntimeLaunch;
  readonly requestedModel?: string;
  readonly permissionMode?: ClaudeCliPermissionMode;
  readonly permissionPromptStdio: true;
  readonly onEnvelope: (envelope: unknown) => void | Promise<void>;
}

export interface ClaudeTaskRuntimeProcessTerminal {
  readonly kind: "shutdown" | "failure";
}

export interface ClaudeTaskRuntimeProcess {
  readonly terminated: Promise<ClaudeTaskRuntimeProcessTerminal>;
  start(): Promise<void>;
  writeEnvelope(value: unknown): Promise<void>;
  shutdown(): Promise<ClaudeTaskRuntimeProcessTerminal>;
}

export type ClaudeTaskRuntimeProcessFactory = (
  options: ClaudeTaskRuntimeProcessOptions,
) => ClaudeTaskRuntimeProcess;

export interface ClaudeTaskRuntimeOptions {
  readonly executable: string;
  readonly configHome: string;
  readonly cwd: string;
  readonly sessionId: string;
  readonly generation: number;
  readonly launch: ClaudeTaskRuntimeLaunch;
  readonly requestedModel?: string;
  readonly permissionMode?: ClaudeCliPermissionMode;
  readonly emit: ProviderEventSink;
  readonly processFactory: ClaudeTaskRuntimeProcessFactory;
  readonly canonicalizeHome?: (home: string) => string;
  readonly now?: () => string;
  readonly idFactory?: () => string;
  readonly maxBackendDiagnostics?: number;
  readonly maxReplayEvents?: number;
  readonly maxModelObservations?: number;
  readonly onBackendDiagnostic?: (record: Readonly<ClaudeBackendDiagnosticRecord>) => void;
}

interface ReplayDeliveryState {
  readonly fingerprint: string;
  readonly statusProjection: "original" | "user-cancelled";
  nextDiagnosticIndex: number;
  nextEventIndex: number;
  modelValidated: boolean;
  modelCommitted: boolean;
  delivering: boolean;
}

interface BufferedInterruptTerminal {
  readonly batch: Readonly<ClaudeNormalizedEventBatch>;
  readonly turnId: string;
}

interface PendingUserInterrupt {
  readonly turnId: string;
  decision: "pending" | "original" | "user-cancelled";
  terminalDelivered: boolean;
  bufferedTerminal: BufferedInterruptTerminal | null;
}

const CLAUDE_INTERRUPT_ERROR_RESULT_STATUS = "error_during_execution";

const runtimeError = (
  code: ClaudeTaskRuntimeErrorCode,
  message: string,
): ClaudeTaskRuntimeError => new ClaudeTaskRuntimeError(code, message);

const nonEmpty = (value: unknown, field: string): string => {
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    value.length === 0 ||
    value.includes("\u0000")
  ) {
    throw runtimeError("INVALID_CONFIGURATION", `Claude runtime ${field} is invalid`);
  }
  return value;
};

const nativeUuid = (value: unknown, field: string): string => {
  const normalized = normalizeProviderNativeId(value, field);
  if (!UUID.test(normalized)) {
    throw runtimeError("INVALID_CONFIGURATION", `Claude runtime ${field} is invalid`);
  }
  return normalized;
};

const strictTimestamp = (value: unknown): string => {
  if (typeof value !== "string" || value.length > 32) {
    throw runtimeError("INVALID_CONFIGURATION", "Claude runtime clock is invalid");
  }
  try {
    if (new Date(value).toISOString() !== value) throw new Error();
  } catch {
    throw runtimeError("INVALID_CONFIGURATION", "Claude runtime clock is invalid");
  }
  return value;
};

const safePositiveBound = (value: unknown, fallback: number): number => {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || (resolved as number) < 1 ||
    (resolved as number) > CLAUDE_TASK_RUNTIME_MAX_REPLAY_EVENTS) {
    throw runtimeError("INVALID_CONFIGURATION", "Claude runtime replay bound is invalid");
  }
  return resolved as number;
};

const safePermissionMode = (value: unknown): ClaudeCliPermissionMode | null => {
  if (value === undefined) return null;
  if (typeof value !== "string" || !PERMISSION_MODES.has(value as ClaudeCliPermissionMode)) {
    throw runtimeError("INVALID_CONFIGURATION", "Claude runtime permission mode is invalid");
  }
  return value as ClaudeCliPermissionMode;
};

const exactInputText = (input: UserInput): string => {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("Claude user input is invalid");
  }
  if (input.attachments !== undefined && input.attachments.length > 0) {
    throw new TypeError("Claude persistent runtime attachments are not enabled");
  }
  if (
    typeof input.text !== "string" ||
    input.text.length === 0 ||
    input.text.length > CLAUDE_TASK_RUNTIME_MAX_INPUT_CHARS ||
    input.text.includes("\u0000")
  ) {
    throw new TypeError("Claude user input text is invalid");
  }
  return input.text;
};

export class ClaudeTaskRuntime {
  readonly home: string;
  readonly cwd: string;
  readonly sessionId: string;
  readonly generation: number;

  private readonly requestedModel: string | null;
  private readonly permissionMode: ClaudeCliPermissionMode | null;
  private readonly emit: ProviderEventSink;
  private readonly now: () => string;
  private readonly idFactory: () => string;
  private readonly maxReplayEvents: number;
  private readonly backendDiagnosticTaskScope: string;
  private readonly backendDiagnosticStore: ClaudeBackendDiagnosticStore;
  private readonly onBackendDiagnostic: (
    (record: Readonly<ClaudeBackendDiagnosticRecord>) => void
  ) | null;
  private readonly process: ClaudeTaskRuntimeProcess;
  private readonly normalizer: ClaudeEventNormalizer;
  private readonly modelLedger: ClaudeModelEvidenceLedger;
  private readonly modelValidationLedger: ClaudeModelEvidenceLedger;
  private readonly permissionBridge: ClaudePermissionBridge;
  private readonly controlPeer: ClaudeControlPeer;
  private readonly replay = new Map<string, string>();
  private readonly deliveringReplay = new Map<string, ReplayDeliveryState>();
  private readonly taskKey;
  private startPromise: Promise<void> | null = null;
  private shutdownPromise: Promise<ClaudeTaskRuntimeProcessTerminal> | null = null;
  private activeTurnId: string | null = null;
  private started = false;
  private stopped = false;
  private interruptReceiptRequired: boolean | null = null;
  private pendingUserInterrupt: PendingUserInterrupt | null = null;
  private backendDiagnosticSinkFailures = 0;

  constructor(options: ClaudeTaskRuntimeOptions) {
    if (!options || typeof options !== "object") {
      throw runtimeError("INVALID_CONFIGURATION", "Claude runtime options are invalid");
    }
    const executable = nonEmpty(options.executable, "executable");
    if (!path.isAbsolute(executable)) {
      throw runtimeError("INVALID_CONFIGURATION", "Claude runtime executable is invalid");
    }
    const canonicalizer = options.canonicalizeHome ?? canonicalizeProviderHome;
    if (typeof canonicalizer !== "function") {
      throw runtimeError("INVALID_CONFIGURATION", "Claude runtime canonicalizer is invalid");
    }
    const suppliedHome = nonEmpty(options.configHome, "config home");
    this.home = canonicalizer(suppliedHome);
    if (!path.isAbsolute(this.home) || this.home !== suppliedHome) {
      throw runtimeError("INVALID_CONFIGURATION", "Claude runtime config home is invalid");
    }
    this.backendDiagnosticTaskScope = claudeBackendDiagnosticTaskScope(this.home);
    this.cwd = nonEmpty(options.cwd, "cwd");
    if (!path.isAbsolute(this.cwd)) {
      throw runtimeError("INVALID_CONFIGURATION", "Claude runtime cwd is invalid");
    }
    this.sessionId = nativeUuid(options.sessionId, "session id");
    if (!Number.isSafeInteger(options.generation) || options.generation < 1) {
      throw runtimeError("INVALID_CONFIGURATION", "Claude runtime generation is invalid");
    }
    this.generation = options.generation;
    if (options.launch !== "new" && options.launch !== "resume") {
      throw runtimeError("INVALID_CONFIGURATION", "Claude runtime launch mode is invalid");
    }
    if (typeof options.emit !== "function" || typeof options.processFactory !== "function") {
      throw runtimeError("INVALID_CONFIGURATION", "Claude runtime ownership is invalid");
    }
    if (options.now !== undefined && typeof options.now !== "function") {
      throw runtimeError("INVALID_CONFIGURATION", "Claude runtime clock is invalid");
    }
    if (options.idFactory !== undefined && typeof options.idFactory !== "function") {
      throw runtimeError("INVALID_CONFIGURATION", "Claude runtime id factory is invalid");
    }
    if (
      options.onBackendDiagnostic !== undefined &&
      typeof options.onBackendDiagnostic !== "function"
    ) {
      throw runtimeError("INVALID_CONFIGURATION", "Claude runtime diagnostic sink is invalid");
    }
    this.requestedModel = options.requestedModel === undefined
      ? null
      : normalizeProviderNativeId(options.requestedModel, "Claude requested model");
    this.permissionMode = safePermissionMode(options.permissionMode);
    this.emit = options.emit;
    this.now = options.now ?? (() => new Date().toISOString());
    this.idFactory = options.idFactory ?? randomUUID;
    this.maxReplayEvents = safePositiveBound(
      options.maxReplayEvents,
      CLAUDE_TASK_RUNTIME_MAX_REPLAY_EVENTS,
    );
    try {
      this.backendDiagnosticStore = new ClaudeBackendDiagnosticStore(
        options.maxBackendDiagnostics ?? CLAUDE_TASK_RUNTIME_DEFAULT_MAX_BACKEND_DIAGNOSTICS,
      );
    } catch {
      throw runtimeError("INVALID_CONFIGURATION", "Claude runtime diagnostic bound is invalid");
    }
    this.onBackendDiagnostic = options.onBackendDiagnostic ?? null;
    this.taskKey = createNativeTaskKey("anthropic", this.home, this.sessionId);
    this.normalizer = new ClaudeEventNormalizer({
      home: this.home,
      sessionId: this.sessionId,
      generation: this.generation,
      canonicalizeHome: canonicalizer,
    });
    const modelLedgerOptions = {
      sessionId: this.sessionId,
      generation: this.generation,
      ...(options.maxModelObservations === undefined
        ? {}
        : { maxObservations: options.maxModelObservations }),
    };
    this.modelLedger = new ClaudeModelEvidenceLedger(modelLedgerOptions);
    this.modelValidationLedger = new ClaudeModelEvidenceLedger(modelLedgerOptions);
    this.permissionBridge = new ClaudePermissionBridge({
      emit: this.emit,
      activeTurnId: () => this.activeTurnId,
      now: () => strictTimestamp(this.now()),
    });

    let ownedProcess: ClaudeTaskRuntimeProcess | null = null;
    this.controlPeer = new ClaudeControlPeer({
      configHome: this.home,
      sessionId: this.sessionId,
      generation: this.generation,
      canonicalizeHome: canonicalizer,
      requestIdFactory: () => normalizeProviderNativeId(this.idFactory(), "Claude request id"),
      sendEnvelope: (envelope) => {
        if (!ownedProcess) {
          return Promise.reject(runtimeError("NOT_STARTED", "Claude runtime process is unavailable"));
        }
        return ownedProcess.writeEnvelope(envelope);
      },
      handleInboundControl: this.permissionBridge.handleControl,
      createInboundTimeoutResult: this.permissionBridge.createTimeoutResult,
    });

    try {
      ownedProcess = options.processFactory(Object.freeze({
        executable,
        configHome: this.home,
        cwd: this.cwd,
        sessionId: this.sessionId,
        launch: options.launch,
        ...(this.requestedModel === null ? {} : { requestedModel: this.requestedModel }),
        ...(this.permissionMode === null ? {} : { permissionMode: this.permissionMode }),
        permissionPromptStdio: true as const,
        onEnvelope: (envelope: unknown) => this.receiveEnvelope(envelope),
      }));
    } catch {
      throw runtimeError("INVALID_CONFIGURATION", "Claude runtime process factory failed");
    }
    if (
      !ownedProcess ||
      typeof ownedProcess.start !== "function" ||
      typeof ownedProcess.writeEnvelope !== "function" ||
      typeof ownedProcess.shutdown !== "function" ||
      !ownedProcess.terminated ||
      typeof ownedProcess.terminated.then !== "function"
    ) {
      throw runtimeError("INVALID_CONFIGURATION", "Claude runtime process is invalid");
    }
    this.process = ownedProcess;
    void this.process.terminated.then(
      () => this.onProcessTerminal(),
      () => this.onProcessTerminal(),
    );
  }

  get activeTurn(): string | null {
    return this.activeTurnId;
  }

  get terminated(): Promise<ClaudeTaskRuntimeProcessTerminal> {
    return this.process.terminated;
  }

  start(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    if (this.stopped) {
      return Promise.reject(runtimeError("SHUTDOWN", "Claude runtime is stopped"));
    }
    this.startPromise = Promise.resolve()
      .then(async () => {
        if (this.stopped) {
          throw runtimeError("SHUTDOWN", "Claude runtime is stopped");
        }
        await this.process.start();
        if (this.stopped) {
          throw runtimeError("SHUTDOWN", "Claude runtime stopped during startup");
        }
        this.started = true;
      });
    return this.startPromise;
  }

  async send(input: UserInput): Promise<NativeTurnRef> {
    if (this.stopped) throw runtimeError("SHUTDOWN", "Claude runtime is stopped");
    if (!this.started) throw runtimeError("NOT_STARTED", "Claude runtime has not started");
    if (this.activeTurnId !== null || this.pendingUserInterrupt !== null) {
      throw runtimeError("TURN_ACTIVE", "Claude runtime already has an active turn");
    }
    const text = exactInputText(input);
    const turnId = nativeUuid(this.idFactory(), "turn id");
    const occurredAt = strictTimestamp(this.now());
    this.activeTurnId = turnId;
    try {
      if (this.requestedModel !== null) {
        const observation = buildClaudeRequestedModelObservation({
          id: `${turnId}:requested-model`,
          sourceEventId: turnId,
          sessionId: this.sessionId,
          generation: this.generation,
          turnId,
          occurredAt,
          model: this.requestedModel,
        });
        this.modelValidationLedger.append([observation]);
        this.modelLedger.append([observation]);
      }
      await this.process.writeEnvelope(Object.freeze({
        type: "user",
        uuid: turnId,
        session_id: this.sessionId,
        message: Object.freeze({
          role: "user",
          content: Object.freeze([Object.freeze({ type: "text", text })]),
        }),
        parent_tool_use_id: null,
      }));
    } catch (error) {
      if (this.activeTurnId === turnId) this.activeTurnId = null;
      if (error instanceof ClaudeTaskRuntimeError) throw error;
      throw runtimeError("WRITE_FAILED", "Claude runtime turn write failed");
    }
    return Object.freeze({ taskKey: this.taskKey, turnId });
  }

  async interrupt(turnId: string): Promise<void> {
    const normalized = normalizeProviderNativeId(turnId, "Claude turn id");
    if (this.stopped) throw runtimeError("SHUTDOWN", "Claude runtime is stopped");
    if (this.activeTurnId !== normalized || this.pendingUserInterrupt !== null) {
      throw runtimeError("TURN_MISMATCH", "Claude runtime turn is not active");
    }
    const pending: PendingUserInterrupt = {
      turnId: normalized,
      decision: "pending",
      terminalDelivered: false,
      bufferedTerminal: null,
    };
    this.pendingUserInterrupt = pending;
    const receiptRequired = this.interruptReceiptRequired !== false;
    try {
      await this.controlPeer.interrupt({
        receiptRequired,
      });
    } catch (error) {
      if (this.pendingUserInterrupt === pending) {
        pending.decision = "original";
        this.flushBufferedInterruptTerminal(pending);
        if (this.pendingUserInterrupt === pending) this.pendingUserInterrupt = null;
      }
      throw error;
    }
    if (this.pendingUserInterrupt !== pending) return;
    pending.decision = receiptRequired ? "user-cancelled" : "original";
    this.flushBufferedInterruptTerminal(pending);
    if (this.pendingUserInterrupt === pending && pending.terminalDelivered) {
      this.pendingUserInterrupt = null;
    }
  }

  async respond(response: ProviderRequestResponse): Promise<void> {
    if (this.stopped) throw runtimeError("SHUTDOWN", "Claude runtime is stopped");
    await this.permissionBridge.respond(response);
  }

  modelEvidence(): Readonly<ClaudeModelEvidenceSnapshot> {
    return this.modelLedger.snapshot();
  }

  backendDiagnostics(): Readonly<ClaudeBackendDiagnosticSnapshot & {
    readonly sinkFailures: number;
  }> {
    return Object.freeze({
      ...this.backendDiagnosticStore.snapshot(),
      sinkFailures: this.backendDiagnosticSinkFailures,
    });
  }

  shutdown(): Promise<ClaudeTaskRuntimeProcessTerminal> {
    if (this.shutdownPromise) return this.shutdownPromise;
    const pending = this.pendingUserInterrupt;
    if (pending !== null && pending.bufferedTerminal !== null) {
      pending.decision = "original";
      try { this.flushBufferedInterruptTerminal(pending); } catch {
        // Intentional shutdown still clears every pending correlation below.
      }
    }
    this.stopped = true;
    this.activeTurnId = null;
    this.pendingUserInterrupt = null;
    this.deliveringReplay.clear();
    this.permissionBridge.close();
    this.controlPeer.close();
    this.shutdownPromise = this.process.shutdown();
    return this.shutdownPromise;
  }

  private async receiveEnvelope(envelope: unknown): Promise<void> {
    if (this.stopped) return;
    if (this.controlPeer.receive(envelope)) return;
    const occurredAt = strictTimestamp(this.now());
    const turnId = this.activeTurnId;
    const batch = this.normalizer.normalize(envelope, { turnId, occurredAt });
    const prior = this.replay.get(batch.replayKey);
    if (prior !== undefined) {
      if (prior !== batch.fingerprint) {
        throw runtimeError("REPLAY_COLLISION", "Claude native event replay collided");
      }
      return;
    }
    const terminalStatus = this.turnTerminalStatus(batch, turnId);
    const pending = this.pendingUserInterrupt;
    if (
      pending !== null && pending.turnId === turnId &&
      terminalStatus === CLAUDE_INTERRUPT_ERROR_RESULT_STATUS
    ) {
      if (pending.bufferedTerminal !== null) {
        const buffered = pending.bufferedTerminal.batch;
        if (
          buffered.replayKey !== batch.replayKey ||
          buffered.fingerprint !== batch.fingerprint
        ) {
          throw runtimeError("REPLAY_COLLISION", "Claude interrupt terminal replay collided");
        }
        if (pending.decision !== "pending") this.flushBufferedInterruptTerminal(pending);
        return;
      }
      if (pending.decision === "pending") {
        pending.bufferedTerminal = Object.freeze({ batch, turnId: pending.turnId });
        return;
      }
    }
    const projection = pending !== null && pending.turnId === turnId &&
      terminalStatus === CLAUDE_INTERRUPT_ERROR_RESULT_STATUS &&
      pending.decision === "user-cancelled"
      ? "user-cancelled"
      : "original";
    this.deliverNormalizedBatch(batch, turnId, projection);
    if (terminalStatus !== null && pending !== null && pending.turnId === turnId) {
      pending.terminalDelivered = true;
      if (pending.decision !== "pending" && this.pendingUserInterrupt === pending) {
        this.pendingUserInterrupt = null;
      }
    }
  }

  private deliverNormalizedBatch(
    batch: Readonly<ClaudeNormalizedEventBatch>,
    turnId: string | null,
    statusProjection: ReplayDeliveryState["statusProjection"],
  ): void {
    const prior = this.replay.get(batch.replayKey);
    if (prior !== undefined) {
      if (prior !== batch.fingerprint) {
        throw runtimeError("REPLAY_COLLISION", "Claude native event replay collided");
      }
      return;
    }
    let delivery = this.deliveringReplay.get(batch.replayKey);
    if (delivery !== undefined) {
      if (
        delivery.fingerprint !== batch.fingerprint ||
        delivery.statusProjection !== statusProjection
      ) {
        throw runtimeError("REPLAY_COLLISION", "Claude native event replay collided");
      }
      if (delivery.delivering) return;
    } else {
      if (this.replay.size + this.deliveringReplay.size >= this.maxReplayEvents) {
        throw runtimeError("REPLAY_CAPACITY", "Claude native event replay capacity is exhausted");
      }
      delivery = {
        fingerprint: batch.fingerprint,
        statusProjection,
        nextDiagnosticIndex: 0,
        nextEventIndex: 0,
        modelValidated: false,
        modelCommitted: false,
        delivering: false,
      };
      this.deliveringReplay.set(batch.replayKey, delivery);
    }
    const completesTurn = this.turnTerminalStatus(batch, turnId) !== null;
    if (batch.runtimeCapabilities !== null) {
      const advertised = batch.runtimeCapabilities.includes("interrupt_receipt_v1");
      this.interruptReceiptRequired = this.interruptReceiptRequired === true || advertised;
    }
    delivery.delivering = true;
    try {
      if (!delivery.modelValidated) {
        try {
          this.modelValidationLedger.append(batch.modelObservations);
          delivery.modelValidated = true;
        } catch (error) {
          this.deliveringReplay.delete(batch.replayKey);
          throw error;
        }
      }
      while (delivery.nextEventIndex < batch.events.length) {
        const normalized = batch.events[delivery.nextEventIndex]!;
        if (delivery.nextDiagnosticIndex <= delivery.nextEventIndex) {
          this.retainBackendDiagnostic(normalized);
          delivery.nextDiagnosticIndex = delivery.nextEventIndex + 1;
        }
        const event = statusProjection === "user-cancelled" &&
          normalized.event.type === "status" &&
          normalized.event.scope === "turn" &&
          normalized.event.nativeId === turnId &&
          normalized.event.status === CLAUDE_INTERRUPT_ERROR_RESULT_STATUS
          ? Object.freeze({ ...normalized.event, status: USER_CANCELLED_STATUS })
          : normalized.event;
        this.emit(event);
        if (this.stopped) {
          this.deliveringReplay.delete(batch.replayKey);
          return;
        }
        delivery.nextEventIndex += 1;
      }
      if (this.stopped) {
        this.deliveringReplay.delete(batch.replayKey);
        return;
      }
      if (!delivery.modelCommitted) {
        try {
          this.modelLedger.append(batch.modelObservations);
          delivery.modelCommitted = true;
        } catch (error) {
          this.deliveringReplay.delete(batch.replayKey);
          throw error;
        }
      }
      this.replay.set(batch.replayKey, batch.fingerprint);
      if (completesTurn && this.activeTurnId === turnId) this.activeTurnId = null;
      this.deliveringReplay.delete(batch.replayKey);
    } finally {
      delivery.delivering = false;
    }
  }

  private turnTerminalStatus(
    batch: Readonly<ClaudeNormalizedEventBatch>,
    turnId: string | null,
  ): string | null {
    if (turnId === null) return null;
    for (const { event } of batch.events) {
      if (
        event.type === "status" && event.scope === "turn" &&
        event.nativeId === turnId
      ) return event.status;
    }
    return null;
  }

  private flushBufferedInterruptTerminal(pending: PendingUserInterrupt): void {
    const buffered = pending.bufferedTerminal;
    if (buffered === null || pending.decision === "pending") return;
    this.deliverNormalizedBatch(
      buffered.batch,
      buffered.turnId,
      pending.decision === "user-cancelled" ? "user-cancelled" : "original",
    );
    pending.bufferedTerminal = null;
    pending.terminalDelivered = true;
    if (this.pendingUserInterrupt === pending) this.pendingUserInterrupt = null;
  }

  private retainBackendDiagnostic(normalized: Readonly<ClaudeNormalizedBackendEvent>): void {
    if (normalized.rawDiagnostic === null) return;
    const retained = this.backendDiagnosticStore.retain({
      taskScope: this.backendDiagnosticTaskScope,
      sessionId: this.sessionId,
      generation: this.generation,
      eventId: normalized.eventId,
      raw: normalized.rawDiagnostic.raw,
      truncated: normalized.rawDiagnostic.truncated,
    });
    if (retained === null || this.onBackendDiagnostic === null) return;
    try {
      this.onBackendDiagnostic(retained);
    } catch {
      this.backendDiagnosticSinkFailures = Math.min(
        Number.MAX_SAFE_INTEGER,
        this.backendDiagnosticSinkFailures + 1,
      );
    }
  }

  private onProcessTerminal(): void {
    const pending = this.pendingUserInterrupt;
    if (pending !== null && pending.bufferedTerminal !== null) {
      pending.decision = "original";
      try { this.flushBufferedInterruptTerminal(pending); } catch {
        // The uncertainty projection below remains the fail-closed fallback.
      }
    }
    const activeTurnId = this.activeTurnId;
    this.stopped = true;
    if (activeTurnId !== null) {
      try {
        this.emit(Object.freeze({
          provider: "anthropic" as const,
          key: this.taskKey,
          occurredAt: strictTimestamp(this.now()),
          type: "status" as const,
          scope: "turn" as const,
          status: "runtime_failure_uncertain",
          nativeId: activeTurnId,
        }));
      } catch {
        // A hostile clock or event sink must not prevent terminal cleanup.
      }
    }
    this.activeTurnId = null;
    this.pendingUserInterrupt = null;
    this.deliveringReplay.clear();
    this.permissionBridge.close();
    this.controlPeer.close();
  }
}
