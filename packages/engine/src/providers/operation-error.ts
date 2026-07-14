import type { NativeTask } from "./types.js";

export type ProviderOperationErrorCode =
  | "DISABLED"
  | "DISPOSED"
  | "INVALID_INPUT"
  | "MUTATION_UNCERTAIN"
  | "OWNERSHIP"
  | "PARTIAL_FORK"
  | "PARTIAL_START"
  | "POLICY_MISMATCH"
  | "RECONCILIATION_REQUIRED"
  | "SUBSCRIPTION_CAPACITY"
  | "UNSAFE_OVERRIDE"
  | "UNSUPPORTED_INTERACTION";

const CODES: ReadonlySet<string> = new Set<ProviderOperationErrorCode>([
  "DISABLED",
  "DISPOSED",
  "INVALID_INPUT",
  "MUTATION_UNCERTAIN",
  "OWNERSHIP",
  "PARTIAL_FORK",
  "PARTIAL_START",
  "POLICY_MISMATCH",
  "RECONCILIATION_REQUIRED",
  "SUBSCRIPTION_CAPACITY",
  "UNSAFE_OVERRIDE",
  "UNSUPPORTED_INTERACTION",
]);

export function isProviderOperationErrorCode(
  value: unknown,
): value is ProviderOperationErrorCode {
  return typeof value === "string" && CODES.has(value);
}

/** Typed adapter failure. Registries re-snapshot its optional task before exposure. */
export class ProviderOperationError<
  TCode extends ProviderOperationErrorCode = ProviderOperationErrorCode,
> extends Error {
  readonly code: TCode;
  readonly task?: Readonly<NativeTask>;

  constructor(
    code: TCode,
    message: string,
    options: { readonly cause?: unknown; readonly task?: Readonly<NativeTask> } = {},
  ) {
    if (!isProviderOperationErrorCode(code)) throw new TypeError("Invalid provider operation code");
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ProviderOperationError";
    this.code = code;
    if (options.task !== undefined) this.task = options.task;
  }
}

export function safeProviderOperationMessage(code: ProviderOperationErrorCode): string {
  switch (code) {
    case "INVALID_INPUT": return "Provider input is invalid";
    case "MUTATION_UNCERTAIN": return "Provider mutation outcome is uncertain; do not retry automatically";
    case "UNSAFE_OVERRIDE": return "Provider override is not allowed";
    case "POLICY_MISMATCH": return "Provider did not preserve the requested policy";
    case "RECONCILIATION_REQUIRED": return "Provider state must be reconciled before another mutation";
    case "PARTIAL_START": return "Provider created a task but did not finish starting it";
    case "PARTIAL_FORK": return "Provider created a fork but did not finish configuring it";
    case "DISABLED": return "Provider runtime is disabled";
    case "DISPOSED": return "Provider runtime is unavailable";
    case "OWNERSHIP": return "Provider ownership validation failed";
    case "SUBSCRIPTION_CAPACITY": return "Provider subscription capacity was reached";
    case "UNSUPPORTED_INTERACTION": return "Provider interaction is not supported";
  }
}
