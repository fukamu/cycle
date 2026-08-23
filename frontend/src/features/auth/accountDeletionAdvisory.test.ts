import {
  createAccountDeletionAdvisory,
  type AccountDeletionAdvisoryChannelLike,
} from "./accountDeletionAdvisory";

const userId = "00000000-0000-7000-8000-000000000001";

describe("account deletion advisory", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses a fixed versioned channel and emits only a canonical deleted user ID", () => {
    const fake = createFakeChannel();
    const factory = vi.fn(() => fake.channel);
    const advisory = createAccountDeletionAdvisory(vi.fn(), factory);

    advisory?.publish(userId);
    advisory?.publish("not-a-user-id");

    expect(factory).toHaveBeenCalledWith("fukamu-cycle-account-deletion-v1");
    expect(fake.posted).toEqual([{ version: 1, deletedUserId: userId }]);
  });

  it("accepts only the fixed version and canonical deleted user ID", () => {
    const fake = createFakeChannel();
    const listener = vi.fn();
    createAccountDeletionAdvisory(listener, () => fake.channel);

    fake.dispatch({ version: 1, deletedUserId: userId });
    fake.dispatch({ version: 2, deletedUserId: userId });
    fake.dispatch({ version: 1, deletedUserId: "invalid" });
    fake.dispatch({ version: 1, deletedUserId: userId, token: "private" });
    fake.dispatch(null);

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenNthCalledWith(1, userId);
  });

  it("ignores inaccessible payloads and callback failures", () => {
    const fake = createFakeChannel();
    const listener = vi.fn(() => {
      throw new Error("private callback detail");
    });
    createAccountDeletionAdvisory(listener, () => fake.channel);
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
      fake.dispatch({ version: 1, deletedUserId: userId }),
    ).not.toThrow();
    expect(listener).toHaveBeenCalledOnce();
  });

  it("unsubscribes and closes idempotently", () => {
    const fake = createFakeChannel();
    const listener = vi.fn();
    const advisory = createAccountDeletionAdvisory(
      listener,
      () => fake.channel,
    );

    advisory?.close();
    advisory?.close();
    fake.dispatch({ version: 1, deletedUserId: userId });
    advisory?.publish(userId);

    expect(listener).not.toHaveBeenCalled();
    expect(fake.removeEventListener).toHaveBeenCalledOnce();
    expect(fake.close).toHaveBeenCalledOnce();
    expect(fake.posted).toEqual([]);
  });

  it("fails closed without exposing channel implementation failures", () => {
    const constructorFailure = () => {
      throw new Error("private constructor detail");
    };
    expect(
      createAccountDeletionAdvisory(vi.fn(), constructorFailure),
    ).toBeNull();

    const close = vi.fn();
    const listenerFailure: AccountDeletionAdvisoryChannelLike = {
      postMessage: vi.fn(),
      addEventListener: () => {
        throw new Error("private listener detail");
      },
      removeEventListener: vi.fn(),
      close,
    };
    expect(
      createAccountDeletionAdvisory(vi.fn(), () => listenerFailure),
    ).toBeNull();
    expect(close).toHaveBeenCalledOnce();

    const fake = createFakeChannel();
    const deliveryFailure: AccountDeletionAdvisoryChannelLike = {
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
    const advisory = createAccountDeletionAdvisory(
      vi.fn(),
      () => deliveryFailure,
    );
    expect(() => advisory?.publish(userId)).not.toThrow();
    expect(() => advisory?.close()).not.toThrow();
  });

  it("falls back to the durable tombstone when BroadcastChannel is unsupported", () => {
    vi.stubGlobal("BroadcastChannel", undefined);
    expect(createAccountDeletionAdvisory(vi.fn())).toBeNull();
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
  const channel: AccountDeletionAdvisoryChannelLike = {
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
