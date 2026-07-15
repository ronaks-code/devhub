import type { ProviderRegistry } from "./registry.js";

const providerRegistryInstances = new WeakSet<object>();

export function brandProviderRegistryInstance(value: ProviderRegistry): void {
  providerRegistryInstances.add(value);
}

export function isProviderRegistryInstance(value: unknown): value is ProviderRegistry {
  return value !== null && (typeof value === "object" || typeof value === "function") &&
    providerRegistryInstances.has(value as object);
}
