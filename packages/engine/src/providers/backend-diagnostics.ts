import { redactSecrets } from "../redact.js";
import {
  normalizeProviderEvent,
  type ProviderEvent,
  type ProviderEventContext,
} from "./events.js";

export const MAX_DIAGNOSTIC_RAW_CHARS = 2_048;

export interface BackendRawDiagnostic {
  readonly raw: string;
  readonly truncated: boolean;
}

export interface BackendProviderEventEnvelope {
  readonly event: ProviderEvent;
  readonly rawDiagnostic: BackendRawDiagnostic | null;
}

function isSensitiveDiagnosticKey(key: string): boolean {
  const compact = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return compact.includes("reasoning") ||
    compact.includes("chainofthought") ||
    compact.includes("hiddenthought") ||
    compact.includes("privatethought") ||
    compact.includes("authorization") ||
    compact.includes("credential") ||
    compact.includes("password") ||
    compact.includes("secret") ||
    compact.includes("apikey") ||
    compact.includes("accesstoken") ||
    compact.includes("refreshtoken") ||
    compact.includes("idtoken") ||
    compact.includes("authtoken") ||
    compact.includes("cookie");
}

function boundedRawDiagnostic(value: unknown): BackendRawDiagnostic {
  const seen = new WeakSet<object>();
  let serialized: string;
  try {
    serialized = JSON.stringify(value, (key, child: unknown) => {
      if (key && isSensitiveDiagnosticKey(key)) return "[REDACTED]";
      if (typeof child === "bigint") return child.toString();
      if (child && typeof child === "object") {
        if (seen.has(child)) return "[Circular]";
        seen.add(child);
      }
      return child;
    }) ?? String(value);
  } catch {
    serialized = String(value);
  }
  const redacted = redactSecrets(serialized);
  if (redacted.length <= MAX_DIAGNOSTIC_RAW_CHARS) {
    return Object.freeze({ raw: redacted, truncated: false });
  }
  return Object.freeze({
    raw: redacted.slice(0, MAX_DIAGNOSTIC_RAW_CHARS),
    truncated: true,
  });
}

/** Backend-only normalization that retains a bounded diagnostic payload beside the browser-safe event. */
export function normalizeProviderEventWithBackendDiagnostics(
  input: unknown,
  context: ProviderEventContext,
): BackendProviderEventEnvelope {
  const event = normalizeProviderEvent(input, context);
  return Object.freeze({
    event,
    rawDiagnostic: event.type === "diagnostic" ? boundedRawDiagnostic(input) : null,
  });
}
