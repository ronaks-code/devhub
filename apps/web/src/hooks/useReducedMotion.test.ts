// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useReducedMotion } from "./useReducedMotion";

let originalStorage: PropertyDescriptor | undefined;

beforeEach(() => {
  originalStorage = Object.getOwnPropertyDescriptor(window, "localStorage");
  const values = new Map<string, string>();
  const storage: Storage = {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key); },
    setItem: (key, value) => { values.set(key, String(value)); },
  };
  Object.defineProperty(window, "localStorage", { configurable: true, value: storage });
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  document.documentElement.removeAttribute("data-reduce-motion");
  vi.unstubAllGlobals();
  if (originalStorage) Object.defineProperty(window, "localStorage", originalStorage);
  else delete (window as { localStorage?: Storage }).localStorage;
});

function MotionHarness() {
  const motion = useReducedMotion();
  return createElement(
    "button",
    { type: "button", onClick: motion.cyclePreference },
    `${motion.preference}:${motion.reduced ? "reduced" : "full"}`,
  );
}

describe("useReducedMotion", () => {
  it("makes the first click change the effective state even when the OS already reduces motion", async () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })));

    render(createElement(MotionHarness));
    expect(screen.getByRole("button")).toHaveTextContent("auto:reduced");
    await userEvent.setup().click(screen.getByRole("button"));
    expect(screen.getByRole("button")).toHaveTextContent("off:full");
    expect(window.localStorage.getItem("devhub:perf-mode")).toBe("off");
    expect(document.documentElement).not.toHaveAttribute("data-reduce-motion");
  });

  it("toggles on and off and persists both choices when the OS allows motion", async () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })));

    render(createElement(MotionHarness));
    const button = screen.getByRole("button");
    await userEvent.setup().click(button);
    expect(button).toHaveTextContent("on:reduced");
    expect(window.localStorage.getItem("devhub:perf-mode")).toBe("on");
    expect(document.documentElement).toHaveAttribute("data-reduce-motion", "true");

    await userEvent.setup().click(button);
    expect(button).toHaveTextContent("off:full");
    expect(window.localStorage.getItem("devhub:perf-mode")).toBe("off");
    expect(document.documentElement).not.toHaveAttribute("data-reduce-motion");
  });
});
