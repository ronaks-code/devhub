export type ClaudeProgrammaticAuthMethod =
  | "api-key"
  | "workload-identity"
  | "bedrock"
  | "vertex"
  | "foundry";

export interface ClaudeProgrammaticAuthDecision {
  readonly authorized: boolean;
  readonly method: ClaudeProgrammaticAuthMethod | null;
}

export type ClaudeAuthPolicyErrorCode =
  | "AMBIGUOUS_AUTH"
  | "INVALID_ENVIRONMENT"
  | "UNAUTHORIZED_AUTH";

export class ClaudeAuthPolicyError extends Error {
  readonly code: ClaudeAuthPolicyErrorCode;

  constructor(code: ClaudeAuthPolicyErrorCode, message: string) {
    super(message);
    this.name = "ClaudeAuthPolicyError";
    this.code = code;
    Object.freeze(this);
  }
}

const RELEVANT_KEYS = Object.freeze([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
  "ANTHROPIC_VERTEX_PROJECT_ID",
  "GCLOUD_PROJECT",
  "CLOUD_ML_REGION",
  "ANTHROPIC_FOUNDRY_RESOURCE",
] as const);

type RelevantKey = (typeof RELEVANT_KEYS)[number];
type AuthEnvironment = Readonly<Partial<Record<RelevantKey, string>>>;

const policyError = (
  code: ClaudeAuthPolicyErrorCode,
  message: string,
): ClaudeAuthPolicyError => new ClaudeAuthPolicyError(code, message);

const snapshotEnvironment = (value: unknown): AuthEnvironment => {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new Error();
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string")) throw new Error();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const snapshot: Partial<Record<RelevantKey, string>> = {};
    for (const key of RELEVANT_KEYS) {
      const descriptor = descriptors[key];
      if (!descriptor) continue;
      if (!descriptor.enumerable || !("value" in descriptor)) throw new Error();
      if (descriptor.value === undefined) continue;
      if (typeof descriptor.value !== "string") throw new Error();
      snapshot[key] = descriptor.value;
    }
    return Object.freeze(snapshot);
  } catch {
    throw policyError("INVALID_ENVIRONMENT", "Claude auth environment is invalid");
  }
};

const configured = (value: string | undefined): boolean =>
  typeof value === "string" &&
  value.length > 0 &&
  value.trim() === value &&
  !value.includes("\u0000");

const enabled = (value: string | undefined): boolean => value === "1" || value === "true";

const decision = (
  method: ClaudeProgrammaticAuthMethod | null,
): Readonly<ClaudeProgrammaticAuthDecision> => Object.freeze({
  authorized: method !== null,
  method,
});

/**
 * Classifies only credentials suitable for programmatic product use. A stored
 * Claude-app/Pro/Max OAuth login is intentionally not an accepted fallback.
 * Credential values are never copied into the returned decision or an error.
 */
export function evaluateClaudeProgrammaticAuth(
  environment: Readonly<NodeJS.ProcessEnv> | Readonly<Record<string, string>>,
): Readonly<ClaudeProgrammaticAuthDecision> {
  const env = snapshotEnvironment(environment);
  const methods: ClaudeProgrammaticAuthMethod[] = [];
  if (configured(env.ANTHROPIC_API_KEY)) methods.push("api-key");
  if (configured(env.ANTHROPIC_AUTH_TOKEN)) methods.push("workload-identity");
  if (
    enabled(env.CLAUDE_CODE_USE_BEDROCK) &&
    (configured(env.AWS_REGION) || configured(env.AWS_DEFAULT_REGION))
  ) methods.push("bedrock");
  if (
    enabled(env.CLAUDE_CODE_USE_VERTEX) &&
    (configured(env.ANTHROPIC_VERTEX_PROJECT_ID) || configured(env.GCLOUD_PROJECT)) &&
    configured(env.CLOUD_ML_REGION)
  ) methods.push("vertex");
  if (
    enabled(env.CLAUDE_CODE_USE_FOUNDRY) &&
    configured(env.ANTHROPIC_FOUNDRY_RESOURCE)
  ) methods.push("foundry");
  if (methods.length > 1) {
    throw policyError(
      "AMBIGUOUS_AUTH",
      "Claude persistent runtime requires exactly one programmatic authentication method",
    );
  }
  return decision(methods[0] ?? null);
}

export function requireClaudeProgrammaticAuth(
  environment: Readonly<NodeJS.ProcessEnv> | Readonly<Record<string, string>>,
): Readonly<ClaudeProgrammaticAuthDecision> {
  const result = evaluateClaudeProgrammaticAuth(environment);
  if (!result.authorized) {
    throw policyError(
      "UNAUTHORIZED_AUTH",
      "Claude persistent runtime requires programmatic API or cloud authentication",
    );
  }
  return result;
}
