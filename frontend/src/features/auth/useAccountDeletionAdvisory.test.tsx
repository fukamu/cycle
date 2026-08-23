import { QueryClient } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { StrictMode, type PropsWithChildren } from "react";

import type { Session } from "../../shared/api/schemas";
import type { AutoSaveScopeRegistry } from "../../shared/autosave/AutoSaveScopeProvider";
import { clearUserDrafts } from "../../shared/drafts/browserDraftCache";
import type {
  AccountDeletionAdvisoryChannelLike,
  AccountDeletionAdvisoryFactory,
} from "./accountDeletionAdvisory";
import { useAccountDeletionAdvisory } from "./useAccountDeletionAdvisory";

vi.mock("../../shared/drafts/browserDraftCache", () => ({
  clearUserDrafts: vi.fn(),
}));

const sessionQueryKey = ["session"] as const;
const session: Session = {
  user: {
    id: "00000000-0000-7000-8000-000000000002",
    googleConnected: false,
    googleEmail: null,
  },
  csrfToken: "csrf-token",
};
const otherUserId = "00000000-0000-7000-8000-000000000003";
const clearUserDraftsMock = vi.mocked(clearUserDrafts);

beforeEach(() => {
  clearUserDraftsMock.mockReset();
  clearUserDraftsMock.mockResolvedValue(undefined);
});

