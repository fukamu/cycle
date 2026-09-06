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

  it("publishes through the owner channel without receiving its own message", () => {
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
      rendered.result.current.publish(userId, goalId);
      rendered.result.current.publish("invalid", goalId);
      rendered.result.current.publish(userId, "invalid");
    });

    expect(channel.posted).toEqual([deletionMessage(userId, goalId)]);
    expect(onAcceptedGoalDeletionAdvisory).not.toHaveBeenCalled();
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
