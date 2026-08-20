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
});
