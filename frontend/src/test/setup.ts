import "@testing-library/jest-dom/vitest";
import "fake-indexeddb/auto";

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
