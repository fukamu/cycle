import { act, renderHook } from "@testing-library/react";
import { StrictMode, type PropsWithChildren } from "react";

import type {
  GoalDeletionAdvisoryChannelLike,
  GoalDeletionAdvisoryFactory,
} from "./goalDeletionAdvisory";
import { useGoalDeletionAdvisory } from "./useGoalDeletionAdvisory";

const userId = "00000000-0000-7000-8000-000000000011";
const goalId = "00000000-0000-7000-8000-000000000012";
const otherUserId = "00000000-0000-7000-8000-000000000013";
const otherGoalId = "00000000-0000-7000-8000-000000000014";

describe("useGoalDeletionAdvisory", () => {
  it("synchronously notifies the exact subscriber before the provider callback", () => {
    const order: string[] = [];
    const onAcceptedGoalDeletionAdvisory = vi.fn(() => {
      order.push("provider");
    });
    const channel = createChannelHarness();
    const rendered = renderHook(() =>
      useGoalDeletionAdvisory({
        getCurrentUserId: () => userId,
        onAcceptedGoalDeletionAdvisory,
        factory: () => channel.channel,
      }),
    );
    const subscriber = vi.fn(() => {
      order.push("subscriber");
    });

    let unsubscribe: () => void = () => undefined;
    act(() => {
      unsubscribe = rendered.result.current.subscribe(
        userId,
        goalId,
        subscriber,
      );
      channel.dispatch(deletionMessage(userId, goalId));
    });

    expect(order).toEqual(["subscriber", "provider"]);
    expect(subscriber).toHaveBeenCalledOnce();
    expect(onAcceptedGoalDeletionAdvisory).toHaveBeenCalledWith({
      deletedUserId: userId,
      deletedGoalId: goalId,
      subscriberNotified: true,
    });
    expect(channel.posted).toEqual([]);

    unsubscribe();
  });

  it("filters by the currently bound user and targets subscribers by exact goal", () => {
    let currentUserId: string | undefined = userId;
    const onAcceptedGoalDeletionAdvisory = vi.fn();
    const channel = createChannelHarness();
    const rendered = renderHook(() =>
      useGoalDeletionAdvisory({
        getCurrentUserId: () => currentUserId,
        onAcceptedGoalDeletionAdvisory,
        factory: () => channel.channel,
      }),
    );
    const subscriber = vi.fn();
    rendered.result.current.subscribe(userId, goalId, subscriber);

    act(() => {
      channel.dispatch(deletionMessage(otherUserId, goalId));
    });
    expect(subscriber).not.toHaveBeenCalled();
    expect(onAcceptedGoalDeletionAdvisory).not.toHaveBeenCalled();

    act(() => {
      channel.dispatch(deletionMessage(userId, otherGoalId));
    });
    expect(subscriber).not.toHaveBeenCalled();
    expect(onAcceptedGoalDeletionAdvisory).toHaveBeenLastCalledWith({
      deletedUserId: userId,
      deletedGoalId: otherGoalId,
      subscriberNotified: false,
    });

    currentUserId = undefined;
    onAcceptedGoalDeletionAdvisory.mockClear();
    act(() => {
      channel.dispatch(deletionMessage(userId, goalId));
    });
    expect(subscriber).not.toHaveBeenCalled();
    expect(onAcceptedGoalDeletionAdvisory).not.toHaveBeenCalled();
  });

  it("latches an accepted advisory and synchronously replays it to a late exact subscriber", () => {
    const onAcceptedGoalDeletionAdvisory = vi.fn();
    const channel = createChannelHarness();
    const rendered = renderHook(() =>
      useGoalDeletionAdvisory({
        getCurrentUserId: () => userId,
        onAcceptedGoalDeletionAdvisory,
        factory: () => channel.channel,
      }),
    );

    act(() => {
      channel.dispatch(deletionMessage(userId, goalId));
      channel.dispatch(deletionMessage(otherUserId, otherGoalId));
    });
    expect(rendered.result.current.isKnown(userId, goalId)).toBe(true);
    expect(rendered.result.current.isKnown(otherUserId, otherGoalId)).toBe(
      false,
    );

    const exact = vi.fn();
    const otherGoal = vi.fn();
    const otherUser = vi.fn();
    act(() => {
      rendered.result.current.subscribe(userId, goalId, exact);
      rendered.result.current.subscribe(userId, otherGoalId, otherGoal);
      rendered.result.current.subscribe(otherUserId, goalId, otherUser);
    });

    expect(exact).toHaveBeenCalledOnce();
    expect(otherGoal).not.toHaveBeenCalled();
    expect(otherUser).not.toHaveBeenCalled();
    expect(onAcceptedGoalDeletionAdvisory).toHaveBeenCalledOnce();
  });

  it("latches a valid local publication before any route subscribes", () => {
    const channel = createChannelHarness();
    const rendered = renderHook(() =>
      useGoalDeletionAdvisory({
        getCurrentUserId: () => userId,
        onAcceptedGoalDeletionAdvisory: vi.fn(),
        factory: () => channel.channel,
      }),
    );

    act(() => {
      rendered.result.current.publish(userId, goalId);
      rendered.result.current.publish("invalid", otherGoalId);
    });
    const exact = vi.fn();
    act(() => {
      rendered.result.current.subscribe(userId, goalId, exact);
    });

    expect(exact).toHaveBeenCalledOnce();
    expect(rendered.result.current.isKnown(userId, goalId)).toBe(true);
    expect(rendered.result.current.isKnown("invalid", otherGoalId)).toBe(false);
    expect(channel.posted).toEqual([deletionMessage(userId, goalId)]);
  });

  it("isolates subscriber failures and reports whether any fence completed", () => {
    const order: string[] = [];
    const onAcceptedGoalDeletionAdvisory = vi.fn(() => {
      order.push("provider");
    });
    const channel = createChannelHarness();
    const rendered = renderHook(() =>
      useGoalDeletionAdvisory({
        getCurrentUserId: () => userId,
        onAcceptedGoalDeletionAdvisory,
        factory: () => channel.channel,
      }),
    );
    rendered.result.current.subscribe(userId, goalId, () => {
      order.push("broken subscriber");
      throw new Error("private subscriber detail");
    });
    rendered.result.current.subscribe(userId, goalId, () => {
      order.push("healthy subscriber");
    });

    expect(() => {
      act(() => {
        channel.dispatch(deletionMessage(userId, goalId));
      });
    }).not.toThrow();

    expect(order).toEqual([
      "broken subscriber",
      "healthy subscriber",
      "provider",
    ]);
    expect(onAcceptedGoalDeletionAdvisory).toHaveBeenCalledWith({
      deletedUserId: userId,
      deletedGoalId: goalId,
      subscriberNotified: true,
    });
  });

  it("falls back when every exact subscriber fails", () => {
    const onAcceptedGoalDeletionAdvisory = vi.fn();
    const channel = createChannelHarness();
    const rendered = renderHook(() =>
      useGoalDeletionAdvisory({
        getCurrentUserId: () => userId,
        onAcceptedGoalDeletionAdvisory,
        factory: () => channel.channel,
      }),
    );
    rendered.result.current.subscribe(userId, goalId, () => {
      throw new Error("private subscriber detail");
    });

    act(() => {
      channel.dispatch(deletionMessage(userId, goalId));
    });

    expect(onAcceptedGoalDeletionAdvisory).toHaveBeenCalledWith({
      deletedUserId: userId,
      deletedGoalId: goalId,
      subscriberNotified: false,
    });
  });

  it("unsubscribes independently and rejects non-canonical subscription IDs", () => {
    const onAcceptedGoalDeletionAdvisory = vi.fn();
    const channel = createChannelHarness();
    const rendered = renderHook(() =>
      useGoalDeletionAdvisory({
        getCurrentUserId: () => userId,
        onAcceptedGoalDeletionAdvisory,
        factory: () => channel.channel,
      }),
    );
    const removed = vi.fn();
    const retained = vi.fn();
    const unsubscribe = rendered.result.current.subscribe(
      userId,
      goalId,
      removed,
    );
    rendered.result.current.subscribe(userId, goalId, retained);
    rendered.result.current.subscribe("invalid", goalId, vi.fn());
    rendered.result.current.subscribe(userId, "invalid", vi.fn());

    unsubscribe();
    unsubscribe();
    act(() => {
      channel.dispatch(deletionMessage(userId, goalId));
    });

    expect(removed).not.toHaveBeenCalled();
    expect(retained).toHaveBeenCalledOnce();
    expect(onAcceptedGoalDeletionAdvisory).toHaveBeenCalledWith({
      deletedUserId: userId,
      deletedGoalId: goalId,
      subscriberNotified: true,
    });
  });

  it("publishes cross-context while synchronously fencing the exact local subscriber", () => {
    const onAcceptedGoalDeletionAdvisory = vi.fn();
    const channel = createChannelHarness();
    const rendered = renderHook(() =>
      useGoalDeletionAdvisory({
        getCurrentUserId: () => userId,
        onAcceptedGoalDeletionAdvisory,
        factory: () => channel.channel,
      }),
    );
    const exactSubscriber = vi.fn();
    const otherSubscriber = vi.fn();
    rendered.result.current.subscribe(userId, goalId, exactSubscriber);
    rendered.result.current.subscribe(userId, otherGoalId, otherSubscriber);

    act(() => {
      rendered.result.current.publish(userId, goalId);
      rendered.result.current.publish("invalid", goalId);
      rendered.result.current.publish(userId, "invalid");
    });

    expect(channel.posted).toEqual([deletionMessage(userId, goalId)]);
    expect(exactSubscriber).toHaveBeenCalledOnce();
    expect(otherSubscriber).not.toHaveBeenCalled();
    expect(onAcceptedGoalDeletionAdvisory).not.toHaveBeenCalled();
  });

  it("coalesces cleanup ownership by the exact user and goal tuple", async () => {
    const channel = createChannelHarness();
    const rendered = renderHook(() =>
      useGoalDeletionAdvisory({
        getCurrentUserId: () => userId,
        onAcceptedGoalDeletionAdvisory: vi.fn(),
        factory: () => channel.channel,
      }),
    );

    const owner = rendered.result.current.beginCleanup(userId, goalId);
    const joined = rendered.result.current.beginCleanup(userId, goalId);
    const otherUserOwner = rendered.result.current.beginCleanup(
      otherUserId,
      goalId,
    );
    const otherGoalOwner = rendered.result.current.beginCleanup(
      userId,
      otherGoalId,
    );

    expect(owner.kind).toBe("owner");
    expect(joined.kind).toBe("joined");
    expect(joined.completion).toBe(owner.completion);
    expect(otherUserOwner.kind).toBe("owner");
    expect(otherGoalOwner.kind).toBe("owner");

    let ownerCompleted = false;
    void owner.completion.then(() => {
      ownerCompleted = true;
    });
    if (owner.kind === "owner") owner.complete();
    await owner.completion;
    expect(ownerCompleted).toBe(true);

    if (otherUserOwner.kind === "owner") otherUserOwner.complete();
    if (otherGoalOwner.kind === "owner") otherGoalOwner.complete();
  });

  it("retains a completed claim so later cleanup attempts join it", async () => {
    const channel = createChannelHarness();
    const rendered = renderHook(() =>
      useGoalDeletionAdvisory({
        getCurrentUserId: () => userId,
        onAcceptedGoalDeletionAdvisory: vi.fn(),
        factory: () => channel.channel,
      }),
    );

    const firstOwner = rendered.result.current.beginCleanup(userId, goalId);
    expect(firstOwner.kind).toBe("owner");
    if (firstOwner.kind !== "owner") throw new Error("expected owner");
    firstOwner.complete();
    firstOwner.complete();
    await firstOwner.completion;

    const secondClaim = rendered.result.current.beginCleanup(userId, goalId);
    expect(secondClaim.kind).toBe("joined");
    expect(secondClaim.completion).toBe(firstOwner.completion);
    expect(await secondClaim.completion).toBe("completed");

    firstOwner.complete();
    const stillJoined = rendered.result.current.beginCleanup(userId, goalId);
    expect(stillJoined.kind).toBe("joined");
    expect(stillJoined.completion).toBe(firstOwner.completion);
    expect(await stillJoined.completion).toBe("completed");
  });

  it("settles a failed claim for every joiner before allowing a fresh owner", async () => {
    const channel = createChannelHarness();
    const rendered = renderHook(() =>
      useGoalDeletionAdvisory({
        getCurrentUserId: () => userId,
        onAcceptedGoalDeletionAdvisory: vi.fn(),
        factory: () => channel.channel,
      }),
    );

    const failedOwner = rendered.result.current.beginCleanup(userId, goalId);
    const failedJoiner = rendered.result.current.beginCleanup(userId, goalId);
    expect(failedOwner.kind).toBe("owner");
    expect(failedJoiner.kind).toBe("joined");
    if (failedOwner.kind !== "owner") throw new Error("expected owner");

    failedOwner.fail();
    failedOwner.complete();
    expect(await failedOwner.completion).toBe("failed");
    expect(await failedJoiner.completion).toBe("failed");

    const replacement = rendered.result.current.beginCleanup(userId, goalId);
    expect(replacement.kind).toBe("owner");
    expect(replacement.completion).not.toBe(failedOwner.completion);
    if (replacement.kind === "owner") replacement.complete();
    expect(await replacement.completion).toBe("completed");
  });

  it("uses collision-free tuple identity without validating cleanup inputs", async () => {
    const channel = createChannelHarness();
    const rendered = renderHook(() =>
      useGoalDeletionAdvisory({
        getCurrentUserId: () => userId,
        onAcceptedGoalDeletionAdvisory: vi.fn(),
        factory: () => channel.channel,
      }),
    );

    const first = rendered.result.current.beginCleanup("a", "b\u0000c");
    const second = rendered.result.current.beginCleanup("a\u0000b", "c");
    const firstJoined = rendered.result.current.beginCleanup("a", "b\u0000c");

    expect(first.kind).toBe("owner");
    expect(second.kind).toBe("owner");
    expect(firstJoined.kind).toBe("joined");
    expect(firstJoined.completion).toBe(first.completion);
    expect(second.completion).not.toBe(first.completion);

    if (first.kind === "owner") first.complete();
    if (second.kind === "owner") second.complete();
    await Promise.all([first.completion, second.completion]);
  });

  it("uses the latest owner callbacks without replacing the channel", () => {
    const channel = createChannelHarness();
    const factory = vi.fn(() => channel.channel);
    const firstCallback = vi.fn();
    const secondCallback = vi.fn();
    const rendered = renderHook(
      ({ onAccepted }: { readonly onAccepted: () => void }) =>
        useGoalDeletionAdvisory({
          getCurrentUserId: () => userId,
          onAcceptedGoalDeletionAdvisory: onAccepted,
          factory,
        }),
      { initialProps: { onAccepted: firstCallback } },
    );

    rendered.rerender({ onAccepted: secondCallback });
    act(() => {
      channel.dispatch(deletionMessage(userId, goalId));
    });

    expect(factory).toHaveBeenCalledOnce();
    expect(firstCallback).not.toHaveBeenCalled();
    expect(secondCallback).toHaveBeenCalledOnce();
  });

  it("contains owner callback and current-user lookup failures", () => {
    const channel = createChannelHarness();
    const getCurrentUserId = vi
      .fn<() => string | undefined>()
      .mockImplementationOnce(() => {
        throw new Error("private identity detail");
      })
      .mockReturnValue(userId);
    const onAcceptedGoalDeletionAdvisory = vi.fn(() => {
      throw new Error("private provider detail");
    });
    renderHook(() =>
      useGoalDeletionAdvisory({
        getCurrentUserId,
        onAcceptedGoalDeletionAdvisory,
        factory: () => channel.channel,
      }),
    );

    expect(() => {
      act(() => {
        channel.dispatch(deletionMessage(userId, goalId));
        channel.dispatch(deletionMessage(userId, goalId));
      });
    }).not.toThrow();
    expect(onAcceptedGoalDeletionAdvisory).toHaveBeenCalledOnce();
  });

  it("closes every StrictMode channel exactly once", () => {
    const channels: ReturnType<typeof createChannelHarness>[] = [];
    const factory: GoalDeletionAdvisoryFactory = () => {
      const channel = createChannelHarness();
      channels.push(channel);
      return channel.channel;
    };
    const rendered = renderHook(
      () =>
        useGoalDeletionAdvisory({
          getCurrentUserId: () => userId,
          onAcceptedGoalDeletionAdvisory: vi.fn(),
          factory,
        }),
      { wrapper: StrictModeWrapper },
    );

    rendered.unmount();

    expect(channels.length).toBeGreaterThan(0);
    for (const channel of channels) {
      expect(channel.addEventListener).toHaveBeenCalledOnce();
      expect(channel.removeEventListener).toHaveBeenCalledOnce();
      expect(channel.close).toHaveBeenCalledOnce();
    }
  });

  it("keeps every registry callback stable across rerenders and StrictMode", () => {
    const channel = createChannelHarness();
    const rendered = renderHook(
      () =>
        useGoalDeletionAdvisory({
          getCurrentUserId: () => userId,
          onAcceptedGoalDeletionAdvisory: vi.fn(),
          factory: () => channel.channel,
        }),
      { wrapper: StrictModeWrapper },
    );
    const firstRegistry = rendered.result.current;

    rendered.rerender();

    expect(rendered.result.current).toBe(firstRegistry);
    expect(rendered.result.current.publish).toBe(firstRegistry.publish);
    expect(rendered.result.current.subscribe).toBe(firstRegistry.subscribe);
    expect(rendered.result.current.beginCleanup).toBe(
      firstRegistry.beginCleanup,
    );
    expect(rendered.result.current.isKnown).toBe(firstRegistry.isKnown);
  });
});

function deletionMessage(deletedUserId: string, deletedGoalId: string) {
  return { version: 1, deletedUserId, deletedGoalId } as const;
}

function createChannelHarness() {
  const posted: unknown[] = [];
  const listeners = new Set<(event: { readonly data: unknown }) => void>();
  const addEventListener = vi.fn(
    (
      _type: "message",
      listener: (event: { readonly data: unknown }) => void,
    ) => {
      listeners.add(listener);
    },
  );
  const removeEventListener = vi.fn(
    (
      _type: "message",
      listener: (event: { readonly data: unknown }) => void,
    ) => {
      listeners.delete(listener);
    },
  );
  const close = vi.fn();
  const channel: GoalDeletionAdvisoryChannelLike = {
    postMessage: (message) => posted.push(message),
    addEventListener,
    removeEventListener,
    close,
  };
  return {
    channel,
    posted,
    addEventListener,
    removeEventListener,
    close,
    dispatch(data: unknown) {
      for (const listener of listeners) listener({ data });
    },
  };
}

function StrictModeWrapper({ children }: PropsWithChildren) {
  return <StrictMode>{children}</StrictMode>;
}
