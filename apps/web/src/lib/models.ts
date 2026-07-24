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

/** Anthropic (Claude Code) model ids. */
export const CLAUDE_MODELS = [
  "claude-opus-4-8",
  "claude-sonnet-4-6",
  "claude-haiku-4-5-20251001",
  "claude-fable-5",
] as const;

/**
 * OpenAI / Codex model ids. MUST mirror the `OpenAIModel` union in
 * `packages/engine/src/openai-session.ts`. Do not add ids the engine
 * doesn't declare.
 */
export const CODEX_MODELS = [
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-4.1",
  "gpt-4.1-mini",
  "o3",
  "o4-mini",
] as const;

/** Models available for a given mechanics/provider ("claude" is the default). */
export function modelsForMechanics(
  mechanics: Mechanics | null | undefined,
): readonly string[] {
  return mechanics === "codex" ? CODEX_MODELS : CLAUDE_MODELS;
}
