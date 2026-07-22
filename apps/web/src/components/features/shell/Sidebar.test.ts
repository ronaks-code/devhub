import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Sidebar, SIDEBAR_GEOMETRY, type SidebarProps } from "./Sidebar.js";
import { SHELL_GEOMETRY } from "./DevHubShell.js";

function render(overrides: Partial<SidebarProps> = {}): string {
  const props: SidebarProps = {
    destinations: [
      { id: "home", label: "Home", current: true },
      { id: "browse", label: "Browse" },
      { id: "inbox", label: "Inbox", badge: 3 },
      { id: "settings", label: "Settings" },
    ],
    onSelectDestination: () => {},
    groups: [
      {
        id: "review",
        label: "Needs you",
        tier: "attention",
        rows: [
          {
            id: "s-wait",
            title: "Approve the deploy",
            provider: "anthropic",
            status: "waiting",
            subtitle: "devhub · ⎇ feat/deploy",
            branch: "feat/deploy",
            model: "claude-opus-4-8",
            reason: 'Asked: "Bash(git push)"',
            timestamp: new Date().toISOString(),
          },
        ],
      },
      {
        id: "running",
        label: "Running",
        tier: "active",
        rows: [
          {
            id: "s-run",
            title: "Wire the gateway",
            provider: "openai",
            status: "running",
            subtitle: "devhub · ⎇ feat/aurora",
            branch: "feat/aurora",
            model: "claude-opus-4-8",
            startedAt: Date.now() - 65_000,
            timestamp: new Date().toISOString(),
            costUsd: 1.5,
          },
        ],
      },
      {
        id: "idle",
        label: "Recent",
        tier: "recent",
        rows: [
          { id: "s-idle", title: "Old session", provider: "openai", costUsd: 0.42 },
          { id: "s-idle2", title: "Older session", provider: "openai", timestamp: new Date().toISOString() },
        ],
      },
    ],
    sessionCount: 4,
    selectedSessionId: "s-run",
    onSelectSession: () => {},
    onNewTask: () => {},
    mechanics: "claude",
    onMechanicsChange: () => {},
    modelLabel: "model opus-4.8",
    spend: { monthToDateUsd: 1234, monthlyBudgetUsd: 5000, pct: 24, alert: "none", month: "jul" },
    ...overrides,
  };
  return renderToStaticMarkup(createElement(Sidebar, props));
}

