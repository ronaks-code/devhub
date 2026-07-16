/**
 * M7: Work-mode engine foundation.
 *
 * "Work mode" is a DISTINCT task model from Code mode (the existing
 * `NativeTask`/`ProviderAdapter` surface everywhere else in `./providers`). Code
 * mode is a live, turn-by-turn conversational session against a provider runtime.
 * Work mode is a bounded UNIT OF WORK: it binds to a real provider runtime (never a
 * mock/simulated one), is scoped to one folder on disk, carries its own permission
 * profile (deliberately separate from a Code-mode task's `permissionMode` override),
 * tracks outcome/progress distinct from Code-mode turn status, and produces
 * artifacts (raw files/output it wrote) and deliverables (the reviewable claims of
 * "this is done" that artifacts back up).
 *
 * This module is intentionally never named or aliased "Cowork" anywhere — the
 * exported kind literal is `"work"`, every type/class is prefixed `WorkMode`, and
 * nothing in this file re-exports under any other name.
 *
 * Everything here is gated behind the default-off `workMode` feature flag (see
 * `feature-flags.ts`); every entry point throws {@link WorkModeDisabledError} when
 * the flag is not explicitly `true`.
 */
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { DevHubFeatureFlags } from "./feature-flags.js";
import type { NativeTaskKey, ProviderId } from "./types.js";

/** Thrown by every entry point in this module when `workMode` is not `true`. */
export class WorkModeDisabledError extends Error {
  readonly code = "WORK_MODE_DISABLED";
  constructor() {
    super("workMode feature flag is not enabled");
    this.name = "WorkModeDisabledError";
  }
}

/** Thrown when a path (artifact, write target, etc.) escapes the task's folder scope. */
export class WorkModeFolderScopeViolationError extends Error {
  readonly code = "WORK_MODE_FOLDER_SCOPE_VIOLATION";
  constructor(
    readonly path: string,
    readonly root: string,
  ) {
    super(`path "${path}" is outside the work task's folder scope root "${root}"`);
    this.name = "WorkModeFolderScopeViolationError";
  }
}

/** Thrown when an action is not permitted by the task's permission profile. */
export class WorkModePermissionDeniedError extends Error {
  readonly code = "WORK_MODE_PERMISSION_DENIED";
  constructor(readonly action: string) {
    super(`action "${action}" is not permitted by this work task's permission profile`);
    this.name = "WorkModePermissionDeniedError";
  }
}

/**
 * Discriminant literal for a work-mode task. Deliberately NOT `"cowork"` and never
 * aliased as such; a Code-mode `NativeTask` carries no `kind` field at all, so this
 * discriminant alone is enough to tell the two models apart (see {@link isWorkModeTask}).
 */
export const WORK_MODE_KIND = "work" as const;
export type WorkModeKind = typeof WORK_MODE_KIND;

/**
 * A real provider runtime binding: which provider, which home, and the concrete
 * native task (Code-mode's own `NativeTaskKey`) that runtime binding runs through.
 * There is deliberately no "simulated"/"mock" variant — a work-mode task always
 * binds to an actual provider runtime via the existing native task key shape.
 */
export interface WorkModeRuntimeBinding {
  readonly provider: ProviderId;
  readonly home: string;
  readonly nativeTaskKey: Readonly<NativeTaskKey>;
}

/**
 * The single folder a work task is allowed to touch. `writablePaths` defaults to
 * `[root]` when omitted; every writable path must itself resolve inside `root`.
 */
export interface WorkModeFolderScope {
  readonly root: string;
  readonly writablePaths?: readonly string[];
}

/**
 * Distinct from Code mode's `TaskOverrides.permissionMode` (a single provider-native
 * string knob). A work-mode permission profile is an explicit allow/deny action list
 * enforced by THIS module, independent of whatever the bound provider runtime's own
 * permission mode is doing.
 */
export interface WorkModePermissionProfile {
  readonly allowedActions: readonly string[];
  readonly deniedActions?: readonly string[];
}

export type WorkModeOutcomeStatus =
  | "pending"
  | "in-progress"
  | "delivered"
  | "failed"
  | "cancelled";

export interface WorkModeProgress {
  readonly status: WorkModeOutcomeStatus;
  readonly summary: string;
  readonly updatedAt: string;
}

/** Raw output the work task produced. Always required to sit inside the folder scope. */
export interface WorkModeArtifact {
  readonly path: string;
  readonly kind: "file" | "diff" | "log" | "other";
  readonly createdAt: string;
}

/**
 * A reviewable "this is done" claim. `satisfiedByArtifactPaths` must reference
 * artifacts already recorded on the task (enforced by {@link addWorkModeDeliverable}).
 */
export interface WorkModeDeliverable {
  readonly id: string;
  readonly description: string;
  readonly satisfiedByArtifactPaths: readonly string[];
}

export interface WorkModeTask {
  readonly kind: WorkModeKind;
  readonly id: string;
  readonly runtime: Readonly<WorkModeRuntimeBinding>;
  readonly folderScope: Readonly<WorkModeFolderScope>;
  readonly permissionProfile: Readonly<WorkModePermissionProfile>;
  readonly progress: Readonly<WorkModeProgress>;
  readonly artifacts: readonly WorkModeArtifact[];
  readonly deliverables: readonly WorkModeDeliverable[];
}

export interface CreateWorkModeTaskInput {
  readonly id: string;
  readonly runtime: WorkModeRuntimeBinding;
  readonly folderScope: WorkModeFolderScope;
  readonly permissionProfile: WorkModePermissionProfile;
}

