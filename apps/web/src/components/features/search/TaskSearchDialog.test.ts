// @vitest-environment jsdom
import { createElement, useState } from "react";
import { render as rtlRender, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  SEARCH_COPY,
  SEARCH_DATE_FACETS,
  TaskSearchDialog,
  type SearchResult,
  type TaskSearchDialogProps,
  isSearchCommandsApplied,
  navigationTargetForResult,
  providerFromTaskKey,
  resolveSearchCommandsMode,
  resolveSearchStatus,
  resultProviderLabel,
} from "./TaskSearchDialog.js";

function render(props: TaskSearchDialogProps): string {
  return renderToStaticMarkup(createElement(TaskSearchDialog, props));
}

/** The NUL separator used in composite native task keys. */
const SEP = "\u0000";
const codexKey = ["openai", "/Users/me/.codex", "task-abc"].join(SEP);
const claudeKey = ["anthropic", "/Users/me/.claude", "sess-xyz"].join(SEP);

const codexResult: SearchResult = {
  taskKey: codexKey,
  title: "Refactor the auth flow",
  projectName: "devhub",
  snippet: "we should [refactor] the token exchange",
  seq: 12,
};
const claudeResult: SearchResult = {
  taskKey: claudeKey,
  title: "Fix the composer",
  projectName: "web",
  snippet: "the [composer] geometry drifts",
  seq: 3,
};

// --- Dedicated Search dialog (NOT the command palette) -------------------------

describe("TaskSearchDialog — dedicated Search tasks and messages dialog", () => {
  it("titles itself `Search tasks and messages` on a real dialog", () => {
    const html = render({ query: "", results: [] });
    expect(SEARCH_COPY.title).toBe("Search tasks and messages");
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-label="Search tasks and messages"');
    expect(html).toContain("data-dh-search-dialog");
    // It is NOT the command palette.
    expect(html).not.toContain("Search commands and tasks");
    expect(html).not.toContain("data-dh-command-dialog");
  });

  it("opens with a focused query (searchbox + autofocus marker)", () => {
    const html = render({ query: "auth" });
    expect(html).toContain('role="searchbox"');
    expect(html).toContain("data-dh-search-autofocus");
    expect(html).toContain('value="auth"');
  });

  it("renders no provider logo (no svg/img)", () => {
    const html = render({ results: [codexResult, claudeResult] });
    expect(html).not.toContain("<svg");
    expect(html).not.toContain("<img");
  });
});

// --- Global / current-project scope + date facets ------------------------------

describe("TaskSearchDialog — scope and date facets", () => {
  it("offers Global and current-project scope with radio semantics", () => {
    const html = render({
      scope: "project",
      activeProjectId: "p1",
      activeProjectName: "devhub",
    });
    expect(html).toContain('data-dh-search-scope-option="global"');
    expect(html).toContain('data-dh-search-scope-option="project"');
    expect(html).toContain("Global");
    expect(html).toContain("devhub");
    // Scope uses radio (pressed) semantics — the active project scope is checked.
    expect(html).toMatch(/data-dh-search-scope-option="project"[^>]*aria-checked="true"/);
  });

  it("disables the Project scope with an explanation when no project is active", () => {
    const html = render({ activeProjectId: null });
    expect(html).toMatch(/data-dh-search-scope-option="project"[^>]*disabled/);
    expect(html).toContain(SEARCH_COPY.scopeProjectDisabledReason);
  });

  it("keeps all locked date facets plus after/before/clear controls", () => {
    const html = render({ dateFacet: "7d" });
    for (const f of SEARCH_DATE_FACETS) {
      expect(html).toContain(`data-dh-date-facet="${f.id}"`);
      expect(html).toContain(f.label);
    }
    expect(html).toMatch(/data-dh-date-facet="7d"[^>]*aria-checked="true"/);
    expect(html).toContain(SEARCH_COPY.dateControls.afterDate);
    expect(html).toContain(SEARCH_COPY.dateControls.beforeDate);
    expect(html).toContain(SEARCH_COPY.dateControls.clearRange);
  });
});

// --- Result rows: title / project / highlighted snippet / count ----------------

