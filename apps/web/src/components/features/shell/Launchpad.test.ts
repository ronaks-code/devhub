import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Launchpad, type LaunchpadProps } from "./Launchpad.js";

function render(overrides: Partial<LaunchpadProps> = {}): string {
  const props: LaunchpadProps = {
    runningCount: 2,
    mechanics: "claude",
    onMechanicsChange: () => {},
    claudeModel: "opus-4.8",
    recents: [
      { projectId: "p1", sessionId: "s1", title: "Wire the gateway", cwd: "/repo", openedAt: 1 } as never,
    ],
    onOpenRecent: () => {},
    onLaunch: () => {},
    onBrowse: () => {},
    onOpenCodexHistory: () => {},
    ...overrides,
  };
  return renderToStaticMarkup(createElement(Launchpad, props));
}

describe("Launchpad (§3.3b)", () => {
  it("renders the brand orb, engine cards, and hero composer", () => {
    const html = render();
    expect(html).toContain('data-dh-launchpad=""');
    expect(html).toContain("Start a session");
    expect(html).toContain(">Claude<");
    expect(html).toContain(">Codex<");
    expect(html).toContain("opus-4.8");
    expect(html).toContain('data-dh-launch-composer=""');
    expect(html).toContain("Launch session");
  });

  it("shows the running count only when > 0 (real data)", () => {
    expect(render({ runningCount: 2 })).toContain("2 agents already running");
    expect(render({ runningCount: 0 })).not.toContain("already running");
  });

  it("marks the active engine and reflects a real recent as a resume starter", () => {
    const html = render();
    expect(html).toMatch(/aria-checked="true"/);
    expect(html).toContain("Resume");
    expect(html).toContain("Wire the gateway");
    expect(html).toContain("Browse sessions");
  });

  it("omits the worktree strip and the resume starter when there is no data (no fakes)", () => {
    const html = render({ worktrees: [], recents: [] });
    expect(html).not.toContain('data-dh-launch-worktrees=""');
    expect(html).not.toContain("Resume");
    expect(html).not.toContain("undefined");
  });

  it("renders the worktree strip from real fields when present", () => {
    const html = render({ worktrees: [{ path: "/r", branch: "feat/x", isMain: true }] });
    expect(html).toContain('data-dh-launch-worktrees=""');
    expect(html).toContain("⎇ feat/x");
  });
});
