/**
 * Suggested tags for a session, derived from cheap, observable signals about its
 * project — the language/framework it's written in (probed from marker files in the
 * working directory) plus a normalized git-branch tag for feature work.
 *
 * This is a SUGGESTION engine, not a persistence layer: {@link computeAutoTags} just
 * returns a clean string[]; a face/route decides whether to apply them (e.g. via
 * `engine.setTags`). We never write anything here.
 *
 * Detection is marker-file based and tolerant: an unreadable/absent `cwd` yields no
 * language tags (returns [] for that half), and the whole function returns [] when
 * there's nothing to go on. Tags share the engine's tag normalization
 * ({@link normalizeTags}: trim → lower-case → de-dupe), so they group cleanly with
 * user-assigned tags and the `tag` search facet.
 */
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { normalizeTags } from "./tags.js";

/** Default branches we DON'T turn into a `branch:` tag (every other branch becomes one). */
const DEFAULT_BRANCHES = new Set(["main", "master"]);

/**
 * Marker files (or, when the value is a prefix matcher, file-name prefixes) that imply a
 * tag when present at the TOP of `cwd`. A single project commonly hits several entries
 * (e.g. a Next.js repo emits "node", "typescript", "nextjs"); duplicates and ordering are
 * sorted out by {@link normalizeTags}.
 *
 * Kept deliberately small + obvious — these are SUGGESTIONS, not a full language probe.
 */
const MARKERS: ReadonlyArray<{ tag: string; files: readonly string[] }> = [
  { tag: "node", files: ["package.json"] },
  { tag: "typescript", files: ["tsconfig.json"] },
  { tag: "rust", files: ["Cargo.toml"] },
  { tag: "go", files: ["go.mod"] },
  { tag: "python", files: ["pyproject.toml", "requirements.txt", "setup.py", "Pipfile"] },
  { tag: "ruby", files: ["Gemfile"] },
  { tag: "java", files: ["pom.xml", "build.gradle", "build.gradle.kts"] },
  { tag: "php", files: ["composer.json"] },
  { tag: "docker", files: ["Dockerfile", "docker-compose.yml", "docker-compose.yaml", "compose.yaml"] },
];

/** Framework markers detected by a FILE-NAME PREFIX at the top of `cwd` (config ext varies). */
const PREFIX_MARKERS: ReadonlyArray<{ tag: string; prefix: string }> = [
  // next.config.{js,mjs,ts,cjs}
  { tag: "nextjs", prefix: "next.config." },
  // svelte.config.{js,ts}
  { tag: "svelte", prefix: "svelte.config." },
  // astro.config.{mjs,ts,js}
  { tag: "astro", prefix: "astro.config." },
  // vite.config.{js,ts,mjs}
  { tag: "vite", prefix: "vite.config." },
  // tailwind.config.{js,ts,cjs}
  { tag: "tailwind", prefix: "tailwind.config." },
];

/**
 * Normalize a git branch into a `branch:<slug>` tag, or null when it shouldn't become a
 * tag (a default branch, a detached/empty head, or a HEAD ref). The slug lower-cases and
 * replaces any run of non-alphanumeric chars with a single "-", trimming leading/trailing
 * "-", so "feature/New Login!" → "branch:feature-new-login". {@link normalizeTags} dedupes
 * it against the rest.
 */
export function branchTag(gitBranch: string | null | undefined): string | null {
  if (typeof gitBranch !== "string") return null;
  const raw = gitBranch.trim();
  if (!raw || raw === "HEAD") return null; // detached / unknown head
  if (DEFAULT_BRANCHES.has(raw.toLowerCase())) return null;
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug ? `branch:${slug}` : null;
}

/**
 * Probe `cwd` for the language/framework marker files in {@link MARKERS}/{@link PREFIX_MARKERS}
 * and return the matching tags. A null/missing/unreadable directory yields []. We read the
 * directory ONCE (not one stat per marker) so a single missing dir is one cheap, swallowed
 * failure rather than dozens.
 */
function detectProjectTags(cwd: string | null): string[] {
  if (typeof cwd !== "string" || !cwd.trim()) return [];
  let entries: Set<string>;
  try {
    entries = new Set(readdirSync(cwd));
  } catch {
    return []; // missing / unreadable cwd — nothing to suggest
  }
  const out: string[] = [];
  for (const { tag, files } of MARKERS) {
    if (files.some((f) => entries.has(f))) out.push(tag);
  }
  for (const { tag, prefix } of PREFIX_MARKERS) {
    if ([...entries].some((name) => name.startsWith(prefix))) out.push(tag);
  }
  return out;
}

/**
 * Compute SUGGESTED tags for a session from its project directory + git branch:
 *   - language/framework tags probed from marker files at the top of `cwd`
 *     (e.g. package.json → "node", tsconfig.json → "typescript", Cargo.toml → "rust",
 *      go.mod → "go", pyproject.toml/requirements.txt → "python", next.config.* → "nextjs"),
 *   - a `branch:<slug>` tag for a non-default branch (main/master are skipped).
 *
 * The result is run through {@link normalizeTags} (trim/lower/dedupe), so it slots straight
 * into the existing tag system. Pure + tolerant: a null/unreadable `cwd` and/or a missing
 * `gitBranch` simply contribute nothing (the function returns [] in the worst case). Never
 * persists — the caller decides whether to apply the suggestion.
 */
export function computeAutoTags(opts: { cwd: string | null; gitBranch?: string | null }): string[] {
  const tags = detectProjectTags(opts.cwd ?? null);
  const branch = branchTag(opts.gitBranch);
  if (branch) tags.push(branch);
  return normalizeTags(tags);
}

/**
 * Merge suggested auto-tags into a session's existing tags (set union), normalized once via
 * {@link normalizeTags} so order/dupes/casing match the rest of the tag system. Pure — does NOT
 * persist; the caller (e.g. `engine.applyAutoTags`) writes the result. Existing tags are kept
 * first so user-assigned tags retain their insertion order, with newly-suggested ones appended.
 *
 * Returns both halves a caller needs:
 *   - `applied`: the full resulting tag set (existing ∪ suggested),
 *   - `added`:   only the tags that weren't already present (so a re-run is idempotent — `added`
 *               comes back empty once every suggestion is already on the session).
 */
export function mergeAutoTags(
  existing: readonly string[],
  suggested: readonly string[],
): { applied: string[]; added: string[] } {
  const applied = normalizeTags([...existing, ...suggested]);
  const have = new Set(normalizeTags([...existing]));
  const added = applied.filter((t) => !have.has(t));
  return { applied, added };
}
