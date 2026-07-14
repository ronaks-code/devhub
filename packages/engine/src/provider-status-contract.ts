/** Browser-safe status vocabulary shared by provider adapters and the native UI. */
export const RUNTIME_FAILURE_UNCERTAIN_STATUS = "runtime_failure_uncertain" as const;
export const USER_CANCELLED_STATUS = "cancelled_by_user" as const;

export const PROVIDER_ACTIVE_STATUS_TOKENS = Object.freeze([
  "active",
  "compacting",
  "inprogress",
  "initialized",
  "pending",
  "queued",
  "requesting",
  "running",
  "started",
  "streaming",
] as const);

export const PROVIDER_TERMINAL_STATUS_TOKENS = Object.freeze([
  "aborted",
  "canceled",
  "cancelled",
  "cancelledbyuser",
  "complete",
  "completed",
  "error",
  "errorduringexecution",
  "errormaxbudgetusd",
  "errormaxstructuredoutputretries",
  "errormaxturns",
  "failed",
  "failure",
  "interrupted",
  "runtimefailureuncertain",
  "stopped",
  "success",
] as const);

const ACTIVE_STATUS_TOKENS = new Set<string>(PROVIDER_ACTIVE_STATUS_TOKENS);
const TERMINAL_STATUS_TOKENS = new Set<string>(PROVIDER_TERMINAL_STATUS_TOKENS);

export function providerStatusToken(status: string): string {
  return status.toLowerCase().replace(/[^a-z0-9]/gu, "");
}

export function isProviderActiveStatus(status: string): boolean {
  return ACTIVE_STATUS_TOKENS.has(providerStatusToken(status));
}

export function isProviderTerminalStatus(status: string): boolean {
  return TERMINAL_STATUS_TOKENS.has(providerStatusToken(status));
}

export function isRuntimeFailureUncertainStatus(status: string): boolean {
  return providerStatusToken(status) === "runtimefailureuncertain";
}

export function isUserCancelledStatus(status: string): boolean {
  return providerStatusToken(status) === "cancelledbyuser";
}
