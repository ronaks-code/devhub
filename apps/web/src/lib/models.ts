/**
 * Provider-aware model catalog for the default-model picker.
 *
 * The picker must only ever offer ids the engine actually supports, and the list
 * must match the CURRENT mechanics/provider: a Codex user should never be shown
 * Claude ids, and a Claude user should never be shown Codex ids.
 *
 * CLAUDE_MODELS mirrors the ids the Claude driver accepts. CODEX_MODELS mirrors
 * the `OpenAIModel` union declared in `packages/engine/src/openai-session.ts`,
 * kept in lockstep so we never invent an id the engine would reject.
 */

export type Mechanics = "claude" | "codex";

/** Anthropic (Claude Code) model ids — current lineup (Fable 5 frontier, Opus 4.8,
 * Sonnet 5 GA 2026-06-30, Haiku 4.5). Sonnet 5 replaces the retired Sonnet 4.6. */
export const CLAUDE_MODELS = [
  "claude-opus-4-8",
  "claude-sonnet-5",
  "claude-haiku-4-5-20251001",
  "claude-fable-5",
] as const;

/**
 * OpenAI / Codex model ids — the GPT-5.6 family (released 2026-07-09, available on
 * Codex): `gpt-5.6` (Sol, most capable / agentic-coding default), `gpt-5.6-terra`
 * (balanced), `gpt-5.6-luna` (budget). Kept in sync with the `OpenAIModel` union in
 * `packages/engine/src/openai-session.ts`.
 */
export const CODEX_MODELS = [
  "gpt-5.6",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
] as const;

/** Models available for a given mechanics/provider ("claude" is the default). */
export function modelsForMechanics(
  mechanics: Mechanics | null | undefined,
): readonly string[] {
  return mechanics === "codex" ? CODEX_MODELS : CLAUDE_MODELS;
}
