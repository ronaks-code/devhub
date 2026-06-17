/**
 * Turn bare URLs and file-path-looking tokens inside PLAIN TEXT into structured
 * tokens the Markdown renderer can wrap with clickable affordances. This runs only
 * on the text nodes react-markdown hands us — never inside fenced/inline code (the
 * Markdown code renderers don't call this), so a path in a ``` block stays verbatim.
 *
 * The detection is deliberately conservative: it only promotes tokens that clearly
 * look like a URL or a filesystem path, and it leaves all surrounding text exactly
 * as-is. When nothing matches, the caller can fast-path the original string.
 */

/** A run of the original text: either plain prose, a URL, or a file path. */
export type LinkToken =
  | { kind: "text"; value: string }
  | { kind: "url"; value: string; href: string }
  | { kind: "path"; value: string };

/**
 * Matches, in priority order:
 *  1. http(s):// and www. URLs (www. is rewritten to an https href).
 *  2. Absolute POSIX paths (/usr/local/bin), home paths (~/x), and explicitly
 *     relative paths (./x, ../x) — each requiring at least one more segment so a
 *     bare "/" or "." never matches.
 *  3. Relative dotted paths with a file extension (src/lib/api.ts, foo/bar.py) —
 *     a slash plus a 1–6 char extension keeps this from grabbing ordinary words.
 *
 * The trailing `[\w/]` (or `\w` for the extension form) anchors the end so common
 * trailing punctuation (a sentence's "." or ")") is left OUT of the token.
 */
const TOKEN_RE = new RegExp(
  [
    // URLs — http(s) or bare www.
    "(https?:\\/\\/[^\\s<>()]+[\\w\\/])",
    "(www\\.[^\\s<>()]+[\\w\\/])",
    // Absolute / home / explicitly-relative paths (need a following segment).
    "((?:~|\\.{1,2})?\\/[\\w.\\-]+(?:\\/[\\w.\\-]+)*\\/?)",
    // Relative dotted path with an extension, e.g. src/lib/api.ts.
    "([\\w.\\-]+(?:\\/[\\w.\\-]+)+\\.[A-Za-z0-9]{1,6})",
  ].join("|"),
  "g",
);

/** Trim a trailing run of sentence punctuation off a matched token (kept as text). */
function splitTrailingPunct(value: string): { token: string; trailing: string } {
  const m = /[.,;:!?)\]]+$/.exec(value);
  if (!m) return { token: value, trailing: "" };
  // Never strip everything; if the whole thing is punctuation, leave it be.
  const cut = value.length - m[0].length;
  if (cut <= 0) return { token: value, trailing: "" };
  return { token: value.slice(0, cut), trailing: value.slice(cut) };
}

/**
 * Split a plain-text string into {@link LinkToken}s. Non-matching spans become
 * `text` tokens; URLs and paths become their respective kinds. Returns a single
 * `text` token (the original) when nothing matched — so callers can cheaply detect
 * "no links here" by length === 1 && kind === "text".
 */
export function linkifyText(input: string): LinkToken[] {
  if (!input) return [{ kind: "text", value: input }];
  const out: LinkToken[] = [];
  let last = 0;
  // Reset the shared regex's lastIndex per call (it's a module-level /g regex).
  TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN_RE.exec(input)) !== null) {
    const raw = m[0];
    // Zero-width guard: a malformed match must not loop forever.
    if (raw.length === 0) {
      TOKEN_RE.lastIndex++;
      continue;
    }
    const start = m.index;
    if (start > last) out.push({ kind: "text", value: input.slice(last, start) });

    const { token, trailing } = splitTrailingPunct(raw);
    const isUrl = m[1] != null || m[2] != null;
    if (isUrl) {
      // www. tokens get an https scheme; http(s) tokens use the token as-is.
      const href = token.startsWith("www.") ? `https://${token}` : token;
      out.push({ kind: "url", value: token, href });
    } else {
      out.push({ kind: "path", value: token });
    }
    if (trailing) out.push({ kind: "text", value: trailing });
    last = start + raw.length;
  }
  if (last < input.length) out.push({ kind: "text", value: input.slice(last) });
  // Nothing matched → a single text token (lets callers fast-path).
  return out.length > 0 ? out : [{ kind: "text", value: input }];
}

/** True when {@link linkifyText} would find at least one URL/path to promote. */
export function hasLinkable(input: string): boolean {
  if (!input) return false;
  TOKEN_RE.lastIndex = 0;
  return TOKEN_RE.test(input);
}
