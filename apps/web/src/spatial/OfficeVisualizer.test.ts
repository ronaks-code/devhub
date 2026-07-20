// @vitest-environment jsdom

import { createElement } from "react";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { OfficeVisualizer } from "./OfficeVisualizer.js";
import { fleetSnapshotFixture } from "./fleetSnapshot.js";

describe("OfficeVisualizer", () => {
  it("mounts all eight fixture rooms with lifecycle styling and every agent nameplate", () => {
    const { container } = render(
      createElement(OfficeVisualizer, { snapshot: fleetSnapshotFixture }),
    );

    expect(screen.getByTestId("office-visualizer").tagName).toBe("SECTION");
    expect(container.querySelectorAll("main")).toHaveLength(0);

    const rooms = screen.getAllByTestId("office-room");
    expect(rooms).toHaveLength(8);
    expect(container.querySelectorAll('[data-lifecycle="active"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-lifecycle="reserved"]')).toHaveLength(7);

    const hermes = screen.getByRole("region", {
      name: "Hermes department — active",
    });
    expect(hermes).toHaveAttribute("data-lifecycle", "active");
    expect(hermes).toHaveClass("border-emerald-400/60", "bg-emerald-400/[0.07]");

    const athena = screen.getByRole("region", {
      name: "Athena department — reserved",
    });
    expect(athena).toHaveAttribute("data-lifecycle", "reserved");
    expect(athena).toHaveClass(
      "border-zinc-800/80",
      "bg-zinc-900/50",
      "grayscale-[0.25]",
    );
    expect(athena).not.toHaveClass("opacity-55");

    expect(fleetSnapshotFixture.agents).toHaveLength(10);
    expect(screen.getAllByTestId("office-agent")).toHaveLength(10);
    for (const agent of fleetSnapshotFixture.agents) {
      const nameplate = container.querySelector<HTMLElement>(
        `[data-agent-id="${agent.employeeId}"]`,
      );
      expect(nameplate).not.toBeNull();
      expect(within(nameplate!).getByText(agent.displayName)).toBeVisible();
      expect(nameplate).toHaveTextContent(agent.role);
      expect(nameplate).toHaveTextContent(agent.status);
      expect(nameplate).toHaveTextContent(agent.task?.label ?? "Awaiting activation");
    }
  });

  it("renders the supplied snapshot timestamp instead of fixture-specific copy", () => {
    render(
      createElement(OfficeVisualizer, {
        snapshot: {
          ...fleetSnapshotFixture,
          ts: Date.UTC(2030, 0, 2, 3, 4, 0),
        },
      }),
    );

    expect(screen.getByText("2030-01-02 · 03:04 UTC")).toBeVisible();
  });
});
