// @vitest-environment jsdom

import { createElement } from "react";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { OfficeVisualizer } from "./OfficeVisualizer.js";
import { MockFeed } from "./mockFeed.js";
import type { WorldState } from "./contract.js";

/**
 * The Nameplates renderer draws the SAME live WorldState the Blueprint plan does
 * (the mock feed today). These guard that it renders the whole shared roster and
 * derives lifecycle from the live agent status — never a private fixture.
 */

function isWorking(status: string): boolean {
  return status !== "idle" && status !== "done";
}

describe("OfficeVisualizer", () => {
  it("renders every room and agent from the shared world with lifecycle from live status", () => {
    // Advance the feed a few ticks so some agents are working (mixed lifecycle).
    const feed = new MockFeed({ seed: 42 });
    for (let i = 0; i < 12; i++) feed.tick();
    const world: WorldState = feed.getWorld();

    const { container } = render(createElement(OfficeVisualizer, { world }));

    expect(screen.getByTestId("office-visualizer").tagName).toBe("SECTION");
    expect(container.querySelectorAll("main")).toHaveLength(0);

    // One card per room in the world.
    expect(screen.getAllByTestId("office-room")).toHaveLength(world.rooms.length);

    // Lifecycle is derived from real membership + status, not hard-coded.
    const activeRooms = world.rooms.filter((r) =>
      r.members.some((id) => isWorking(world.agents.find((a) => a.id === id)?.status ?? "idle")),
    ).length;
    expect(container.querySelectorAll('[data-lifecycle="active"]')).toHaveLength(activeRooms);
    expect(container.querySelectorAll('[data-lifecycle="reserved"]')).toHaveLength(
      world.rooms.length - activeRooms,
    );

    // Every agent that belongs to a room has a nameplate showing its name.
    const placed = new Set(world.rooms.flatMap((r) => r.members));
    expect(screen.getAllByTestId("office-agent")).toHaveLength(placed.size);
    for (const agent of world.agents) {
      if (!placed.has(agent.id)) continue;
      const nameplate = container.querySelector<HTMLElement>(`[data-agent-id="${agent.id}"]`);
      expect(nameplate).not.toBeNull();
      expect(within(nameplate!).getByText(agent.name)).toBeVisible();
    }
  });

  it("labels the feed source honestly (mock by default, live when told)", () => {
    const world = new MockFeed({ seed: 5 }).getWorld();
    const { rerender } = render(createElement(OfficeVisualizer, { world }));
    expect(screen.getByText("Demo data")).toBeVisible();

    rerender(createElement(OfficeVisualizer, { world, source: "live" }));
    expect(screen.getByText("Live")).toBeVisible();
  });
});
