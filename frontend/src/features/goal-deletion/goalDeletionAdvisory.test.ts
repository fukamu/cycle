import {
  createGoalDeletionAdvisory,
  type GoalDeletionAdvisoryChannelLike,
} from "./goalDeletionAdvisory";

const userId = "00000000-0000-7000-8000-000000000001";
const goalId = "00000000-0000-7000-8000-000000000002";

describe("goal deletion advisory", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses a fixed versioned channel and emits only canonical IDs", () => {
    const fake = createFakeChannel();
    const factory = vi.fn(() => fake.channel);
    const advisory = createGoalDeletionAdvisory(vi.fn(), factory);

    advisory?.publish(userId, goalId);
    advisory?.publish("not-a-user-id", goalId);
    advisory?.publish(userId, "not-a-goal-id");

    expect(factory).toHaveBeenCalledWith("fukamu-cycle-goal-deletion-v1");
    expect(fake.posted).toEqual([
      { version: 1, deletedUserId: userId, deletedGoalId: goalId },
    ]);
  });

  it("accepts only the exact versioned payload with two canonical IDs", () => {
    const fake = createFakeChannel();
    const listener = vi.fn();
    createGoalDeletionAdvisory(listener, () => fake.channel);

    fake.dispatch({
      version: 1,
      deletedUserId: userId,
      deletedGoalId: goalId,
    });
    fake.dispatch({
      version: 2,
      deletedUserId: userId,
      deletedGoalId: goalId,
    });
    fake.dispatch({
      version: 1,
      deletedUserId: "invalid",
      deletedGoalId: goalId,
    });
    fake.dispatch({
      version: 1,
      deletedUserId: userId,
      deletedGoalId: "invalid",
    });
    fake.dispatch({
      version: 1,
      deletedUserId: userId,
      deletedGoalId: goalId,
      token: "private",
    });
    fake.dispatch(null);

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith(userId, goalId);
    expect(fake.posted).toEqual([]);
  });

  it("ignores inaccessible payloads and callback failures", () => {
    const fake = createFakeChannel();
    const listener = vi.fn(() => {
      throw new Error("private callback detail");
    });
    createGoalDeletionAdvisory(listener, () => fake.channel);
    const inaccessiblePayload = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error("private payload detail");
        },
      },
    );

    expect(() => fake.dispatch(inaccessiblePayload)).not.toThrow();
    expect(() =>
      fake.dispatch({
        version: 1,
        deletedUserId: userId,
        deletedGoalId: goalId,
      }),
    ).not.toThrow();
    expect(listener).toHaveBeenCalledOnce();
  });

  it("unsubscribes and closes idempotently", () => {
    const fake = createFakeChannel();
    const listener = vi.fn();
    const advisory = createGoalDeletionAdvisory(listener, () => fake.channel);

    advisory?.close();
    advisory?.close();
    fake.dispatch({
      version: 1,
      deletedUserId: userId,
      deletedGoalId: goalId,
    });
    advisory?.publish(userId, goalId);

    expect(listener).not.toHaveBeenCalled();
    expect(fake.removeEventListener).toHaveBeenCalledOnce();
    expect(fake.close).toHaveBeenCalledOnce();
    expect(fake.posted).toEqual([]);
  });

  it("fails safely without exposing channel implementation failures", () => {
    const constructorFailure = () => {
      throw new Error("private constructor detail");
    };
    expect(createGoalDeletionAdvisory(vi.fn(), constructorFailure)).toBeNull();

    const close = vi.fn();
    const listenerFailure: GoalDeletionAdvisoryChannelLike = {
      postMessage: vi.fn(),
      addEventListener: () => {
        throw new Error("private listener detail");
      },
      removeEventListener: vi.fn(),
      close,
    };
    expect(
      createGoalDeletionAdvisory(vi.fn(), () => listenerFailure),
    ).toBeNull();
    expect(close).toHaveBeenCalledOnce();

    const fake = createFakeChannel();
    const deliveryFailure: GoalDeletionAdvisoryChannelLike = {
      ...fake.channel,
      postMessage: () => {
        throw new Error("private post detail");
      },
      removeEventListener: () => {
        throw new Error("private remove detail");
      },
      close: () => {
        throw new Error("private close detail");
      },
    };
    const advisory = createGoalDeletionAdvisory(vi.fn(), () => deliveryFailure);
    expect(() => advisory?.publish(userId, goalId)).not.toThrow();
    expect(() => advisory?.close()).not.toThrow();
  });

  it("falls back to durable state when BroadcastChannel is unsupported", () => {
    vi.stubGlobal("BroadcastChannel", undefined);
    expect(createGoalDeletionAdvisory(vi.fn())).toBeNull();
  });
});

function createFakeChannel() {
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
    removeEventListener,
    close,
    dispatch(data: unknown) {
      for (const listener of listeners) listener({ data });
    },
  };
}
