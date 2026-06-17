/**
 * Full-text search screen for the terminal face. Proves the "one brain, many
 * faces" design once more: it calls the SAME `engine.search(q)` IN-PROCESS — no
 * HTTP server — and renders the ranked hits (project · title · snippet). The
 * query field is a minimal controlled input built on Ink's `useInput` (printable
 * chars + backspace + enter), so we add NO new dependency.
 *
 *   - type           → edits the query
 *   - ⏎ (empty list) → run the search for the current query
 *   - ↑↓ / jk        → move the selection through the ranked hits
 *   - ⏎ (on a hit)   → open that session in the transcript view (via onOpen)
 *   - esc            → return to browse
 *
 * Search runs synchronously (the index is local SQLite), so a press of ⏎ with a
 * non-empty query both runs it and, once results exist, opens the highlighted hit.
 */
import React, { useCallback, useState } from "react";
import { Box, Text, useInput } from "ink";
import type { Engine } from "@claude-ui/engine";
import type { SearchHit } from "@claude-ui/engine/types";

const VISIBLE = 12; // results window height
const RESULT_LIMIT = 50; // cap on hits we ask the engine for

/** Top index of a scrolling window that keeps `idx` visible. */
function clampWindow(idx: number, len: number): number {
  if (idx < VISIBLE) return 0;
  return Math.min(idx - VISIBLE + 1, Math.max(0, len - VISIBLE));
}

/** Collapse whitespace + FTS highlight brackets noise into a single tidy line. */
function tidy(snippet: string): string {
  return snippet.replace(/\s+/g, " ").trim();
}

export function Search({
  engine,
  onOpen,
  onExit,
}: {
  engine: Engine;
  /** Open a session in the transcript view (sessionId + header bits from the hit). */
  onOpen: (hit: SearchHit) => void;
  onExit: () => void;
}) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [idx, setIdx] = useState(0);
  // null = not searched yet; otherwise the query the current `hits` are for.
  const [ran, setRan] = useState<string | null>(null);

  const run = useCallback(
    (q: string) => {
      const text = q.trim();
      if (!text) return;
      // Local SQLite FTS — synchronous, no await.
      const results = engine.search(text, { limit: RESULT_LIMIT });
      setHits(results);
      setIdx(0);
      setRan(text);
    },
    [engine],
  );

  useInput((char, key) => {
    if (key.escape) {
      onExit();
      return;
    }
    if (key.return) {
      // With results already showing for the current query, ⏎ opens the
      // highlighted hit; otherwise ⏎ runs the search.
      if (hits.length > 0 && ran === query.trim()) {
        const hit = hits[idx];
        if (hit) onOpen(hit);
      } else {
        run(query);
      }
      return;
    }
    if (key.downArrow) {
      setIdx((i) => Math.min(i + 1, Math.max(0, hits.length - 1)));
      return;
    }
    if (key.upArrow) {
      setIdx((i) => Math.max(0, i - 1));
      return;
    }
    if (key.delete || key.backspace) {
      setQuery((s) => s.slice(0, -1));
      return;
    }
    // Accept printable text only (ignore arrows handled above, ctrl/meta combos).
    if (char && !key.ctrl && !key.meta) {
      setQuery((s) => s + char);
    }
  });

  const top = clampWindow(idx, hits.length);
  const window = hits.slice(top, top + VISIBLE);
  const showResults = ran !== null && ran === query.trim();

  return (
    <Box flexDirection="column">
      <Text color="cyan" bold>
        Search
      </Text>

      <Box marginTop={1}>
        <Text color="#d97757">🔍 </Text>
        <Text>{query}</Text>
        <Text color="gray">▌</Text>
      </Box>

      <Box flexDirection="column" marginTop={1} minHeight={VISIBLE}>
        {!showResults ? (
          <Text color="gray">
            {ran === null ? "Type a query and press ⏎ to search." : "Press ⏎ to search."}
          </Text>
        ) : hits.length === 0 ? (
          <Text color="gray">No matches for “{ran}”.</Text>
        ) : (
          window.map((h, i) => {
            const realIdx = top + i;
            const active = realIdx === idx;
            return <Hit key={h.sessionId + ":" + realIdx} hit={h} active={active} />;
          })
        )}
      </Box>

      <Box marginTop={1}>
        <Text color="gray" dimColor>
          {showResults && hits.length > 0
            ? `${idx + 1}/${hits.length} · ↑↓ move · ⏎ open · type to edit · esc back`
            : "type · ⏎ search · ⌫ delete · esc back"}
        </Text>
      </Box>
    </Box>
  );
}

function Hit({ hit, active }: { hit: SearchHit; active: boolean }) {
  const head = `${hit.projectName || "?"} · ${hit.title}`.slice(0, 70);
  const snippet = tidy(hit.snippet).slice(0, 100);
  return (
    <Box flexDirection="column">
      <Text color={active ? "#d97757" : "cyan"} inverse={active} wrap="truncate-end">
        {active ? "› " : "  "}
        {head}
      </Text>
      <Text color="gray" wrap="truncate-end">
        {"    "}
        {snippet}
      </Text>
    </Box>
  );
}