describe("Sidebar cockpit (§3.1)", () => {
  it("renders the icon-rail + glass panel structure", () => {
    const html = render();
    expect(html).toContain('data-dh-sidebar=""');
    expect(html).toContain('data-dh-iconrail=""');
    expect(html).toContain('data-dh-panel=""');
    expect(html).toContain('data-dh-logo=""');
  });

  it("renders a nav icon per destination with the active one marked, and inbox badge", () => {
    const html = render();
    // Home is current.
    expect(html).toMatch(/aria-current="page"[^>]*aria-label="Home"|aria-label="Home"[^>]*aria-current="page"/);
    expect(html).toContain('aria-label="Browse"');
    expect(html).toContain('aria-label="Settings"');
    // Inbox unread badge renders only because badge > 0.
    expect(html).toContain('class="dh-navicon-badge"');
    expect(html).toContain(">3<");
    // Keyboard chord hints are shown (g-chord sidecar).
    expect(html).toContain('class="dh-navicon-chord"');
  });

  it("renders the three attention tiers with density earned by state (§3.1v2 inbox)", () => {
    const html = render();
    expect(html).toContain(">Needs you<");
    expect(html).toContain(">Running<");
    expect(html).toContain(">Recent<");
    // Tier 1+2 are cards; tier 3 collapses to one-line rows.
    expect(html).toContain('data-dh-tier="attention"');
    expect(html).toContain('data-dh-tier="active"');
    expect(html.split('data-dh-tier="recent"').length - 1).toBe(2);
    expect(html).toContain("dh-scard--attention");
    expect(html).toContain("dh-scard--running");
    expect(html).toContain("dh-srowc");
    // Provider identity as letters on the cards (never a logo): CLD / CDX. The
    // compact recent one-liners intentionally carry no chip (quiet history).
    expect(html).toContain(">CLD<");
    expect(html).toContain(">CDX<");
    expect(html.split("dh-provider-chip").length - 1).toBe(4); // 2 cards × (class + variant class)
  });

  it("renders the Needs-you card's real reason line, status pill, branch/model, and Open action", () => {
    const html = render();
    expect(html).toContain("Asked: &quot;Bash(git push)&quot;");
    expect(html).toContain('data-status="waiting"'); // status pill
    expect(html).toContain("⎇ feat/deploy");
    expect(html).toContain("claude-opus-4-8");
    expect(html).toContain(">Open<");
    // The Open action lives ONLY on the attention tier (no invented approve button).
    expect(html.split(">Open<").length - 1).toBe(1);
    expect(html).not.toContain(">Approve<");
  });

  it("renders the Running card's live elapsed timer from the real startedAt", () => {
    const html = render();
    expect(html).toMatch(/running 1m \d+s/);
    // A running row without startedAt would get no timer — verify via a groups override.
    const noStart = render({
      groups: [
        {
          id: "running",
          label: "Running",
          tier: "active",
          rows: [{ id: "r1", title: "No start", provider: "anthropic", status: "running" }],
        },
      ],
    });
    expect(noStart).not.toContain("running NaN");
    expect(noStart).not.toMatch(/running \d/);
  });

  it("shows a status dot ONLY for a row with a real running-join status", () => {
    const html = render();
    // The running row gets the pulsing dot; the idle rows (no status) get none.
    expect(html.split("dh-status-dot--running").length - 1).toBe(1);
    expect(html.split("dh-status-dot--waiting").length - 1).toBe(1);
    expect(html).not.toContain("dh-status-dot--idle"); // idle rows have no status field → no dot
  });

  it("marks the selected row and renders cost-or-time on recent one-liners", () => {
    const html = render();
    expect(html.split('data-dh-selected=""').length - 1).toBe(1);
    expect(html).toContain("$1.50"); // running card cost (costUsd > 0)
    expect(html).toContain("$0.42"); // recent one-liner shows cost when it exists…
    expect(html.split("dh-srowc-right").length - 1).toBe(2); // …or the relative time
  });

  it("renders recent rows as two lines: title + the real context that exists (§3.1)", () => {
    const iso = new Date(Date.now() - 5 * 60_000).toISOString();
    const html = render({
      selectedSessionId: null,
      groups: [
        {
          id: "idle",
          label: "Recent",
          tier: "recent",
          rows: [
            {
              id: "r-ctx",
              title: "Landed the fix",
              provider: "anthropic",
              subtitle: "devhub · ⎇ feat/aurora",
              branch: "feat/aurora",
              timestamp: iso,
              costUsd: 0.5,
            },
            // A bare row with no context must invent none (never truncate a lie in).
            { id: "r-bare", title: "No context", provider: "openai" },
          ],
        },
      ],
    });
    // Line 2 carries the REAL project · branch context (from the row subtitle)…
    expect(html).toContain("devhub · ⎇ feat/aurora");
    // …the relative time (5m) and the cost ($0.50) — both real, drawn from data.
    expect(html).toContain("5m");
    expect(html).toContain("$0.50");
    // Still a recent one-liner class, still tagged as the recent tier.
    expect(html).toContain("dh-srowc");
    expect(html.split('data-dh-tier="recent"').length - 1).toBe(2);
    // The bare row fabricates no line-2 context.
    expect(html).not.toContain("undefined");
  });

  it("renders a reason line only when one exists (no placeholder lies)", () => {
    const html = render();
    expect(html.split("dh-scard-reason").length - 1).toBe(1); // only the waiting card
    expect(html).not.toContain("undefined");
  });

  it("renders the footer provider segment, model line, and spend meter from real data", () => {
    const html = render();
    expect(html).toContain('class="dh-provider-seg"');
    expect(html).toMatch(/aria-pressed="true"[^>]*>Claude</);
    expect(html).toContain("model opus-4.8");
    expect(html).toContain("jul spend $1234");
    expect(html).toContain("/ $5000");
    expect(html).toContain('class="dh-spend-fill"');
    expect(html).toContain("dh-spend-ring"); // icon-rail spend ring (pct)
    expect(html).toContain(">24<");
  });

  it("renders the filter input + chips", () => {
    const html = render();
    expect(html).toContain('placeholder="Filter sessions"');
    for (const label of ["All", "Needs you", "Running", "Claude", "Codex"]) {
      expect(html).toContain(`>${label}<`);
    }
  });

  it("renders an empty state when there are no groups", () => {
    const html = render({ groups: [] });
    expect(html).toContain("No sessions");
  });

  it("disables the provider segment when no change handler is wired (read-only, honest)", () => {
    const html = render({ onMechanicsChange: undefined });
    expect(html).toContain("disabled");
  });

  it("renders the worktrees group from real fields only (no dirty-count fakes)", () => {
    const html = render({
      worktrees: [
        { path: "/repo", branch: "main", isMain: true },
        { path: "/repo/.wt/x", branch: "feat/x", locked: true },
      ],
    });
    expect(html).toContain('data-dh-worktrees=""');
    expect(html).toContain(">Worktrees<");
    expect(html).toContain("⎇ main");
    expect(html).toContain("⎇ feat/x");
    expect(html).toContain(">main<");
    expect(html).toContain(">locked<");
    // The endpoint has no dirty counts → we never invent a "+N ~M" display.
    expect(html).not.toMatch(/\+\d+ ~\d+/);
  });

  it("hides the worktrees group when there is no worktree data", () => {
    expect(render({ worktrees: [] })).not.toContain('data-dh-worktrees=""');
    expect(render({ worktrees: undefined })).not.toContain('data-dh-worktrees=""');
  });

  it("exposes the redesigned rail geometry as a frozen source of truth mirroring the shell", () => {
    expect(SIDEBAR_GEOMETRY.iconRailWidth).toBe(52);
    expect(SIDEBAR_GEOMETRY.panelWidth).toBe(272);
    expect(SIDEBAR_GEOMETRY.railWidth).toBe(324);
    expect(SIDEBAR_GEOMETRY.rowMinHeight).toBe(44);
    expect(SIDEBAR_GEOMETRY.compactRowHeight).toBe(26);
    expect(Object.isFrozen(SIDEBAR_GEOMETRY)).toBe(true);
    // Sidebar and shell never drift.
    expect(SIDEBAR_GEOMETRY.railWidth).toBe(SHELL_GEOMETRY.railWidth);
    expect(SIDEBAR_GEOMETRY.iconRailWidth).toBe(SHELL_GEOMETRY.iconRailWidth);
    expect(SIDEBAR_GEOMETRY.panelWidth).toBe(SHELL_GEOMETRY.panelWidth);
    expect(SIDEBAR_GEOMETRY.rowMinHeight).toBe(SHELL_GEOMETRY.selectedRowHeight);
  });
});
