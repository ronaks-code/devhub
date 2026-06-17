/**
 * A SECOND, OPTIONAL search lane layered ON TOP of FTS — never instead of it.
 *
 * The primary lane is the SQLite FTS5 full-text search ({@link MessageSearch} /
 * `engine.search`). It's fast and always on. This module adds an OPT-IN reranking
 * pass: take FTS's top candidates and reorder them by semantic closeness to the query.
 *
 * DEFAULT OFF. With no configuration, {@link hybridSearch} returns the FTS results
 * UNCHANGED — same order, same array. A provider is selected ONLY by the
 * `CLAUDE_UI_EMBED_PROVIDER` env var:
 *
 *   - unset / "none" / "off"  -> the {@link noopProvider}: identity, no reranking.
 *   - "lexical"               -> the {@link lexicalProvider}: a dependency-free
 *                                "semantic-ish" reranker that scores candidates by
 *                                token-overlap with the query (no model, no network,
 *                                no API key). A pragmatic fallback that still helps
 *                                surface the most on-topic of the FTS hits.
 *   - anything else           -> looked up in a caller-supplied registry, else falls
 *                                back to no-op (an unknown provider must NEVER break
 *                                search — FTS still answers).
 *
 * Real vector providers (OpenAI/local embedding models/etc.) are intentionally NOT
 * bundled — that would pull a heavy dependency and require an API key. Instead the
 * {@link EmbeddingProvider} interface is the extension point: a face/host can register
 * its own provider and pass it in, and `hybridSearch` will use it. The shipped code
 * adds ZERO dependencies and works on a machine with no network.
 */
import type { SearchHit } from "./types.js";
import type { SearchFacets } from "./search.js";

/**
 * A pluggable embedding/rerank provider. Two shapes are supported so a provider can
 * implement whichever is natural:
 *
 *   - `embed(texts)`  -> a vector per text (query + candidates), and we cosine-rank.
 *   - `rerank(query, candidates)` -> a relevance score per candidate directly.
 *
 * A provider may implement EITHER (rerank is tried first). Both are async so a network
 * or model call fits. A provider that throws is treated as "no opinion" — we fall back
 * to the original FTS order, so a flaky provider can never make search worse than FTS.
 */
export interface EmbeddingProvider {
  /** Stable identifier (e.g. "lexical", "openai:text-embedding-3-small"). */
  readonly id: string;
  /** Embed each text into a numeric vector (all vectors the same length). */
  embed?(texts: string[]): Promise<number[][]>;
  /** Directly score each candidate's relevance to `query` (higher = more relevant). */
  rerank?(query: string, candidates: string[]): Promise<number[]>;
}

/** A search function with the same shape as `engine.search` — the FTS primary lane. */
export type FtsSearchFn = (query: string, facets?: SearchFacets) => SearchHit[];

/** Options for {@link hybridSearch}. */
export interface HybridSearchOptions {
  /**
   * Provider to use. When omitted, one is chosen from `CLAUDE_UI_EMBED_PROVIDER` via
   * {@link selectProvider} (which defaults to the no-op). Pass a provider explicitly to
   * bypass the env (e.g. a host that registered a real embedding model).
   */
  provider?: EmbeddingProvider;
  /**
   * How many FTS candidates to feed the reranker. The reranker can only REORDER what
   * FTS already returned, so we pull a wider candidate set (default 50) than the caller
   * ultimately wants, rerank it, then truncate to `facets.limit`. Capped at 200.
   */
  candidateLimit?: number;
}

/** The no-op provider: present so "off" is a real provider, not a null branch. */
export const noopProvider: EmbeddingProvider = { id: "none" };

/**
 * Tokenize text into a lowercased set of word tokens for lexical overlap. Splits on
 * any non-alphanumeric run, drops 1-char tokens (noise like punctuation remnants).
 */
function tokenSet(text: string): Set<string> {
  const out = new Set<string>();
  for (const t of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (t.length > 1) out.add(t);
  }
  return out;
}

/**
 * The built-in dependency-free "semantic-ish" reranker. Scores each candidate by how
 * many of the QUERY's distinct tokens it contains, normalized by the query token count
 * (a Jaccard-ish overlap weighted toward query coverage). No model, no network, no key
 * — just set intersection. It can't capture true synonymy, but it reliably floats the
 * candidates that mention the most of what you asked for, which is a real improvement
 * over raw bm25 for multi-word queries.
 */
