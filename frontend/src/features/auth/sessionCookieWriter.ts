const SESSION_COOKIE_WRITER_LOCK = "fukamu-session-cookie-writer-v1";

type SessionCookieWriterOptions = {
  readonly isCurrent: () => boolean;
  readonly signal?: AbortSignal;
};

export class SessionCookieCoordinationError extends Error {
  constructor() {
    super("session cookie coordination is unavailable");
    this.name = "SessionCookieCoordinationError";
  }
}

export async function runSessionCookieWriter<Result>(
  options: SessionCookieWriterOptions,
  operation: () => Promise<Result>,
): Promise<Result | null> {
  options.signal?.throwIfAborted();
  const lockManager = requireLockManager();
  const lockOptions: LockOptions =
    options.signal === undefined
      ? { mode: "exclusive" }
      : { mode: "exclusive", signal: options.signal };
  let callbackStarted = false;
  let result: Result | null;

  try {
    result = await lockManager.request(
      SESSION_COOKIE_WRITER_LOCK,
      lockOptions,
      async () => {
        callbackStarted = true;
        options.signal?.throwIfAborted();
        if (!options.isCurrent()) return null;
        return operation();
      },
    );
  } catch (error) {
    if (!callbackStarted && options.signal?.aborted !== true) {
      throw new SessionCookieCoordinationError();
    }
    throw error;
  }
  if (!callbackStarted) throw new SessionCookieCoordinationError();
  return result;
}

function requireLockManager(): LockManager {
  if (typeof navigator === "undefined") {
    throw new SessionCookieCoordinationError();
  }

  try {
    const lockManager = navigator.locks;
    if (typeof lockManager?.request !== "function") {
      throw new SessionCookieCoordinationError();
    }
    return lockManager;
  } catch (error) {
    if (error instanceof SessionCookieCoordinationError) throw error;
    throw new SessionCookieCoordinationError();
  }
}