function requireFlag(flags: Pick<DevHubFeatureFlags, "workMode">): void {
  if (flags.workMode !== true) throw new WorkModeDisabledError();
}

/** True only for an actual work-mode task; a Code-mode `NativeTask` has no `kind` field. */
export function isWorkModeTask(value: unknown): value is WorkModeTask {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { kind?: unknown }).kind === WORK_MODE_KIND
  );
}

/** Resolve `candidate` against `root` and confirm it does not escape the root. */
export function assertPathInFolderScope(scope: Pick<WorkModeFolderScope, "root">, candidate: string): string {
  const root = resolve(scope.root);
  const resolved = isAbsolute(candidate) ? resolve(candidate) : resolve(root, candidate);
  const rel = relative(root, resolved);
  const escapes = rel === ".." || rel.startsWith(`..${sep}`) || (isAbsolute(rel) && rel !== "");
  if (escapes) {
    throw new WorkModeFolderScopeViolationError(candidate, root);
  }
  return resolved;
}

function assertWritablePathsInScope(folderScope: WorkModeFolderScope): void {
  for (const path of folderScope.writablePaths ?? []) {
    assertPathInFolderScope(folderScope, path);
  }
}

/** Deny wins over allow; an action absent from both lists is denied by default. */
export function assertActionPermitted(
  profile: Pick<WorkModePermissionProfile, "allowedActions" | "deniedActions">,
  action: string,
): void {
  if (profile.deniedActions?.includes(action)) {
    throw new WorkModePermissionDeniedError(action);
  }
  if (!profile.allowedActions.includes(action)) {
    throw new WorkModePermissionDeniedError(action);
  }
}

/**
 * Create a new work-mode task. Pure/synchronous: does not itself start any provider
 * runtime (the caller is expected to have already obtained `runtime.nativeTaskKey`
 * through the real `ProviderRegistry`, exactly like every other native task). Starts
 * with empty artifacts/deliverables and `pending` progress.
 */
export function createWorkModeTask(
  flags: Pick<DevHubFeatureFlags, "workMode">,
  input: CreateWorkModeTaskInput,
): WorkModeTask {
  requireFlag(flags);
  assertWritablePathsInScope(input.folderScope);
  return Object.freeze({
    kind: WORK_MODE_KIND,
    id: input.id,
    runtime: Object.freeze({ ...input.runtime }),
    folderScope: Object.freeze({ ...input.folderScope }),
    permissionProfile: Object.freeze({ ...input.permissionProfile }),
    progress: Object.freeze({
      status: "pending",
      summary: "work task created; no work has started yet",
      updatedAt: new Date().toISOString(),
    }),
    artifacts: Object.freeze([]),
    deliverables: Object.freeze([]),
  });
}

/**
 * Advance a work task's outcome/progress. Requires the `progress:update` action in
 * the task's permission profile. Returns a new, frozen task (the input is never
 * mutated).
 */
export function updateWorkModeProgress(
  flags: Pick<DevHubFeatureFlags, "workMode">,
  task: WorkModeTask,
  next: Pick<WorkModeProgress, "status" | "summary">,
): WorkModeTask {
  requireFlag(flags);
  assertActionPermitted(task.permissionProfile, "progress:update");
  return Object.freeze({
    ...task,
    progress: Object.freeze({
      status: next.status,
      summary: next.summary,
      updatedAt: new Date().toISOString(),
    }),
  });
}

/**
 * Record a new artifact. Requires the `artifact:record` action, and the artifact's
 * path must resolve inside the task's folder scope (a work task can only ever claim
 * to have produced output inside the folder it was scoped to). Returns a new, frozen
 * task.
 */
export function recordWorkModeArtifact(
  flags: Pick<DevHubFeatureFlags, "workMode">,
  task: WorkModeTask,
  artifact: Omit<WorkModeArtifact, "createdAt">,
): WorkModeTask {
  requireFlag(flags);
  assertActionPermitted(task.permissionProfile, "artifact:record");
  assertPathInFolderScope(task.folderScope, artifact.path);
  const recorded: WorkModeArtifact = Object.freeze({
    path: artifact.path,
    kind: artifact.kind,
    createdAt: new Date().toISOString(),
  });
  return Object.freeze({
    ...task,
    artifacts: Object.freeze([...task.artifacts, recorded]),
  });
}

/**
 * Add a deliverable. Requires the `deliverable:add` action, and every referenced
 * `satisfiedByArtifactPaths` entry must already exist on `task.artifacts` — a
 * deliverable can never point at an artifact the task has not actually recorded.
 * Returns a new, frozen task.
 */
export function addWorkModeDeliverable(
  flags: Pick<DevHubFeatureFlags, "workMode">,
  task: WorkModeTask,
  deliverable: WorkModeDeliverable,
): WorkModeTask {
  requireFlag(flags);
  assertActionPermitted(task.permissionProfile, "deliverable:add");
  const knownPaths = new Set(task.artifacts.map((artifact) => artifact.path));
  for (const path of deliverable.satisfiedByArtifactPaths) {
    if (!knownPaths.has(path)) {
      throw new TypeError(
        `deliverable "${deliverable.id}" references artifact path "${path}" which was never recorded on this work task`,
      );
    }
  }
  return Object.freeze({
    ...task,
    deliverables: Object.freeze([
      ...task.deliverables,
      Object.freeze({ ...deliverable, satisfiedByArtifactPaths: Object.freeze([...deliverable.satisfiedByArtifactPaths]) }),
    ]),
  });
}
