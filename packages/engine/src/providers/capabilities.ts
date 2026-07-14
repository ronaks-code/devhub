import type { ProviderCapabilities, ProviderId } from "./types.js";

export type ProviderCapability = keyof ProviderCapabilities;

export const DEFAULT_PROVIDER_CAPABILITIES: Readonly<ProviderCapabilities> = Object.freeze({
  list: false,
  read: false,
  start: false,
  resume: false,
  fork: false,
  send: false,
  steer: false,
  interrupt: false,
  subscribe: false,
  approveCommand: false,
  approveFileChange: false,
  approvePermissions: false,
  requestUserInput: false,
  mcpElicitation: false,
  archive: false,
  rename: false,
  skills: false,
  plugins: false,
  hooks: false,
  mcp: false,
  backgroundWork: false,
});

export class ProviderCapabilityError extends Error {
  readonly code = "PROVIDER_CAPABILITY_UNAVAILABLE";

  constructor(
    readonly capability: ProviderCapability,
    readonly provider?: ProviderId,
  ) {
    super(
      `${provider ? `${provider} ` : ""}provider capability ${capability} is unavailable`,
    );
    this.name = "ProviderCapabilityError";
  }
}

export function defineProviderCapabilities(
  enabled: Partial<ProviderCapabilities> = {},
): Readonly<ProviderCapabilities> {
  const capabilities = { ...DEFAULT_PROVIDER_CAPABILITIES };
  for (const capability of Object.keys(DEFAULT_PROVIDER_CAPABILITIES) as ProviderCapability[]) {
    if (!Object.prototype.hasOwnProperty.call(enabled, capability)) continue;
    const value = enabled[capability];
    if (typeof value !== "boolean") {
      throw new TypeError(`provider capability ${capability} must be an explicit boolean`);
    }
    capabilities[capability] = value;
  }
  return Object.freeze(capabilities);
}

export function requireProviderCapability(
  capabilities: ProviderCapabilities,
  capability: ProviderCapability,
  provider?: ProviderId,
): void {
  if (capabilities[capability] !== true) {
    throw new ProviderCapabilityError(capability, provider);
  }
}
