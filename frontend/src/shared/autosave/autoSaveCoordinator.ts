import { APIError } from "../api/client";
import {
  autoSaveDebounceMs,
  autoSaveRetryDelay,
  browserDraftDebounceMs,
  isRetryableAutoSaveError,
  maxAutoSaveRetries,
} from "../hooks/autoSavePolicy";

export type AutoSaveState =
  | { readonly kind: "saved" }
  | { readonly kind: "dirty" }
  | { readonly kind: "saving" }
  | { readonly kind: "failed"; readonly errorCode: string };

export type AutoSaveEntry<TKey, TValue> = {
  readonly key: TKey;
  readonly value: TValue;
};

export type AutoSaveErrorDecision = "handled" | "unhandled";

export type AutoSaveCoordinatorOptions<TKey, TValue, TResult> = {
  readonly initialValues: ReadonlyMap<TKey, TValue>;
  readonly save: (
    entry: AutoSaveEntry<TKey, TValue>,
    signal: AbortSignal,
  ) => Promise<TResult>;
  readonly savedValue: (result: TResult) => TValue;
  readonly onSaved?: (
    entry: AutoSaveEntry<TKey, TValue>,
    result: TResult,
  ) => void | Promise<void>;
  readonly onError?: (
    error: unknown,
    entry: AutoSaveEntry<TKey, TValue>,
    signal: AbortSignal,
  ) => AutoSaveErrorDecision | Promise<AutoSaveErrorDecision>;
  readonly persist?: (key: TKey, value: TValue) => void | Promise<void>;
  readonly clearPersisted?: (key: TKey, value: TValue) => void | Promise<void>;
  readonly onPersistenceStatus?: (available: boolean) => void;
  readonly errorCode?: (error: unknown) => string;
  readonly equals?: (left: TValue, right: TValue) => boolean;
  readonly signal?: AbortSignal;
  readonly initiallyHydrating?: boolean;
  readonly isCurrent?: () => boolean;
  readonly now?: () => number;
  readonly random?: () => number;
};

type InFlight<TKey, TValue> = {
  readonly entry: AutoSaveEntry<TKey, TValue>;
  readonly controller: AbortController;
  readonly unlink: () => void;
  recoverAfterAbort: boolean;
};

const savedState: AutoSaveState = { kind: "saved" };
const dirtyState: AutoSaveState = { kind: "dirty" };
const savingState: AutoSaveState = { kind: "saving" };

export class AutoSaveCoordinator<TKey, TValue, TResult> {
  private readonly savedValues: Map<TKey, TValue>;
  private readonly currentValues: Map<TKey, TValue>;
  private readonly queuedValues = new Map<TKey, TValue>();
  private readonly blockedKeys = new Map<TKey, string>();
  private readonly uncertainKeys = new Set<TKey>();
  private readonly preservationDirtyKeys = new Set<TKey>();
  private readonly listeners = new Set<() => void>();
  private readonly options: AutoSaveCoordinatorOptions<TKey, TValue, TResult>;
  private state: AutoSaveState = savedState;
  private inFlight: InFlight<TKey, TValue> | undefined;
  private handlingError = false;
  private hydrating: boolean;
  private saveImmediatelyAfterHydration = false;
  private paused = false;
  private detached = false;
  private persistenceEnabled = true;
  private halted:
    | {
        readonly key: TKey | undefined;
        readonly errorCode: string;
        readonly retryable: boolean;
      }
    | undefined;
  private retryWaiting = false;
  private retryCount = 0;
  private retryKey: TKey | undefined;
  private readonly inputVersions = new Map<TKey, number>();
  private readonly lastInputAt = new Map<TKey, number>();
  private saveTimer: number | undefined;
  private readonly persistenceTimers = new Map<TKey, number>();