describe("useAccountDeletionAdvisory", () => {
  it("synchronously fences only the deleted identity before discarding drafts and reloading", async () => {
    const quiesceGate = deferredVoid();
    const quiesce = vi.fn(async () => quiesceGate.promise);
    const suspendInteractionAndInvalidateLease = vi.fn();
    const reloadApplication = vi.fn();
    const channel = createChannelHarness();
    const queryClient = createQueryClient();

    renderHook(() =>
      useAccountDeletionAdvisory({
        queryClient,
        sessionQueryKey,
        autoSaveScopes: createAutoSaveScopes(quiesce),
        suspendInteractionAndInvalidateLease,
        onUnboundAccountDeletionAdvisory: vi.fn(),
        reloadApplication,
        factory: () => channel.channel,
      }),
    );

    act(() => {
      channel.dispatch({ version: 1, deletedUserId: otherUserId });
    });
    expect(suspendInteractionAndInvalidateLease).not.toHaveBeenCalled();
    expect(quiesce).not.toHaveBeenCalled();

    act(() => {
      channel.dispatch({ version: 1, deletedUserId: session.user.id });
    });
    expect(suspendInteractionAndInvalidateLease).toHaveBeenCalledOnce();
    expect(quiesce).toHaveBeenCalledWith({ preserveDrafts: false });
    expect(clearUserDraftsMock).not.toHaveBeenCalled();
    expect(reloadApplication).not.toHaveBeenCalled();

    quiesceGate.resolve();
    await waitFor(() =>
      expect(clearUserDraftsMock).toHaveBeenCalledWith(session.user.id),
    );
    await waitFor(() => expect(reloadApplication).toHaveBeenCalledOnce());
  });

  it("hands an unbound advisory to initial-session cancellation without guessing an identity", () => {
    const queryClient = new QueryClient();
    const onUnboundAccountDeletionAdvisory = vi.fn();
    const suspendInteractionAndInvalidateLease = vi.fn();
    const quiesce = vi.fn(async () => undefined);
    const reloadApplication = vi.fn();
    const channel = createChannelHarness();

    renderHook(() =>
      useAccountDeletionAdvisory({
        queryClient,
        sessionQueryKey,
        autoSaveScopes: createAutoSaveScopes(quiesce),
        suspendInteractionAndInvalidateLease,
        onUnboundAccountDeletionAdvisory,
        reloadApplication,
        factory: () => channel.channel,
      }),
    );

    act(() => {
      channel.dispatch({ version: 1, deletedUserId: session.user.id });
    });

    expect(onUnboundAccountDeletionAdvisory).toHaveBeenCalledOnce();
    expect(suspendInteractionAndInvalidateLease).not.toHaveBeenCalled();
    expect(quiesce).not.toHaveBeenCalled();
    expect(clearUserDraftsMock).not.toHaveBeenCalled();
    expect(reloadApplication).not.toHaveBeenCalled();
  });

  it("retries a failed durable clear when the sender confirms the tombstone", async () => {
    clearUserDraftsMock
      .mockRejectedValueOnce(new Error("private indexeddb failure detail"))
      .mockResolvedValueOnce(undefined);
    const quiesce = vi.fn(async () => undefined);
    const reloadApplication = vi.fn();
    const channel = createChannelHarness();
    const queryClient = createQueryClient();

    renderHook(() =>
      useAccountDeletionAdvisory({
        queryClient,
        sessionQueryKey,
        autoSaveScopes: createAutoSaveScopes(quiesce),
        suspendInteractionAndInvalidateLease: vi.fn(),
        onUnboundAccountDeletionAdvisory: vi.fn(),
        reloadApplication,
        factory: () => channel.channel,
      }),
    );

    act(() => {
      channel.dispatch({ version: 1, deletedUserId: session.user.id });
    });
    await waitFor(() => expect(clearUserDraftsMock).toHaveBeenCalledOnce());
    expect(reloadApplication).not.toHaveBeenCalled();

    act(() => {
      channel.dispatch({ version: 1, deletedUserId: session.user.id });
    });
    await waitFor(() => expect(clearUserDraftsMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(reloadApplication).toHaveBeenCalledOnce());
    expect(quiesce).toHaveBeenCalledTimes(2);
  });

  it("retries when sender confirmation arrives before an in-flight clear fails", async () => {
    let rejectFirstClear!: (reason: unknown) => void;
    const firstClear = new Promise<void>((_resolve, reject) => {
      rejectFirstClear = reject;
    });
    clearUserDraftsMock
      .mockReturnValueOnce(firstClear)
      .mockResolvedValueOnce(undefined);
    const quiesce = vi.fn(async () => undefined);
    const reloadApplication = vi.fn();
    const channel = createChannelHarness();
    const queryClient = createQueryClient();

    renderHook(() =>
      useAccountDeletionAdvisory({
        queryClient,
        sessionQueryKey,
        autoSaveScopes: createAutoSaveScopes(quiesce),
        suspendInteractionAndInvalidateLease: vi.fn(),
        onUnboundAccountDeletionAdvisory: vi.fn(),
        reloadApplication,
        factory: () => channel.channel,
      }),
    );

    act(() => {
      channel.dispatch({ version: 1, deletedUserId: session.user.id });
    });
    await waitFor(() => expect(clearUserDraftsMock).toHaveBeenCalledOnce());

    act(() => {
      channel.dispatch({ version: 1, deletedUserId: session.user.id });
    });
    expect(clearUserDraftsMock).toHaveBeenCalledOnce();
    expect(reloadApplication).not.toHaveBeenCalled();

    act(() => {
      rejectFirstClear(new Error("private indexeddb failure detail"));
    });

    await waitFor(() => expect(clearUserDraftsMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(reloadApplication).toHaveBeenCalledOnce());
    expect(quiesce).toHaveBeenCalledTimes(2);
  });

  it("keeps a completed clear authoritative after the hook unmounts", async () => {
    const clearGate = deferredVoid();
    clearUserDraftsMock.mockReturnValue(clearGate.promise);
    const reloadApplication = vi.fn();
    const channel = createChannelHarness();
    const queryClient = createQueryClient();
    const rendered = renderHook(() =>
      useAccountDeletionAdvisory({
        queryClient,
        sessionQueryKey,
        autoSaveScopes: createAutoSaveScopes(vi.fn(async () => undefined)),
        suspendInteractionAndInvalidateLease: vi.fn(),
        onUnboundAccountDeletionAdvisory: vi.fn(),
        reloadApplication,
        factory: () => channel.channel,
      }),
    );

    act(() => {
      channel.dispatch({ version: 1, deletedUserId: session.user.id });
    });
    await waitFor(() => expect(clearUserDraftsMock).toHaveBeenCalledOnce());
    rendered.unmount();
    clearGate.resolve();
    await clearGate.promise;
    await Promise.resolve();

    expect(reloadApplication).not.toHaveBeenCalled();
    expect(channel.removeEventListener).toHaveBeenCalledOnce();
    expect(channel.close).toHaveBeenCalledOnce();
  });

  it("closes every StrictMode subscription exactly once", () => {
    const channels: ReturnType<typeof createChannelHarness>[] = [];
    const factory: AccountDeletionAdvisoryFactory = () => {
      const channel = createChannelHarness();
      channels.push(channel);
      return channel.channel;
    };
    const queryClient = createQueryClient();
    const rendered = renderHook(
      () =>
        useAccountDeletionAdvisory({
          queryClient,
          sessionQueryKey,
          autoSaveScopes: createAutoSaveScopes(vi.fn(async () => undefined)),
          suspendInteractionAndInvalidateLease: vi.fn(),
          onUnboundAccountDeletionAdvisory: vi.fn(),
          reloadApplication: vi.fn(),
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

function createQueryClient(): QueryClient {
  const queryClient = new QueryClient();
  queryClient.setQueryData(sessionQueryKey, session);
  return queryClient;
}

function createAutoSaveScopes(
  quiesce: AutoSaveScopeRegistry["quiesce"],
): AutoSaveScopeRegistry {
  return {
    prepare: () => {
      throw new Error("not used by advisory tests");
    },
    quiesce,
  };
}

function createChannelHarness() {
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
    postMessage: vi.fn(),
    addEventListener,
    removeEventListener,
    close,
  };
  return {
    channel,
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

function deferredVoid() {
  let resolve!: () => void;
  const promise = new Promise<void>((promiseResolve) => {
    resolve = () => promiseResolve(undefined);
  });
  return { promise, resolve };
}
