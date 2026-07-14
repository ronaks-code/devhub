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

const isSecretAssignmentKey = (value: string): boolean => {
  const normalized = value.toLowerCase();
  return SECRET_KEY_WORDS.some((word) => normalized.endsWith(word));
};

/**
 * One redaction rule. Rules run in array order; each replaces every match of its
 * regex. A `replace` function lets a rule keep a structural prefix (e.g. the
 * `KEY=` or `scheme://user:` part) and mask only the secret tail.
 */
interface Rule {
  re: RegExp;
  replace: (match: string, ...groups: string[]) => string;
}

const CONNECTION_STRING_RULE: Rule = {
  // DB / service connection strings with inline credentials:
  //   scheme://user:password@host  ->  scheme://user:[REDACTED]@host
  re: /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+):([^\s:/@]+)@/gi,
  replace: (_m, prefix: string) => `${prefix}:${MASK}@`,
};

const TOKEN_RULES: Rule[] = [

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

interface AssignmentRange {
  readonly start: number;
  readonly end: number;
}

interface AssignmentScan {
  readonly ranges: readonly AssignmentRange[];
  readonly hasUnclosedQuotedValue: boolean;
}

interface ParsedSensitiveAssignment extends AssignmentRange {
  readonly nextIndex: number;
  readonly unclosedQuotedValue: boolean;
}

const isAssignmentKeyCharacter = (value: string): boolean =>
  value === "." || value === "-" || value === "_" ||
  (value >= "0" && value <= "9") ||
  (value >= "A" && value <= "Z") ||
  (value >= "a" && value <= "z");

const isQuote = (value: string | undefined): value is "\"" | "'" =>
  value === "\"" || value === "'";

const isWhitespace = (value: string | undefined): boolean =>
  value !== undefined && /\s/u.test(value);

const isUnquotedValueTerminator = (value: string): boolean =>
  isWhitespace(value) || value === "\"" || value === "'" || value === "," ||
  value === "}" || value === "{" || value === ")";

/** Parse one sensitive assignment at an exact token boundary in linear time. */
function parseSensitiveAssignmentAt(
  value: string,
  start: number,
): ParsedSensitiveAssignment | null {
  if (start > 0 && isAssignmentKeyCharacter(value[start - 1]!)) return null;
  let index = start;
  if (isQuote(value[index])) index += 1;
  const keyStart = index;
  while (index < value.length && isAssignmentKeyCharacter(value[index]!)) index += 1;
  if (index === keyStart) return null;
  const key = value.slice(keyStart, index);
  if (!isSecretAssignmentKey(key)) return null;

  // Accept either key quote conservatively. Malformed provider text such as
  // `"password': value` must mask rather than regain visibility.
  if (isQuote(value[index])) index += 1;
  while (index < value.length && isWhitespace(value[index])) index += 1;
  if (value[index] !== ":" && value[index] !== "=") return null;
  index += 1;
  while (index < value.length && isWhitespace(value[index])) index += 1;

  const quote = isQuote(value[index]) ? value[index] : null;
  if (quote !== null) {
    index += 1;
    // Preserve whitespace immediately inside the opening quote for stable copy,
    // but redact every subsequent character through the matching close quote.
    while (index < value.length && isWhitespace(value[index])) index += 1;
    const secretStart = index;
    let escaped = false;
    while (index < value.length) {
      const character = value[index]!;
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        return {
          start: secretStart,
          end: index,
          nextIndex: index + 1,
          unclosedQuotedValue: false,
        };
      }
      index += 1;
    }
    return {
      start: secretStart,
      end: value.length,
      nextIndex: value.length,
      unclosedQuotedValue: true,
    };
  }

  const secretStart = index;
  while (index < value.length && !isUnquotedValueTerminator(value[index]!)) index += 1;
  if (index === secretStart) return null;
  return {
    start: secretStart,
    end: index,
    nextIndex: index,
    unclosedQuotedValue: false,
  };
}

function scanSensitiveAssignments(value: string): AssignmentScan {
  const ranges: AssignmentRange[] = [];
  let hasUnclosedQuotedValue = false;
  let index = 0;
  while (index < value.length) {
    const parsed = parseSensitiveAssignmentAt(value, index);
    if (!parsed) {
      index += 1;
      continue;
    }
    ranges.push({ start: parsed.start, end: parsed.end });
    hasUnclosedQuotedValue ||= parsed.unclosedQuotedValue;
    index = Math.max(index + 1, parsed.nextIndex);
  }
  return { ranges, hasUnclosedQuotedValue };
}

function redactSensitiveAssignments(value: string): string {
  const { ranges } = scanSensitiveAssignments(value);
  if (ranges.length === 0) return value;
  let output = "";
  let cursor = 0;
  for (const range of ranges) {
    output += value.slice(cursor, range.start);
    output += MASK;
    cursor = range.end;
  }
  return output + value.slice(cursor);
}

/** True when a sensitive quoted assignment has no matching close quote yet. */
export function hasUnclosedSensitiveQuotedAssignment(value: string): boolean {
  return scanSensitiveAssignments(value).hasUnclosedQuotedValue;
}

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
  out = out.replace(
    CONNECTION_STRING_RULE.re,
    CONNECTION_STRING_RULE.replace as (substring: string, ...args: unknown[]) => string,
  );
  for (const rule of TOKEN_RULES) {
    out = out.replace(rule.re, rule.replace as (substring: string, ...args: unknown[]) => string);
  }
  // Assignment parsing runs after standalone token shapes so a value such as
  // `auth: Bearer <token>` cannot lose its scheme before the token is masked.
  out = redactSensitiveAssignments(out);
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
