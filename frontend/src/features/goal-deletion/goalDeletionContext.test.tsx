import { renderHook } from "@testing-library/react";
import type { PropsWithChildren } from "react";

import {
  GoalDeletionAdvisoryContext,
  type GoalDeletionAdvisoryRegistry,
  useBeginGoalDeletionCleanup,
  usePublishGoalDeletionAdvisory,
  useSubscribeGoalDeletionAdvisory,
} from "./goalDeletionContext";

describe("goal deletion advisory context", () => {
  it("exposes the owner publish and subscribe functions", () => {
    const registry: GoalDeletionAdvisoryRegistry = {
      publish: vi.fn(),
      subscribe: vi.fn(() => vi.fn()),
      beginCleanup: vi.fn(() => ({
        kind: "joined" as const,
        completion: Promise.resolve(),
      })),
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
    const beginCleanup = renderHook(() => useBeginGoalDeletionCleanup(), {
      wrapper,
    });

    expect(publish.result.current).toBe(registry.publish);
    expect(subscribe.result.current).toBe(registry.subscribe);
    expect(beginCleanup.result.current).toBe(registry.beginCleanup);
  });

  it("rejects consumers outside the SessionProvider-owned boundary", () => {
    expect(() => renderHook(() => usePublishGoalDeletionAdvisory())).toThrow(
      "goal deletion advisory unavailable",
    );
    expect(() => renderHook(() => useSubscribeGoalDeletionAdvisory())).toThrow(
      "goal deletion advisory unavailable",
    );
    expect(() => renderHook(() => useBeginGoalDeletionCleanup())).toThrow(
      "goal deletion advisory unavailable",
    );
  });
});
