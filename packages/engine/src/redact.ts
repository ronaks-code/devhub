/**
 * Secret redaction for anything we persist or echo back that may contain
 * free-text. PURE: `redactSecrets(text)` returns a copy with credential-shaped
 * substrings masked as `[REDACTED]`, leaving the surrounding text intact.
 *
 * Used in two places:
 *  - the audit log masks any free-text it stores (the `reason` note); structured
 *    fields like `toolName`/`decision`/`scope` are safe and left untouched.
 *  - the server redacts permission-prompt payloads before logging/forwarding them.
 *
 * The patterns target the common shapes leaked in tool I/O and prompts: provider
 * API keys (OpenAI `sk-…`, GitHub `ghp_…`/`gho_…`/etc., Slack `xox…`, Google
 * `AIza…`), AWS access-key ids and `aws_secret_access_key=…`, JWTs, `Bearer …`
 * tokens, DB connection strings with inline credentials (`postgres://user:pw@…`),
 * and `.env`-style `KEY=secret` / quoted `"password": "…"` assignments.
 *
 * Conservative by design: false positives merely over-mask a value (we never DROP
 * surrounding text), and the ordering of rules matters — broader connection-string
 * and assignment rules run before the narrower token rules so a secret inside a URL
 * or assignment is masked as a unit rather than partially.
 */

/** The replacement token written in place of a detected secret. */
const MASK = "[REDACTED]";

/**
 * Names that, when used as a `KEY=value` / `"key": "value"` assignment, mark the
 * value as sensitive. Matched case-insensitively; a `KEY` ending in one of these
 * also counts (e.g. `DATABASE_PASSWORD`, `MY_API_TOKEN`).
 */
const SECRET_KEY_WORDS = [
  "password",
  "passwd",
  "secret",
  "token",
  "apikey",
  "api_key",
  "access_key",
  "secret_key",
  "private_key",
  "client_secret",
  "auth",
  "credential",
  "credentials",
];

/**
 * One redaction rule. Rules run in array order; each replaces every match of its
 * regex. A `replace` function lets a rule keep a structural prefix (e.g. the
 * `KEY=` or `scheme://user:` part) and mask only the secret tail.
 */
interface Rule {
  re: RegExp;
  replace: (match: string, ...groups: string[]) => string;
}

const keyWordAlt = SECRET_KEY_WORDS.join("|");

const RULES: Rule[] = [
  // ---- Structural rules first (mask the secret WITHIN a larger token) ----

  // DB / service connection strings with inline credentials:
  //   scheme://user:password@host  ->  scheme://user:[REDACTED]@host
  // Covers postgres/postgresql/mysql/mongodb(+srv)/redis/amqp/etc. Only the
  // password segment between `:` and `@` is masked; the rest of the URL stays.
  {
    re: /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+):([^\s:/@]+)@/gi,
    replace: (_m, prefix: string) => `${prefix}:${MASK}@`,
  },

  // `KEY = value` / `KEY: value` / `"key": "value"` where KEY names a secret.
  // Keeps the key + separator, masks the (optionally quoted) value. Stops at
  // whitespace, comma, or closing quote/brace so we don't swallow trailing JSON.
  {
    re: new RegExp(
      String.raw`(["']?[\w.-]*(?:${keyWordAlt})["']?\s*[:=]\s*)(["']?)([^\s"',}{)]+)(\2)`,
      "gi",
    ),
    replace: (_m, prefix: string, openQuote: string, _val: string, closeQuote: string) =>
      `${prefix}${openQuote}${MASK}${closeQuote}`,
  },

  // ---- Provider-specific token shapes ----

  // OpenAI-style keys: `sk-…`, `sk-proj-…`, `rk-…` (>= 16 chars of body).
  { re: /\b(?:sk|rk)-(?:proj-)?[A-Za-z0-9_-]{16,}/g, replace: () => MASK },

  // GitHub tokens: ghp_/gho_/ghu_/ghs_/ghr_ + 36+ base62 chars.
  { re: /\bgh[pousr]_[A-Za-z0-9]{20,}/g, replace: () => MASK },

  // Slack tokens: xoxb-/xoxp-/xoxa-/xoxr-… .
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g, replace: () => MASK },

  // Google API keys: `AIza` + 35 chars.
  { re: /\bAIza[A-Za-z0-9_-]{35}\b/g, replace: () => MASK },

  // AWS access key id: AKIA/ASIA/AGPA/… + 16 uppercase alphanumerics.
  { re: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA)[A-Z0-9]{16}\b/g, replace: () => MASK },

  // `Bearer <token>` Authorization values — mask the token, keep the scheme.
  {
    re: /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
    replace: (_m, scheme: string) => `${scheme} ${MASK}`,
  },

  // JWTs: three base64url segments separated by dots (header.payload.signature).
  {
    re: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
    replace: () => MASK,
  },
];

/**
 * Mask credential-shaped substrings in `text`, returning a redacted copy. Pure and
 * side-effect free. A non-string input (or empty/blank string) is returned as-is
 * (after `String()` coercion of nullish to ""), so callers can pass an optional
 * field straight through.
 */
export function redactSecrets(text: string | null | undefined): string {
  if (text == null) return "";
  let out = String(text);
  if (!out) return out;
  for (const rule of RULES) {
    out = out.replace(rule.re, rule.replace as (substring: string, ...args: unknown[]) => string);
  }
  return out;
}

/**
 * Redact the free-text fields of an arbitrary, JSON-ish payload IN A COPY: walks
 * objects/arrays and runs {@link redactSecrets} over every string leaf. Used by the
 * server to scrub a permission-prompt payload (tool input, reasons, etc.) before it
 * is logged or forwarded. Non-string leaves (numbers/booleans/null) pass through.
 * Cycles are not expected in these plain payloads and are not guarded against.
 */
export function redactDeep<T>(value: T): T {
  if (typeof value === "string") return redactSecrets(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactDeep(v);
    }
    return out as unknown as T;
  }
  return value;
}