export const lexicalProvider: EmbeddingProvider = {
  id: "lexical",
  async rerank(query: string, candidates: string[]): Promise<number[]> {
    const q = tokenSet(query);
    if (q.size === 0) return candidates.map(() => 0);
    return candidates.map((c) => {
      const cand = tokenSet(c);
      let hits = 0;
      for (const t of q) if (cand.has(t)) hits++;
      // Coverage of the query's tokens (0..1). Ties keep FTS's original order (stable).
      return hits / q.size;
    });
  },
};

/**
 * Pick a provider from an env value (defaults to `CLAUDE_UI_EMBED_PROVIDER`). Built-in
 * names resolve directly; an unknown name is looked up in `registry`, and if absent
 * falls back to the no-op so an unrecognized/misconfigured value can NEVER break
 * search. "", "none", "off", "false" (case-insensitive) all mean "no reranking".
 */
export function selectProvider(
  envValue: string | undefined = process.env.CLAUDE_UI_EMBED_PROVIDER,
  registry: Record<string, EmbeddingProvider> = {},
): EmbeddingProvider {
  const key = (envValue ?? "").trim().toLowerCase();
  if (key === "" || key === "none" || key === "off" || key === "false") return noopProvider;
  if (key === "lexical") return lexicalProvider;
  return registry[key] ?? noopProvider;
}

/** Cosine similarity of two equal-length vectors; 0 when either is degenerate. */
function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    na += av * av;
    nb += bv * bv;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Compute a per-candidate relevance score using whichever provider shape is available:
 * `rerank` first (a direct score), else `embed` (cosine of query-vs-candidate vectors).
 * Returns null when the provider offers neither, or throws, so the caller keeps FTS
 * order. The candidate text fed to the provider is each hit's `snippet` (the matched
 * excerpt) — the most query-relevant text we have per hit without re-reading transcripts.
 */
async function scoreCandidates(
  provider: EmbeddingProvider,
  query: string,
  candidates: string[],
): Promise<number[] | null> {
  try {
    if (provider.rerank) {
      const scores = await provider.rerank(query, candidates);
      return scores.length === candidates.length ? scores : null;
    }
    if (provider.embed) {
      const vectors = await provider.embed([query, ...candidates]);
      const qv = vectors[0];
      if (!qv || vectors.length !== candidates.length + 1) return null;
      return candidates.map((_, i) => cosine(qv, vectors[i + 1] ?? []));
    }
    return null; // no-op / score-less provider
  } catch {
    return null; // a flaky provider must never degrade below FTS
  }
}

/**
 * Hybrid search: FTS primary, OPTIONAL semantic rerank on top.
 *
 * 1. Always run the FTS lane (`searchFn`) for a wide candidate set (`candidateLimit`,
 *    independent of the caller's final `limit`).
 * 2. If the selected provider is the no-op (the default), return FTS's top `limit`
 *    UNCHANGED — zero added cost, identical to calling `searchFn` directly.
 * 3. Otherwise score the candidates' snippets with the provider and STABLE-sort by
 *    score descending (FTS order breaks ties, so a provider that's indifferent leaves
 *    the FTS ranking intact). Then truncate to the caller's `limit`.
 *
 * The reranker can only REORDER FTS candidates — it never invents hits and never
 * removes the FTS lane. With no provider configured this is a pure pass-through.
 */
export async function hybridSearch(
  searchFn: FtsSearchFn,
  query: string,
  facets: SearchFacets = {},
  opts: HybridSearchOptions = {},
): Promise<SearchHit[]> {
  const provider = opts.provider ?? selectProvider();
  const finalLimit = facets.limit ?? 50;
  const candidateLimit = Math.min(Math.max(opts.candidateLimit ?? 50, finalLimit), 200);

  // FTS is always the source of truth for WHICH rows match; pull a wide candidate set.
  const candidates = searchFn(query, { ...facets, limit: candidateLimit });

  // Default / no-op path: identical to plain FTS, just capped at the caller's limit.
  if (provider === noopProvider || (!provider.rerank && !provider.embed)) {
    return candidates.slice(0, finalLimit);
  }

  const scores = await scoreCandidates(
    provider,
    query,
    candidates.map((c) => c.snippet ?? ""),
  );
  if (!scores) return candidates.slice(0, finalLimit); // provider had no opinion -> FTS order

  // Stable sort by score desc: decorate with original index so equal scores preserve
  // FTS ranking (Array.sort isn't guaranteed stable across all the candidate counts).
  const ranked = candidates
    .map((hit, i) => ({ hit, score: scores[i] ?? 0, i }))
    .sort((a, b) => (b.score - a.score) || (a.i - b.i))
    .map((r) => r.hit);

  return ranked.slice(0, finalLimit);
}
