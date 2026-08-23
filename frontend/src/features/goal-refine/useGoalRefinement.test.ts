import { act, renderHook } from "@testing-library/react";

import type { GoalRefineResponse } from "../../shared/api/schemas";
import { useGoalRefinement } from "./useGoalRefinement";

const suggestion: GoalRefineResponse = {
  generationId: "generation-1",
  sourceDraftRevision: 1,
  sourceGoalRevision: 0,
  suggestion: "提案された目標",
  contextChanged: false,
  replayed: false,
};

describe("useGoalRefinement", () => {
  it("associates a suggestion with the source body", async () => {
    const { result } = renderHook(() => useGoalRefinement());

    await act(() => result.current.request("元の目標", async () => suggestion));

    expect(result.current.state).toEqual({
      kind: "suggested",
      response: suggestion,
      sourceBody: "元の目標",
    });
  });

  it("restores the previous suggestion when refreshing fails", async () => {
    const { result } = renderHook(() => useGoalRefinement());
    await act(() => result.current.request("元の目標", async () => suggestion));

    await act(() =>
      result.current.request("元の目標", async () => {
        throw new Error("unavailable");
      }),
    );

    expect(result.current.state).toEqual({
      kind: "suggested",
      response: suggestion,
      sourceBody: "元の目標",
    });
    expect(result.current.requestError).toContain("前の提案");
  });

  it("shows the failed state when no suggestion can be restored", async () => {
    const { result } = renderHook(() => useGoalRefinement());

    await act(() =>
      result.current.request("元の目標", async () => {
        throw new Error("unavailable");
      }),
    );

    expect(result.current.state).toEqual({ kind: "failed" });
  });

  it.each(["resolve", "reject"] as const)(
    "ignores a late settlement when its editor scope is no longer current: %s",
    async (settlement) => {
      let resolve!: (value: GoalRefineResponse) => void;
      let reject!: (reason: unknown) => void;
      const completion = new Promise<GoalRefineResponse>((done, fail) => {
        resolve = done;
        reject = fail;
      });
      let current = true;
      const { result } = renderHook(() => useGoalRefinement());
      let request!: Promise<void>;

      act(() => {
        request = result.current.request(
          "元の目標",
          () => completion,
          () => current,
        );
      });
      expect(result.current.state).toEqual({ kind: "running" });

      current = false;
      await act(async () => {
        if (settlement === "resolve") {
          resolve(suggestion);
        } else {
          reject(new Error("late failure"));
        }
        await request;
      });

      expect(result.current.state).toEqual({ kind: "running" });
      expect(result.current.requestError).toBeUndefined();
    },
  );

  it("invalidates an in-flight request when the suggestion is dismissed", async () => {
    let resolve!: (value: GoalRefineResponse) => void;
    const completion = new Promise<GoalRefineResponse>((done) => {
      resolve = done;
    });
    const { result } = renderHook(() => useGoalRefinement());
    let request!: Promise<void>;

    act(() => {
      request = result.current.request("元の目標", () => completion);
    });
    expect(result.current.state).toEqual({ kind: "running" });

    act(() => result.current.dismiss());
    await act(async () => {
      resolve(suggestion);
      await request;
    });

    expect(result.current.state).toEqual({ kind: "idle" });
    expect(result.current.requestError).toBeUndefined();
  });
});
