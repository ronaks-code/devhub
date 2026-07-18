// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mergeToast, ToastStack, type ToastItem } from "./Toast";

afterEach(cleanup);

describe("fetch-error toast deduplication", () => {
  it("keeps one card per endpoint, increments its count, and uses the latest retry", () => {
    const firstRetry = vi.fn();
    const latestRetry = vi.fn();
    const first = mergeToast([], {
      title: "Couldn't load /api/rollups",
      dedupeKey: "GET /api/rollups",
      onClick: firstRetry,
    }, 1);
    const repeated = mergeToast(first, {
      title: "Couldn't load /api/rollups",
      dedupeKey: "GET /api/rollups",
      onClick: latestRetry,
    }, 2);

    expect(repeated).toHaveLength(1);
    expect(repeated[0]).toMatchObject({ id: 2, repeatCount: 2, onClick: latestRetry });

    const separate = mergeToast(repeated, {
      title: "Couldn't load /api/stats",
      dedupeKey: "GET /api/stats",
    }, 3);
    expect(separate).toHaveLength(2);
  });

  it("shows the repeat count only when an endpoint repeats", () => {
    const toasts: ToastItem[] = [
      { id: 1, title: "One", dedupeKey: "GET /api/one" },
      { id: 2, title: "Rollups", dedupeKey: "GET /api/rollups", repeatCount: 3 },
    ];
    render(createElement(ToastStack, { toasts, onDismiss: vi.fn() }));
    expect(screen.queryByText("×1")).toBeNull();
    expect(screen.getByText("×3")).toBeInTheDocument();
  });
});
