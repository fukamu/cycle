import { renderHook } from "@testing-library/react";
import type { PropsWithChildren } from "react";

import {
  GoalDeletionAdvisoryContext,
  type GoalDeletionAdvisoryRegistry,
  usePublishGoalDeletionAdvisory,
  useSubscribeGoalDeletionAdvisory,
} from "./goalDeletionContext";

describe("goal deletion advisory context", () => {
  it("exposes the owner publish and subscribe functions", () => {
    const registry: GoalDeletionAdvisoryRegistry = {
      publish: vi.fn(),
      subscribe: vi.fn(() => vi.fn()),
    };
    const wrapper = ({ children }: PropsWithChildren) => (
      <GoalDeletionAdvisoryContext.Provider value={registry}>
        {children}
      </GoalDeletionAdvisoryContext.Provider>
    );

    const publish = renderHook(() => usePublishGoalDeletionAdvisory(), {
      wrapper,
    });
    const subscribe = renderHook(() => useSubscribeGoalDeletionAdvisory(), {
      wrapper,
    });

    expect(publish.result.current).toBe(registry.publish);
    expect(subscribe.result.current).toBe(registry.subscribe);
  });

  it("rejects consumers outside the SessionProvider-owned boundary", () => {
    expect(() => renderHook(() => usePublishGoalDeletionAdvisory())).toThrow(
      "goal deletion advisory unavailable",
    );
    expect(() => renderHook(() => useSubscribeGoalDeletionAdvisory())).toThrow(
      "goal deletion advisory unavailable",
    );
  });
});