  constructor(options: AutoSaveCoordinatorOptions<TKey, TValue, TResult>) {
    this.options = options;
    this.savedValues = new Map(options.initialValues);
    this.currentValues = new Map(options.initialValues);
    this.hydrating = options.initiallyHydrating ?? false;
    for (const key of options.initialValues.keys())
      this.inputVersions.set(key, 0);
    if (this.hydrating) this.state = savingState;
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getState = (): AutoSaveState => this.state;

  getCurrentValue(key: TKey): TValue | undefined {
    return this.currentValues.get(key);
  }

  getSavedValue(key: TKey): TValue | undefined {
    return this.savedValues.get(key);
  }

  isHydrating(): boolean {
    return this.hydrating;
  }

  hasPending(): boolean {
    return (
      this.hydrating ||
      this.inFlight !== undefined ||
      this.handlingError ||
      this.queuedValues.size > 0
    );
  }

  isBlocked(key: TKey): boolean {
    return this.blockedKeys.has(key);
  }

  edit(key: TKey, value: TValue): void {
    if (this.paused || !this.isUsable()) return;
    const activeFailureKey = this.retryKey ?? this.halted?.key;
    const resumesFailure =
      this.inFlight?.entry.key === key || activeFailureKey === key;
    if (resumesFailure) {
      this.retryCount = 0;
      this.retryWaiting = false;
      this.halted = undefined;
      this.retryKey = activeFailureKey ?? key;
    }
    this.currentValues.set(key, value);
    this.inputVersions.set(key, (this.inputVersions.get(key) ?? 0) + 1);
    this.lastInputAt.set(key, this.now());
    this.reconcileKey(key);
    this.schedulePersistence(key);
    this.refreshState();
    if (!this.retryWaiting) this.scheduleSave(autoSaveDebounceMs);
  }

  rebase(key: TKey, savedValue: TValue): void {
    this.savedValues.set(key, savedValue);
    this.uncertainKeys.delete(key);
    this.preservationDirtyKeys.delete(key);
    if (!this.currentValues.has(key)) this.currentValues.set(key, savedValue);
    this.reconcileKey(key);
    this.schedulePersistence(key);
    this.refreshState();
  }

  synchronize(key: TKey, value: TValue): void {
    this.savedValues.set(key, value);
    this.uncertainKeys.delete(key);
    this.preservationDirtyKeys.delete(key);
    this.currentValues.set(key, value);
    this.queuedValues.delete(key);
    this.blockedKeys.delete(key);
    if (this.retryKey === key || this.halted?.key === key) {
      this.clearSaveTimer();
      this.halted = undefined;
      this.retryKey = undefined;
      this.retryCount = 0;
      this.retryWaiting = false;
    }
    this.schedulePersistence(key);
    this.refreshState();
  }

  block(key: TKey, value: TValue, errorCode: string): void {
    this.currentValues.set(key, value);
    this.queuedValues.set(key, value);
    this.blockedKeys.set(key, errorCode);
    if (this.retryKey === key || this.halted?.key === key) {
      this.clearSaveTimer();
      this.halted = undefined;
      this.retryKey = undefined;
      this.retryCount = 0;
    }
    this.retryWaiting = false;
    this.schedulePersistence(key);
    this.refreshState();
  }

  unblock(key: TKey): void {
    this.blockedKeys.delete(key);
    if (this.retryKey === key || this.halted?.key === key) {
      this.halted = undefined;
      this.retryKey = undefined;
      this.retryCount = 0;
      this.retryWaiting = false;
    }
    this.reconcileKey(key);
    this.schedulePersistence(key);
    this.refreshState();
    this.scheduleSave(0);
  }

  fail(errorCode: string, retryable = false): void {
    this.halted = { key: undefined, errorCode, retryable };
    this.retryKey = undefined;
    this.retryCount = 0;
    this.retryWaiting = false;
    this.clearSaveTimer();
    this.refreshState();
  }

  flush(key?: TKey): void {
    if (!this.isUsable()) return;
    if (key === undefined) {
      for (const candidate of this.currentValues.keys())
        void this.persistCurrent(candidate);
    } else {
      void this.persistCurrent(key);
    }
    if (this.paused || this.halted) return;
    if (this.hydrating && this.hasSavableQueuedValue())
      this.saveImmediatelyAfterHydration = true;
    this.scheduleSave(0);
  }

  retry(): void {
    if (
      this.paused ||
      this.blockedKeys.size > 0 ||
      !this.hasSavableQueuedValue()
    )
      return;
    this.halted = undefined;
    this.retryWaiting = false;
    this.retryCount = 0;
    this.refreshState();
    this.scheduleSave(0);
  }

  online(): void {
    if (
      this.paused ||
      this.blockedKeys.size > 0 ||
      (!this.retryWaiting && !this.halted?.retryable)
    )
      return;
    this.halted = undefined;
    this.retryWaiting = false;
    this.retryCount = 0;
    this.refreshState();
    this.scheduleSave(0);
  }

  pause(abortInFlight = false): void {
    this.paused = true;
    this.clearSaveTimer();
    if (abortInFlight && this.inFlight) {
      this.inFlight.recoverAfterAbort = true;
      this.inFlight.controller.abort();
    }
    this.refreshState();
  }

  resume(): void {
    if (!this.isUsable()) return;
    this.paused = false;
    this.retryCount = 0;
    this.retryWaiting = false;
    this.refreshState();
    this.scheduleSave(0);
  }

  async discard(): Promise<void> {
    this.paused = true;
    this.persistenceEnabled = false;
    this.clearSaveTimer();
    this.clearPersistenceTimers();
    if (this.inFlight) {
      this.inFlight.recoverAfterAbort = false;
      this.inFlight.controller.abort();
    }
    this.saveImmediatelyAfterHydration = false;
    this.queuedValues.clear();
    this.blockedKeys.clear();
    this.uncertainKeys.clear();
    this.preservationDirtyKeys.clear();
    this.halted = undefined;
    this.hydrating = false;
    this.retryKey = undefined;
    this.retryCount = 0;
    this.retryWaiting = false;
    await this.clearAllPersisted();
    this.refreshState();
  }

  setPersistenceEnabled(enabled: boolean): void {
    this.persistenceEnabled = enabled;
    if (!enabled) this.clearPersistenceTimers();
  }

  attach(): void {
    this.detached = false;
  }

  finishHydration(): void {
    if (!this.hydrating) return;
    const saveImmediately = this.saveImmediatelyAfterHydration;
    this.saveImmediatelyAfterHydration = false;
    this.hydrating = false;
    this.refreshState();
    if (this.paused || this.halted || !this.hasSavableQueuedValue()) return;
    if (saveImmediately) {
      this.scheduleSave(0);
      return;
    }
    let latestInputAt: number | undefined;
    for (const key of this.queuedValues.keys()) {
      const inputAt = this.lastInputAt.get(key);
      if (
        inputAt !== undefined &&
        (latestInputAt === undefined || inputAt > latestInputAt)
      )
        latestInputAt = inputAt;
    }
    const elapsed =
      latestInputAt === undefined
        ? autoSaveDebounceMs
        : this.now() - latestInputAt;
    this.scheduleSave(Math.max(0, autoSaveDebounceMs - elapsed));
  }

  detach(): void {
    if (this.hydrating && this.hasSavableQueuedValue())
      this.saveImmediatelyAfterHydration = true;
    this.detached = true;
    if (!this.retryWaiting) this.clearSaveTimer();
    this.clearPersistenceTimers();
    void this.persistAll();
    if (!this.paused && !this.halted && !this.retryWaiting) void this.pump();
  }

  async quiesce(preserveDrafts: boolean): Promise<void> {
    this.paused = true;
    this.detached = true;
    this.clearSaveTimer();
    this.clearPersistenceTimers();
    if (this.inFlight) {
      this.inFlight.recoverAfterAbort = false;
      this.inFlight.controller.abort();
    }
    this.saveImmediatelyAfterHydration = false;
    if (preserveDrafts) {
      await this.persistAll(true);
    } else {
      this.persistenceEnabled = false;
      this.preservationDirtyKeys.clear();
      await this.clearAllPersisted();
    }
  }

  private reconcileKey(key: TKey): void {
    const current = this.currentValues.get(key);
    const saved = this.savedValues.get(key);
    if (current === undefined || saved === undefined) return;
    if (this.inFlight?.entry.key === key) {
      if (this.equals(current, this.inFlight.entry.value))
        this.queuedValues.delete(key);
      else this.queuedValues.set(key, current);
      return;
    }
    if (this.equals(current, saved) && !this.uncertainKeys.has(key))
      this.queuedValues.delete(key);
    else this.queuedValues.set(key, current);
  }

  private hasSavableQueuedValue(): boolean {
    for (const key of this.queuedValues.keys()) {
      if (!this.blockedKeys.has(key)) return true;
    }
    return false;
  }

  private firstSavableEntry(): AutoSaveEntry<TKey, TValue> | undefined {
    if (this.retryKey !== undefined && !this.blockedKeys.has(this.retryKey)) {
      const value = this.queuedValues.get(this.retryKey);
      if (value !== undefined) return { key: this.retryKey, value };
    }
    for (const [key, value] of this.queuedValues) {
      if (!this.blockedKeys.has(key)) return { key, value };
    }
    return undefined;
  }

  private scheduleSave(delay: number): void {
    if (this.retryWaiting && this.saveTimer !== undefined) return;
    this.clearSaveTimer();
    if (
      this.hydrating ||
      this.paused ||
      this.halted ||
      this.inFlight ||
      this.handlingError ||
      !this.isUsable() ||
      !this.hasSavableQueuedValue()
    )
      return;
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = undefined;
      void this.pump();
    }, delay);
  }

  private clearSaveTimer(): void {
    if (this.saveTimer === undefined) return;
    window.clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
  }

  private schedulePersistence(key: TKey): void {
    const existing = this.persistenceTimers.get(key);
    if (existing !== undefined) window.clearTimeout(existing);
    if (!this.persistenceEnabled) {
      this.persistenceTimers.delete(key);
      return;
    }
    const timer = window.setTimeout(() => {
      this.persistenceTimers.delete(key);
      void this.persistCurrent(key);
    }, browserDraftDebounceMs);
    this.persistenceTimers.set(key, timer);
  }

  private clearPersistenceTimers(): void {
    for (const timer of this.persistenceTimers.values())
      window.clearTimeout(timer);
    this.persistenceTimers.clear();
  }

  private isKeySettled(key: TKey): boolean {
    if (
      this.blockedKeys.has(key) ||
      this.queuedValues.has(key) ||
      this.preservationDirtyKeys.has(key)
    )
      return false;
    return this.inFlight?.entry.key !== key;
  }

  private persistCurrent(key: TKey, force = false): Promise<void> {
    if (!this.persistenceEnabled || (!force && !this.isUsable()))
      return Promise.resolve();
    const current = this.currentValues.get(key);
    if (current === undefined) return Promise.resolve();
    return this.isKeySettled(key)
      ? this.runPersistence(() => this.options.clearPersisted?.(key, current))
      : this.runPersistence(() => this.options.persist?.(key, current));
  }

  private persistAll(force = false): Promise<void> {
    return Promise.all(
      Array.from(this.currentValues.keys(), (key) =>
        this.persistCurrent(key, force),
      ),
    ).then(() => undefined);
  }

  private clearAllPersisted(): Promise<void> {
    return Promise.all(
      Array.from(this.currentValues, ([key, value]) =>
        this.runPersistence(() => this.options.clearPersisted?.(key, value)),
      ),
    ).then(() => undefined);
  }

  private async runPersistence(
    operation: () => void | Promise<void> | undefined,
  ): Promise<void> {
    try {
      await operation();
      this.options.onPersistenceStatus?.(true);
    } catch {
      this.options.onPersistenceStatus?.(false);
    }
  }

  private async pump(): Promise<void> {
    if (
      this.hydrating ||
      this.inFlight ||
      this.handlingError ||
      this.paused ||
      this.halted ||
      !this.isUsable()
    )
      return;
    const entry = this.firstSavableEntry();
    if (!entry) {
      this.refreshState();
      return;
    }

    const snapshotInputVersion = this.inputVersions.get(entry.key) ?? 0;
    this.queuedValues.delete(entry.key);
    const linked = linkedController(this.options.signal);
    const attempt: InFlight<TKey, TValue> = {
      entry,
      controller: linked.controller,
      unlink: linked.unlink,
      recoverAfterAbort: false,
    };
    this.inFlight = attempt;
    this.retryKey = entry.key;
    this.refreshState();

    let result!: TResult;
    let succeeded = false;
    let failure: unknown;
    let handled = false;
    let invalidated = false;
    try {
      result = await this.options.save(entry, linked.controller.signal);
      if (!this.isAttemptCurrent(linked.controller.signal)) {
        invalidated = true;
      } else {
        const canonical = this.options.savedValue(result);
        this.savedValues.set(entry.key, canonical);
        this.uncertainKeys.delete(entry.key);
        this.preservationDirtyKeys.delete(entry.key);
        const current = this.currentValues.get(entry.key);
        if (current !== undefined && this.equals(current, entry.value))
          this.currentValues.set(entry.key, canonical);
        await this.options.onSaved?.(entry, result);
        invalidated = !this.isAttemptCurrent(linked.controller.signal);
      }
      if (!invalidated) {
        this.retryCount = 0;
        this.retryWaiting = false;
        this.retryKey = undefined;
        this.halted = undefined;
        succeeded = true;
      }
    } catch (error) {
      failure = error;
      if (!this.isAttemptCurrent(linked.controller.signal)) {
        invalidated = true;
      } else if (this.options.onError) {
        this.handlingError = true;
        try {
          handled =
            (await this.options.onError(
              error,
              entry,
              linked.controller.signal,
            )) === "handled";
        } catch (handlerError) {
          failure = handlerError;
          handled = false;
        } finally {
          this.handlingError = false;
        }
        if (!handled && !this.isAttemptCurrent(linked.controller.signal))
          invalidated = true;
      }
    } finally {
      this.inFlight = undefined;
      linked.unlink();
    }

    if (invalidated) {
      const preserve = this.persistenceEnabled;
      if (preserve) this.preservationDirtyKeys.add(entry.key);
      const recover = attempt.recoverAfterAbort && preserve && this.isUsable();
      if (recover) {
        const current = this.currentValues.get(entry.key) ?? entry.value;
        this.queuedValues.set(entry.key, current);
        this.uncertainKeys.add(entry.key);
        await this.persistCurrent(entry.key);
      }
      this.refreshState();
      if (
        recover &&
        !this.paused &&
        !this.halted &&
        this.hasSavableQueuedValue()
      )
        this.scheduleSave(0);
      return;
    }

    if (!this.isUsable()) return;

    if (succeeded) {
      this.reconcileKey(entry.key);
      await this.persistCurrent(entry.key);
      this.refreshState();
      if (this.hasSavableQueuedValue()) this.scheduleSave(0);
      return;
    }

    if (handled) {
      this.retryCount = 0;
      this.retryWaiting = false;
      this.retryKey = undefined;
      this.refreshState();
      if (!this.paused && !this.halted && this.hasSavableQueuedValue())
        this.scheduleSave(0);
      return;
    }

    const current = this.currentValues.get(entry.key) ?? entry.value;
    this.queuedValues.set(entry.key, current);
    if (this.mayHaveCommitted(failure)) this.uncertainKeys.add(entry.key);
    await this.persistCurrent(entry.key);

    if (linked.controller.signal.aborted) {
      this.refreshState();
      return;
    }

    const currentInputVersion = this.inputVersions.get(entry.key) ?? 0;
    if (currentInputVersion !== snapshotInputVersion) {
      this.retryCount = 0;
      this.retryWaiting = false;
      this.retryKey = entry.key;
      this.refreshState();
      const inputAt = this.lastInputAt.get(entry.key) ?? this.now();
      const elapsed = this.now() - inputAt;
      this.scheduleSave(Math.max(0, autoSaveDebounceMs - elapsed));
      return;
    }

    const retryable = isRetryableAutoSaveError(failure);
    if (retryable && this.retryCount < maxAutoSaveRetries) {
      this.retryCount += 1;
      this.retryWaiting = true;
      this.retryKey = entry.key;
      this.refreshState();
      this.scheduleSave(
        autoSaveRetryDelay(this.retryCount, this.options.random),
      );
      return;
    }

    this.halted = {
      key: entry.key,
      errorCode: this.errorCode(failure),
      retryable,
    };
    this.retryKey = entry.key;
    this.retryWaiting = false;
    this.refreshState();
  }

  private isAttemptCurrent(signal: AbortSignal): boolean {
    return !signal.aborted && this.isUsable();
  }

  private isUsable(): boolean {
    return (
      this.options.signal?.aborted !== true &&
      (this.options.isCurrent?.() ?? true)
    );
  }

  private refreshState(): void {
    let next: AutoSaveState;
    const blockedError = this.blockedKeys.values().next().value as
      | string
      | undefined;
    if (this.hydrating) {
      next = savingState;
    } else if (blockedError !== undefined) {
      next = { kind: "failed", errorCode: blockedError };
    } else if (this.halted) {
      next = { kind: "failed", errorCode: this.halted.errorCode };
    } else if (this.inFlight || this.handlingError) {
      next = savingState;
    } else if (this.queuedValues.size > 0) {
      next = dirtyState;
    } else {
      next = savedState;
    }
    if (
      this.state.kind === next.kind &&
      (next.kind !== "failed" ||
        (this.state.kind === "failed" &&
          this.state.errorCode === next.errorCode))
    )
      return;
    this.state = next;
    if (!this.detached) {
      for (const listener of this.listeners) listener();
    }
  }

  private mayHaveCommitted(error: unknown): boolean {
    if (!(error instanceof APIError)) return true;
    return error.status === 408 || error.status === 429 || error.status >= 500;
  }

  private errorCode(error: unknown): string {
    if (this.options.errorCode) return this.options.errorCode(error);
    if (error instanceof APIError) return error.code;
    if (error instanceof TypeError) return "NETWORK_ERROR";
    return "AUTOSAVE_FAILED";
  }

  private equals(left: TValue, right: TValue): boolean {
    return this.options.equals?.(left, right) ?? Object.is(left, right);
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}

function linkedController(parent: AbortSignal | undefined): {
  readonly controller: AbortController;
  readonly unlink: () => void;
} {
  const controller = new AbortController();
  if (!parent) return { controller, unlink: () => undefined };
  const abort = () => controller.abort(parent.reason);
  if (parent.aborted) abort();
  else parent.addEventListener("abort", abort, { once: true });
  return {
    controller,
    unlink: () => parent.removeEventListener("abort", abort),
  };
}
