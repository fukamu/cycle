import {
  createSessionIdentityAdvisory,
  type SessionIdentityAdvisoryChannelLike,
} from "./sessionIdentityAdvisory";

const userId = "00000000-0000-7000-8000-000000000001";

describe("session identity advisory", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses a fixed versioned channel and emits only a canonical target user ID", () => {
    const fake = createFakeChannel();
    const factory = vi.fn(() => fake.channel);
    const advisory = createSessionIdentityAdvisory(vi.fn(), factory);

    advisory?.publish(userId);
    advisory?.publish("not-a-user-id");

    expect(factory).toHaveBeenCalledWith("fukamu-cycle-session-identity-v1");
    expect(fake.posted).toEqual([{ version: 1, targetUserId: userId }]);
  });

  it("accepts only the fixed version and canonical target user ID", () => {
    const fake = createFakeChannel();
    const listener = vi.fn();
    createSessionIdentityAdvisory(listener, () => fake.channel);

    fake.dispatch({ version: 1, targetUserId: userId });
    fake.dispatch({ version: 2, targetUserId: userId });
    fake.dispatch({ version: 1, targetUserId: "invalid" });
    fake.dispatch({ version: 1, targetUserId: userId, token: "private" });
    fake.dispatch(null);

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenNthCalledWith(1, userId);
  });

  it("ignores a payload whose properties cannot be inspected", () => {
    const fake = createFakeChannel();
    const listener = vi.fn();
    createSessionIdentityAdvisory(listener, () => fake.channel);
    const inaccessiblePayload = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error("private payload detail");
        },
      },
    );

    expect(() => fake.dispatch(inaccessiblePayload)).not.toThrow();
    expect(listener).not.toHaveBeenCalled();
  });

  it("unsubscribes and closes idempotently", () => {
    const fake = createFakeChannel();
    const listener = vi.fn();
    const advisory = createSessionIdentityAdvisory(
      listener,
      () => fake.channel,
    );

    advisory?.close();
    advisory?.close();
    fake.dispatch({ version: 1, targetUserId: userId });
    advisory?.publish(userId);

    expect(listener).not.toHaveBeenCalled();
    expect(fake.removeEventListener).toHaveBeenCalledOnce();
    expect(fake.close).toHaveBeenCalledOnce();
    expect(fake.posted).toEqual([]);
  });

  it("turns constructor failure into an unavailable advisory", () => {
    const factory = () => {
      throw new Error("private channel constructor detail");
    };

    expect(() => createSessionIdentityAdvisory(vi.fn(), factory)).not.toThrow();
    expect(createSessionIdentityAdvisory(vi.fn(), factory)).toBeNull();
  });

  it("closes and disables a channel whose listener cannot be registered", () => {
    const close = vi.fn();
    const brokenChannel: SessionIdentityAdvisoryChannelLike = {
      postMessage: vi.fn(),
      addEventListener: () => {
        throw new Error("private listener detail");
      },
      removeEventListener: vi.fn(),
      close,
    };

    expect(() =>
      createSessionIdentityAdvisory(vi.fn(), () => brokenChannel),
    ).not.toThrow();
    expect(
      createSessionIdentityAdvisory(vi.fn(), () => brokenChannel),
    ).toBeNull();
    expect(close).toHaveBeenCalledTimes(2);
  });

  it("does not let post or cleanup failures escape", () => {
    const fake = createFakeChannel();
    const brokenChannel: SessionIdentityAdvisoryChannelLike = {
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
    const advisory = createSessionIdentityAdvisory(
      vi.fn(),
      () => brokenChannel,
    );

    expect(() => advisory?.publish(userId)).not.toThrow();
    expect(() => advisory?.close()).not.toThrow();
  });

  it("falls back without an advisory when BroadcastChannel is unsupported", () => {
    vi.stubGlobal("BroadcastChannel", undefined);
    expect(createSessionIdentityAdvisory(vi.fn())).toBeNull();
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
  const channel: SessionIdentityAdvisoryChannelLike = {
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
