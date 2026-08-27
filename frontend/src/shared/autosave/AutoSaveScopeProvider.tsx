import {
  createContext,
  useContext,
  useState,
  type PropsWithChildren,
} from "react";

export type AutoSaveQuiesceOptions = {
  readonly preserveDrafts: boolean;
};

export type AutoSaveBrowserOperationQueue = <T>(
  operation: () => Promise<T>,
) => Promise<T | undefined>;

export type AutoSaveQuiesceLifecycle = AutoSaveQuiesceOptions & {
  readonly queueBrowserOperation: AutoSaveBrowserOperationQueue;
};

export type AutoSaveQuiesceCallback = (
  lifecycle: AutoSaveQuiesceLifecycle,
) => void | Promise<void>;

export type AutoSaveScopeLease = {
  readonly scopeKey: string;
  readonly generation: number;
  readonly signal: AbortSignal;
  readonly activate: () => void;
  readonly isCurrent: () => boolean;
  readonly queueBrowserOperation: AutoSaveBrowserOperationQueue;
  readonly onQuiesce: (callback: AutoSaveQuiesceCallback) => () => void;
};

export type AutoSaveScopeRegistry = {
  readonly prepare: (scopeKey: string) => AutoSaveScopeLease;
  readonly quiesce: (options: AutoSaveQuiesceOptions) => Promise<void>;
};

type ScopeGeneration = {
  generation: number;
  readonly requestController: AbortController;
  readonly quiesceCallbacks: Set<AutoSaveQuiesceCallback>;
  acceptCompletions: boolean;
  browserSchedulingOpen: boolean;
};

type ScopeSlot = {
  nextGeneration: number;
  current: ScopeGeneration | undefined;
  browserOperationTail: Promise<void>;
};

const AutoSaveScopeContext = createContext<AutoSaveScopeRegistry | null>(null);

// eslint-disable-next-line react-refresh/only-export-components -- the provider and its owned registry contract must share one context module
export function createAutoSaveScopeRegistry(): AutoSaveScopeRegistry {
  const scopes = new Map<string, ScopeSlot>();
  let quiesceTail = Promise.resolve();
  let activationEpoch = 0;
  let quiescing = false;

  function getOrCreateSlot(scopeKey: string): ScopeSlot {
    const existing = scopes.get(scopeKey);
    if (existing) return existing;
    const created: ScopeSlot = {
      nextGeneration: 0,
      current: undefined,
      browserOperationTail: Promise.resolve(),
    };
    scopes.set(scopeKey, created);
    return created;
  }

  function enqueueBrowserOperation<T>(
    slot: ScopeSlot,
    operation: () => Promise<T>,
  ): Promise<T> {
    const pending = slot.browserOperationTail.then(operation);
    slot.browserOperationTail = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }

  function prepare(scopeKey: string): AutoSaveScopeLease {
    let slot: ScopeSlot | undefined;
    let activated = false;
    const preparedEpoch = activationEpoch;
    const generation: ScopeGeneration = {
      generation: 0,
      requestController: new AbortController(),
      quiesceCallbacks: new Set(),
      acceptCompletions: true,
      browserSchedulingOpen: true,
    };

    const isGenerationCurrent = () => slot?.current === generation;
    return {
      scopeKey,
      get generation() {
        return generation.generation;
      },
      signal: generation.requestController.signal,
      activate: () => {
        if (activated) return;
        activated = true;
        if (quiescing || preparedEpoch !== activationEpoch) {
          generation.acceptCompletions = false;
          generation.browserSchedulingOpen = false;
          generation.requestController.abort();
          return;
        }
        slot = getOrCreateSlot(scopeKey);
        const previous = slot.current;
        if (previous) {
          previous.acceptCompletions = false;
          previous.browserSchedulingOpen = false;
          previous.quiesceCallbacks.clear();
          previous.requestController.abort();
        }
        generation.generation = slot.nextGeneration + 1;
        slot.nextGeneration = generation.generation;
        slot.current = generation;
      },
      isCurrent: () => isGenerationCurrent() && generation.acceptCompletions,
      queueBrowserOperation: <T,>(
        operation: () => Promise<T>,
      ): Promise<T | undefined> => {
        const activeSlot = slot;
        if (
          !activeSlot ||
          !isGenerationCurrent() ||
          !generation.acceptCompletions ||
          !generation.browserSchedulingOpen
        ) {
          return Promise.resolve(undefined);
        }
        return enqueueBrowserOperation(activeSlot, operation);
      },
      onQuiesce: (callback) => {
        if (!isGenerationCurrent() || !generation.acceptCompletions) {
          return () => undefined;
        }
        generation.quiesceCallbacks.add(callback);
        return () => generation.quiesceCallbacks.delete(callback);
      },
    };
  }

  async function quiesceCurrent(
    options: AutoSaveQuiesceOptions,
  ): Promise<void> {
    quiescing = true;
    activationEpoch += 1;
    const active = [...scopes.values()].flatMap((slot) =>
      slot.current ? [{ slot, generation: slot.current }] : [],
    );

    for (const { generation } of active) {
      generation.acceptCompletions = false;
      generation.requestController.abort();
    }

    const lifecycleResults = active.flatMap(({ slot, generation }) =>
      [...generation.quiesceCallbacks].map((callback) => {
        let lifecycleSchedulingOpen = true;
        const queueBrowserOperation = <T,>(
          operation: () => Promise<T>,
        ): Promise<T | undefined> => {
          if (
            !lifecycleSchedulingOpen ||
            slot.current !== generation ||
            !generation.browserSchedulingOpen
          ) {
            return Promise.resolve(undefined);
          }
          return enqueueBrowserOperation(slot, operation);
        };
        const lifecycle: AutoSaveQuiesceLifecycle = {
          preserveDrafts: options.preserveDrafts,
          queueBrowserOperation,
        };
        return Promise.resolve()
          .then(() => callback(lifecycle))
          .finally(() => {
            lifecycleSchedulingOpen = false;
          });
      }),
    );
    await Promise.allSettled(lifecycleResults);

    for (const { slot, generation } of active) {
      if (slot.current !== generation) continue;
      generation.browserSchedulingOpen = false;
      generation.quiesceCallbacks.clear();
      slot.current = undefined;
    }

    await Promise.allSettled(
      active.map(({ slot }) => slot.browserOperationTail),
    );
    activationEpoch += 1;
    quiescing = false;
  }

  return {
    prepare,
    quiesce: (options) => {
      const pending = quiesceTail.then(() => quiesceCurrent(options));
      quiesceTail = pending.then(
        () => undefined,
        () => undefined,
      );
      return pending;
    },
  };
}

export function AutoSaveScopeProvider({ children }: PropsWithChildren) {
  const [registry] = useState(createAutoSaveScopeRegistry);
  return (
    <AutoSaveScopeContext.Provider value={registry}>
      {children}
    </AutoSaveScopeContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components -- consumers need the hook paired with this provider context
export function useAutoSaveScopeRegistry(): AutoSaveScopeRegistry {
  const registry = useContext(AutoSaveScopeContext);
  if (!registry) {
    throw new Error("AutoSaveScopeProvider is required");
  }
  return registry;
}
