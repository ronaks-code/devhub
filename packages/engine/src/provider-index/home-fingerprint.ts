import { createHash } from "node:crypto";
import type { ProviderId } from "../providers/types.js";

export function hashPersistedProviderHome(
  provider: ProviderId,
  canonicalHome: string,
): string {
  return createHash("sha256")
    .update(`devhub-home:v1\u0000${provider}\u0000${canonicalHome}`, "utf8")
    .digest("hex");
}
