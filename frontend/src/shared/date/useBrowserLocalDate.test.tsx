import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useBrowserLocalDate } from "./useBrowserLocalDate";

function Probe() {
  return <output>{useBrowserLocalDate()}</output>;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("useBrowserLocalDate", () => {
  it("refreshes at local midnight and on focus", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 15, 23, 59, 59));
    render(<Probe />);
    expect(screen.getByText("2026-09-15")).toBeVisible();

    act(() => {
      vi.setSystemTime(new Date(2026, 8, 16, 0, 0, 0));
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByText("2026-09-16")).toBeVisible();

    act(() => {
      vi.setSystemTime(new Date(2026, 8, 17, 12, 0, 0));
      window.dispatchEvent(new Event("focus"));
    });
    expect(screen.getByText("2026-09-17")).toBeVisible();
  });

  it("refreshes only when visible and removes listeners and timers", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 15, 12, 0, 0));
    let visibility: DocumentVisibilityState = "hidden";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(
      () => visibility,
    );
    const removeWindowListener = vi.spyOn(window, "removeEventListener");
    const removeDocumentListener = vi.spyOn(document, "removeEventListener");
    const rendered = render(<Probe />);

    act(() => {
      vi.setSystemTime(new Date(2026, 8, 16, 12, 0, 0));
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(screen.getByText("2026-09-15")).toBeVisible();

    visibility = "visible";
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(screen.getByText("2026-09-16")).toBeVisible();

    rendered.unmount();
    expect(removeWindowListener).toHaveBeenCalledWith(
      "focus",
      expect.any(Function),
    );
    expect(removeDocumentListener).toHaveBeenCalledWith(
      "visibilitychange",
      expect.any(Function),
    );
    expect(vi.getTimerCount()).toBe(0);
  });
});
