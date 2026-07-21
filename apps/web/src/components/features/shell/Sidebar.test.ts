import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Sidebar, type SidebarProps } from "./Sidebar.js";

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
        id: "running",
        label: "Running",
        rows: [
          {
            id: "s-run",
            title: "Wire the gateway",
            provider: "anthropic",
            status: "running",
            subtitle: "devhub · ⎇ feat/aurora",
            timestamp: new Date().toISOString(),
            costUsd: 1.5,
          },
        ],
      },
      {
        id: "idle",
        label: "Idle / Recent",
        rows: [{ id: "s-idle", title: "Old session", provider: "openai" }],
      },
    ],
    sessionCount: 2,
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

  it("renders two-line session rows grouped by run status — never one line", () => {
    const html = render();
    expect(html).toContain(">Running<");
    expect(html).toContain(">Idle / Recent<");
    expect(html).toContain(">Wire the gateway<");
    // Every row has BOTH lines present.
    expect(html).toContain('class="dh-srow-line1"');
    expect(html).toContain('class="dh-srow-line2"');
    // Provider identity as letters (never a logo): CLD for anthropic, CDX for openai.
    expect(html).toContain(">CLD<");
    expect(html).toContain(">CDX<");
  });

  it("shows a status dot ONLY for a row with a real running-join status", () => {
    const html = render();
    // The running row gets the pulsing dot; the idle row (no status) gets none.
    expect(html.split("dh-status-dot--running").length - 1).toBe(1);
    expect(html).not.toContain("dh-status-dot--idle"); // idle row has no status field → no dot
  });

  it("marks the selected row and renders the cost badge only when cost exists", () => {
    const html = render();
    expect(html.split('data-dh-selected=""').length - 1).toBe(1);
    expect(html).toContain("$1.50"); // running row has costUsd
    // The idle row has no costUsd → exactly one cost badge in the whole tree.
    expect(html.split("dh-srow-cost").length - 1).toBe(1);
  });

  it("omits the line-2 subtitle text when a session has none (no placeholder lies)", () => {
    const html = render();
    expect(html).toContain("devhub · ⎇ feat/aurora"); // running row subtitle
    // Idle row has no subtitle — its sub span is empty, not a fabricated value.
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
    for (const label of ["All", "Running", "Review", "Claude", "Codex"]) {
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
});
