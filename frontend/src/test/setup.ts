import "@testing-library/jest-dom/vitest";
import "fake-indexeddb/auto";

// Node may expose an incomplete global localStorage implementation that Vitest
// copies onto the jsdom window. Keep browser-storage tests deterministic without
// requiring a host-specific --localstorage-file option.
const localStorageValues = new Map<string, string>();
const testLocalStorage: Storage = {
  get length() {
    return localStorageValues.size;
  },
  clear() {
    localStorageValues.clear();
  },
  getItem(key) {
    return localStorageValues.get(key) ?? null;
  },
  key(index) {
    return [...localStorageValues.keys()][index] ?? null;
  },
  removeItem(key) {
    localStorageValues.delete(key);
  },
  setItem(key, value) {
    localStorageValues.set(key, String(value));
  },
};

Object.defineProperty(window, "localStorage", {
  configurable: true,
  value: testLocalStorage,
});

const lockQueues = new Map<string, Promise<void>>();
const testLockManager = {
  request(
    name: string,
    optionsOrCallback: LockOptions | LockGrantedCallback<unknown>,
    callbackArgument?: LockGrantedCallback<unknown>,
  ): Promise<unknown> {
    const options =
      typeof optionsOrCallback === "function" ? {} : optionsOrCallback;
    const callback =
      typeof optionsOrCallback === "function"
        ? optionsOrCallback
        : callbackArgument;
    if (callback === undefined) {
      return Promise.reject(new TypeError("lock callback is required"));
    }

    const previous = lockQueues.get(name) ?? Promise.resolve();
    const result = previous.then(() => {
      options.signal?.throwIfAborted();
      return callback({
        name,
        mode: options.mode ?? "exclusive",
      });
    });
    lockQueues.set(
      name,
      result.then(
        () => undefined,
        () => undefined,
      ),
    );
    return result;
  },
  async query(): Promise<LockManagerSnapshot> {
    return { held: [], pending: [] };
  },
} as LockManager;

Object.defineProperty(window.navigator, "locks", {
  configurable: true,
  value: testLockManager,
});
