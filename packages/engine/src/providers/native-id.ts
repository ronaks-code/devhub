import { redactSecrets } from "../redact.js";

export const MAX_PROVIDER_NATIVE_ID_CHARS = 512;
export const MAX_PROVIDER_HOME_CHARS = 16_384;

/** Normalize an untrusted provider/native identifier without reflecting its value. */
export function normalizeProviderNativeId(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`${label} must be a bounded non-sensitive native id`);
  }
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > MAX_PROVIDER_NATIVE_ID_CHARS ||
    /[\u0000-\u001f\u007f]/u.test(value) || redactSecrets(normalized) !== normalized) {
    throw new TypeError(`${label} must be a bounded non-sensitive native id`);
  }
  return normalized;
}

export function isProviderNativeId(value: unknown): value is string {
  try {
    normalizeProviderNativeId(value, "native id");
    return true;
  } catch {
    return false;
  }
}