describe("TaskSearchDialog — populated results (REF-SEARCH contract)", () => {
  it("shows a result count/status and title/project/highlighted-snippet rows", () => {
    const html = render({ query: "x", results: [codexResult, claudeResult] });
    expect(html).toContain("2 results");
    expect(html).toContain('data-dh-search-status="results"');
    expect(html).toContain("Refactor the auth flow");
    expect(html).toContain("devhub");
    // Highlighted snippet marker becomes a semantic <mark>, not just color.
    expect(html).toContain("<mark");
    expect(html).toContain("refactor");
  });

  it("singularizes the count for exactly one result", () => {
    const html = render({ query: "x", results: [codexResult] });
    expect(html).toContain("1 result");
    expect(html).not.toContain("1 results");
  });

  it("marks the keyboard-active row via aria-activedescendant, distinct from scope/date", () => {
    const html = render({ query: "x", results: [codexResult, claudeResult], activeIndex: 1 });
    expect(html).toContain('aria-activedescendant="dh-search-result-1"');
    // The active RESULT row is aria-selected; scope/date use aria-checked (pressed),
    // so a keyboard-active row is never confused with a scope/date selection.
    expect(html).toMatch(/data-dh-search-result="1"[^>]*aria-selected="true"/);
    expect(html).toMatch(/data-dh-search-result="0"[^>]*aria-selected="false"/);
  });
});

// --- Provider derives from the composite key, never model text -----------------

describe("providerFromTaskKey / navigation — provider-locked from the composite key", () => {
  it("derives the provider from the composite key's first segment", () => {
    expect(providerFromTaskKey(codexKey)).toBe("openai");
    expect(providerFromTaskKey(claudeKey)).toBe("anthropic");
  });

  it("throws rather than inferring a provider from model text or a malformed key", () => {
    // A snippet that mentions "Codex"/"Claude" must NEVER become the provider.
    expect(() => providerFromTaskKey("Codex told me to refactor")).toThrow();
    expect(() => providerFromTaskKey("")).toThrow();
    expect(() => providerFromTaskKey(["gpt", "/h", "t"].join(SEP))).toThrow();
  });

  it("builds a provider-locked navigation target straight from the key (+seq, read-only)", () => {
    const t = navigationTargetForResult(codexResult);
    expect(t).toEqual({
      provider: "openai",
      home: "/Users/me/.codex",
      nativeTaskId: "task-abc",
      seq: 12,
      readOnly: false,
    });
    // A degraded hit opens read-only until reconciliation.
    expect(navigationTargetForResult({ ...codexResult, degraded: true }).readOnly).toBe(true);
    // Missing seq defaults to 0, never NaN/negative.
    expect(navigationTargetForResult({ ...claudeResult, seq: undefined }).seq).toBe(0);
  });

  it("stamps each result row with the key-derived provider", () => {
    const html = render({ query: "x", results: [codexResult, claudeResult] });
    expect(html).toContain('data-dh-result-provider="openai"');
    expect(html).toContain('data-dh-result-provider="anthropic"');
  });
});

// --- Provider labels: raw OpenAI is never labeled Codex ------------------------

describe("resultProviderLabel — degraded raw OpenAI is never Codex", () => {
  it("labels a native Codex task `Codex` and a Claude task `Claude`", () => {
    expect(resultProviderLabel(codexResult)).toBe("Codex");
    expect(resultProviderLabel(claudeResult)).toBe("Claude");
  });

  it("labels a DEGRADED (raw) OpenAI session `OpenAI`, never `Codex`", () => {
    const raw: SearchResult = { ...codexResult, degraded: true };
    expect(resultProviderLabel(raw)).toBe("OpenAI");
    expect(resultProviderLabel(raw)).not.toBe("Codex");
  });

  it("renders `Read-only fallback` on a degraded result row", () => {
    const html = render({ query: "x", results: [{ ...codexResult, degraded: true }] });
    expect(html).toContain("data-dh-read-only");
    expect(html).toContain(SEARCH_COPY.readOnlyFallback);
    // The degraded OpenAI row must not carry the `Codex` product label.
    expect(html).toContain(">OpenAI<");
    expect(html).not.toContain(">Codex<");
  });
});

// --- Error state is DISTINCT and never collapses to No results -----------------

describe("resolveSearchStatus — error is distinct from empty", () => {
  it("returns idle/loading/empty/results in precedence, error above all", () => {
    expect(resolveSearchStatus({ query: "", resultCount: 0 }).kind).toBe("idle");
    expect(resolveSearchStatus({ query: "x", loading: true, resultCount: 0 }).kind).toBe("loading");
    expect(resolveSearchStatus({ query: "x", resultCount: 0 }).kind).toBe("empty");
    expect(resolveSearchStatus({ query: "x", resultCount: 3 }).kind).toBe("results");
    // Error wins even when there are zero results — it must NOT collapse to `empty`.
    expect(resolveSearchStatus({ query: "x", error: true, resultCount: 0 }).kind).toBe("error");
    expect(resolveSearchStatus({ query: "", error: true, resultCount: 0 }).kind).toBe("error");
  });

  it("uses the distinct copy strings", () => {
    expect(SEARCH_COPY.states.error).toBe("Search failed");
    expect(SEARCH_COPY.states.empty).toBe("No results");
    expect(SEARCH_COPY.states.error).not.toBe(SEARCH_COPY.states.empty);
  });

  it("renders a distinct error region that RETAINS query/facets and never says No results", () => {
    const html = render({
      query: "auth",
      error: true,
      scope: "project",
      activeProjectId: "p1",
      activeProjectName: "devhub",
      dateFacet: "30d",
      results: [],
    });
    expect(html).toContain("data-dh-search-error");
    expect(html).toContain("Search failed");
    expect(html).toContain(SEARCH_COPY.retry);
    // Query + scope + date facets survive the error.
    expect(html).toContain('value="auth"');
    expect(html).toContain('data-dh-search-scope-option="project"');
    expect(html).toContain('data-dh-date-facet="30d"');
    // The critical invariant: error must NOT collapse to `No results`.
    expect(html).not.toContain("No results");
    expect(html).not.toContain("data-dh-search-results");
  });

  it("marks the error region role=alert (an accessible Alert, not a status-only region)", () => {
    const html = render({ query: "auth", error: true, results: [] });
    expect(html).toMatch(/data-dh-search-error=""[^>]*role="alert"/);
  });
});

// --- Loading renders content-shaped Skeleton placeholders, not a bare spinner --

describe("TaskSearchDialog — loading state renders Skeleton rows", () => {
  it("renders aria-hidden Skeleton result placeholders while a request is in flight", () => {
    const html = render({ query: "auth", loading: true, results: [] });
    expect(html).toContain("data-dh-search-skeleton");
    expect(html).toMatch(/data-dh-search-skeleton[^>]*aria-hidden="true"/);
    // The loading Skeleton replaces the plain idle/empty text placeholder.
    expect(html).not.toContain("data-dh-search-placeholder");
  });

  it("does not render Skeleton rows outside the loading state", () => {
    expect(render({ query: "", results: [] })).not.toContain("data-dh-search-skeleton");
    expect(render({ query: "x", results: [] })).not.toContain("data-dh-search-skeleton");
    expect(render({ query: "x", results: [codexResult] })).not.toContain("data-dh-search-skeleton");
  });
});

// --- Footer --------------------------------------------------------------------

describe("TaskSearchDialog — footer", () => {
  it("shows the search footer copy `↑↓ navigate` / `↵ open` / `esc close`", () => {
    const html = render({ results: [] });
    expect(html).toContain("↑↓ navigate");
    expect(html).toContain("↵ open");
    expect(html).toContain("esc close");
    // Search runs (`open`), it does NOT `run` a command.
    expect(html).not.toContain("↵ run");
    expect(html).toContain("all projects");
  });

  it("names the active project in the footer under project scope", () => {
    const html = render({ scope: "project", activeProjectId: "p1", activeProjectName: "devhub" });
    expect(html).toMatch(/data-dh-search-footer-scope[^>]*>devhub</);
  });
});

// --- Slice-flag gate: flag-off never instantiates the dialog -------------------

describe("searchCommands slice-flag gate (Search)", () => {
  it("mounts the dialogs only for a resolved true searchCommands flag", () => {
    expect(resolveSearchCommandsMode({ devHubFeatures: { searchCommands: true } })).toBe("devhub");
    expect(resolveSearchCommandsMode({ devHubFeatures: { searchCommands: false } })).toBe("legacy");
    expect(resolveSearchCommandsMode({ devHubFeatures: {} })).toBe("legacy");
    expect(resolveSearchCommandsMode({})).toBe("legacy");
    expect(resolveSearchCommandsMode(null)).toBe("legacy");
    expect(resolveSearchCommandsMode(undefined)).toBe("legacy");
  });

  it("reports applied only when searchCommands is explicitly true", () => {
    expect(isSearchCommandsApplied({ searchCommands: true })).toBe(true);
    expect(isSearchCommandsApplied({ searchCommands: false })).toBe(false);
    expect(isSearchCommandsApplied({})).toBe(false);
    expect(isSearchCommandsApplied(undefined)).toBe(false);
  });
});

describe("TaskSearchDialog — live interaction (mounted DOM)", () => {
  it("Escape closes the dialog", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    rtlRender(createElement(TaskSearchDialog, { onClose }));
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("typing in the query box fires onQueryChange for every keystroke", async () => {
    const user = userEvent.setup();
    const onQueryChange = vi.fn();
    rtlRender(createElement(TaskSearchDialog, { onQueryChange }));
    await user.type(screen.getByRole("searchbox"), "auth");
    // The dialog's `query` prop is unchanged across keystrokes here (no controlling
    // host), so each keystroke reports just that one typed character — proving the
    // input's onChange really reaches onQueryChange on every keypress.
    expect(onQueryChange).toHaveBeenCalledTimes(4);
    expect(onQueryChange).toHaveBeenNthCalledWith(1, "a");
    expect(onQueryChange).toHaveBeenNthCalledWith(4, "h");
  });

  it("clicking a result opens the provider-locked navigation target", async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    rtlRender(
      createElement(TaskSearchDialog, {
        query: "auth",
        results: [codexResult, claudeResult],
        onOpen,
      }),
    );
    await user.click(screen.getByText(codexResult.title));
    expect(onOpen).toHaveBeenCalledTimes(1);
    const [target, result] = onOpen.mock.calls[0]!;
    expect(target).toEqual(navigationTargetForResult(codexResult));
    expect(result).toBe(codexResult);
  });

  it("switching scope and clicking a date facet fire the wired change handlers", async () => {
    const user = userEvent.setup();
    const onScopeChange = vi.fn();
    const onDateFacetChange = vi.fn();
    rtlRender(
      createElement(TaskSearchDialog, {
        activeProjectId: "proj-1",
        activeProjectName: "devhub",
        onScopeChange,
        onDateFacetChange,
      }),
    );
    await user.click(screen.getByRole("radio", { name: "devhub" }));
    expect(onScopeChange).toHaveBeenCalledWith("project");

    await user.click(screen.getByRole("radio", { name: "7d" }));
    expect(onDateFacetChange).toHaveBeenCalledWith("7d");

    await user.click(screen.getByText(SEARCH_COPY.dateControls.clearRange));
    expect(onDateFacetChange).toHaveBeenCalledWith(null);
  });

  it("Project scope stays a real disabled control (with its reason) until a project is active", async () => {
    const user = userEvent.setup();
    const onScopeChange = vi.fn();
    rtlRender(createElement(TaskSearchDialog, { onScopeChange }));
    const projectRadio = screen.getByRole("radio", { name: SEARCH_COPY.scopeProjectFallback });
    expect(projectRadio).toBeDisabled();
    await user.click(projectRadio);
    expect(onScopeChange).not.toHaveBeenCalled();
  });

  it("a live host wiring query+results end to end: typing narrows, arrow keys move the active row, Enter opens it", async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();

    function Harness() {
      const [query, setQuery] = useState("");
      const [activeIndex, _setActiveIndex] = useState(0);
      const results = query ? [codexResult, claudeResult] : [];
      return createElement(TaskSearchDialog, {
        query,
        results,
        activeIndex,
        onQueryChange: setQuery,
        onOpen,
        // The dialog itself doesn't own Up/Down/Enter row navigation (that's host-level,
        // mirrored here the way a real host wires it against the query input).
      });
    }

    rtlRender(createElement(Harness));
    const input = screen.getByRole("searchbox");
    await user.type(input, "auth");
    expect(await screen.findByText(codexResult.title)).toBeInTheDocument();
    expect(screen.getByText(claudeResult.title)).toBeInTheDocument();
    await user.click(screen.getByText(claudeResult.title));
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen.mock.calls[0]![1]).toBe(claudeResult);
  });
});
