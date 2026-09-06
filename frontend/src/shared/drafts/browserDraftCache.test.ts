import {
  cleanupExpiredBrowserDrafts,
  clearGoalDrafts,
  clearUserDrafts,
  deleteBrowserDraftIfUnchanged,
  getBrowserDraft,
  putBrowserDraft,
} from "./browserDraftCache";

describe("browser draft cache", () => {
  it.each([
    { transactionOrder: "put-before-clear", putAfterClear: false },
    { transactionOrder: "clear-before-put", putAfterClear: true },
  ])(
    "does not resurrect a deleted account draft when transactions run $transactionOrder",
    async ({ putAfterClear }) => {
      const deletedUserId = putAfterClear
        ? "00000000-0000-7000-8000-000000000011"
        : "00000000-0000-7000-8000-000000000012";
      const otherUserId = putAfterClear
        ? "00000000-0000-7000-8000-000000000013"
        : "00000000-0000-7000-8000-000000000014";
      const deletedDraft = {
        userId: deletedUserId,
        goalId: "deleted-goal",
        subjectKey: "cycle:deleted-cycle:plan",
        body: "content owned by the deleted account",
        baseRevision: 0,
        updatedAt: new Date().toISOString(),
      } as const;
      const otherDraft = {
        userId: otherUserId,
        goalId: "other-goal",
        subjectKey: "cycle:other-cycle:plan",
        body: "content owned by another account",
        baseRevision: 1,
        updatedAt: new Date().toISOString(),
      } as const;

      await putBrowserDraft(otherDraft);
      if (!putAfterClear) await putBrowserDraft(deletedDraft);
      await clearUserDrafts(deletedUserId);
      if (putAfterClear) await putBrowserDraft(deletedDraft);

      expect(
        await getBrowserDraft(deletedUserId, deletedDraft.subjectKey),
      ).toBeNull();
      expect(await getBrowserDraft(otherUserId, otherDraft.subjectKey)).toEqual(
        otherDraft,
      );
    },
  );

  it("stores account-deletion privacy records without raw identity or draft content", async () => {
    const deletedUserId = "00000000-0000-7000-8000-000000000015";
    const deletedBody = "private deleted account body marker";
    await putBrowserDraft({
      userId: deletedUserId,
      goalId: "privacy-goal",
      subjectKey: "cycle:privacy-cycle:plan",
      body: deletedBody,
      baseRevision: 0,
      updatedAt: new Date().toISOString(),
    });

    await clearUserDrafts(deletedUserId);

    const privacyRecords = await readAccountDeletionPrivacyRecords();
    expect(privacyRecords.tombstones.length).toBeGreaterThan(0);
    for (const tombstone of privacyRecords.tombstones) {
      expect(Object.keys(tombstone)).toEqual(["digest"]);
      expect(tombstone.digest).toMatch(/^[0-9a-f]{64}$/u);
    }
    expect(privacyRecords.metadata).toEqual([
      {
        key: "account-deletion-salt-v1",
        value: expect.stringMatching(/^[0-9a-f]{64}$/u),
      },
    ]);
    const serialized = JSON.stringify(privacyRecords);
    expect(serialized).not.toContain(deletedUserId);
    expect(serialized).not.toContain(deletedBody);
  });

  it("isolates records by user and subject key", async () => {
    await putBrowserDraft({
      userId: "u1",
      goalId: "g1",
      subjectKey: "goal:d1",
      body: "one",
      baseRevision: 1,
      updatedAt: new Date().toISOString(),
    });
    await putBrowserDraft({
      userId: "u2",
      goalId: "g1",
      subjectKey: "goal:d1",
      body: "two",
      baseRevision: 2,
      updatedAt: new Date().toISOString(),
    });
    expect((await getBrowserDraft("u1", "goal:d1"))?.body).toBe("one");
    expect((await getBrowserDraft("u2", "goal:d1"))?.body).toBe("two");
    await clearUserDrafts("u1");
    expect(await getBrowserDraft("u1", "goal:d1")).toBeNull();
    expect((await getBrowserDraft("u2", "goal:d1"))?.body).toBe("two");
  });

  it("expires recovery data after 24 hours", async () => {
    await putBrowserDraft({
      userId: "old",
      goalId: "g-old",
      subjectKey: "cycle:c1:plan",
      body: "old",
      baseRevision: 0,
      updatedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
    });
    expect(await getBrowserDraft("old", "cycle:c1:plan")).toBeNull();
  });

  it("expires a recovery record whose updatedAt is invalid", async () => {
    await putBrowserDraft({
      userId: "invalid-read-owner",
      goalId: "invalid-read-goal",
      subjectKey: "cycle:invalid-read-cycle:plan",
      body: "invalid timestamp record",
      baseRevision: 0,
      updatedAt: "not-an-instant",
    });

    expect(
      await getBrowserDraft(
        "invalid-read-owner",
        "cycle:invalid-read-cycle:plan",
      ),
    ).toBeNull();
  });

  it("preserves a fresh write queued after expired-record cleanup starts", async () => {
    const now = Date.parse("2026-09-06T12:00:00.000Z");
    const userId = "expired-cleanup-before-put-owner";
    const subjectKey = "cycle:expired-cleanup-before-put-cycle:plan";
    await putBrowserDraft({
      userId,
      goalId: "expired-cleanup-before-put-goal",
      subjectKey,
      body: "expired content",
      baseRevision: 0,
      updatedAt: new Date(now - 25 * 60 * 60 * 1000).toISOString(),
    });
    const freshDraft = {
      userId,
      goalId: "expired-cleanup-before-put-goal",
      subjectKey,
      body: "fresh concurrent content",
      baseRevision: 1,
      updatedAt: new Date(now).toISOString(),
    } as const;
    const interleaving = queueDraftWriteAfterNextDraftTransaction(freshDraft);
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      const [expiredResult] = await Promise.all([
        getBrowserDraft(userId, subjectKey),
        interleaving.writeCompleted,
      ]);
      expect(expiredResult).toBeNull();
      expect(await getBrowserDraft(userId, subjectKey)).toEqual(freshDraft);
    } finally {
      nowSpy.mockRestore();
      interleaving.restore();
    }
  });

  it("reads a fresh write queued before expired-record cleanup starts", async () => {
    const now = Date.parse("2026-09-06T13:00:00.000Z");
    const userId = "put-before-expired-cleanup-owner";
    const subjectKey = "cycle:put-before-expired-cleanup-cycle:plan";
    await putBrowserDraft({
      userId,
      goalId: "put-before-expired-cleanup-goal",
      subjectKey,
      body: "expired content",
      baseRevision: 0,
      updatedAt: new Date(now - 25 * 60 * 60 * 1000).toISOString(),
    });
    const freshDraft = {
      userId,
      goalId: "put-before-expired-cleanup-goal",
      subjectKey,
      body: "fresh content queued first",
      baseRevision: 1,
      updatedAt: new Date(now).toISOString(),
    } as const;
    const interleaving = queueDraftWriteBeforeNextDraftTransaction(freshDraft);
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      const [draft] = await Promise.all([
        getBrowserDraft(userId, subjectKey),
        interleaving.writeCompleted,
      ]);
      expect(draft).toEqual(freshDraft);
    } finally {
      nowSpy.mockRestore();
      interleaving.restore();
    }
  });

  it("rolls back expired-record deletion on abort and closes the database", async () => {
    const now = Date.parse("2026-09-06T14:00:00.000Z");
    const userId = "expired-cleanup-abort-owner";
    const subjectKey = "cycle:expired-cleanup-abort-cycle:plan";
    const expiredDraft = {
      userId,
      goalId: "expired-cleanup-abort-goal",
      subjectKey,
      body: "content retained after abort",
      baseRevision: 0,
      updatedAt: new Date(now - 25 * 60 * 60 * 1000).toISOString(),
    } as const;
    await putBrowserDraft(expiredDraft);
    const injected = abortNextExpiredDraftDeletion();
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      await expect(getBrowserDraft(userId, subjectKey)).rejects.toThrow(
        "browser draft read transaction aborted",
      );
      expect(injected.abortTriggered).toBe(true);
      expect(injected.closeSpy).toHaveBeenCalledOnce();
    } finally {
      nowSpy.mockRestore();
      injected.restore();
    }

    expect(await readStoredDraft(userId, subjectKey)).toEqual({
      ...expiredDraft,
      key: `${userId}:${subjectKey}`,
    });
  });

  it("rejects an asynchronous delete error after rollback and closes the database", async () => {
    const now = Date.parse("2026-09-06T14:30:00.000Z");
    const userId = "expired-cleanup-request-error-owner";
    const subjectKey = "cycle:expired-cleanup-request-error-cycle:plan";
    const expiredDraft = {
      userId,
      goalId: "expired-cleanup-request-error-goal",
      subjectKey,
      body: "content retained after request error",
      baseRevision: 0,
      updatedAt: new Date(now - 25 * 60 * 60 * 1000).toISOString(),
    } as const;
    await putBrowserDraft(expiredDraft);
    const injected = failNextExpiredDraftDeletion(expiredDraft);
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      await expect(getBrowserDraft(userId, subjectKey)).rejects.toMatchObject({
        name: "ConstraintError",
      });
      expect(injected.closeSpy).toHaveBeenCalledOnce();
    } finally {
      nowSpy.mockRestore();
      injected.restore();
    }

    expect(await readStoredDraft(userId, subjectKey)).toEqual({
      ...expiredDraft,
      key: `${userId}:${subjectKey}`,
    });
  });

  it("rejects transaction creation errors and closes the database", async () => {
    const injected = failNextDraftTransaction();
    try {
      await expect(
        getBrowserDraft("transaction-error-owner", "goal:transaction-error"),
      ).rejects.toThrow("injected transaction failure");
      expect(injected.closeSpy).toHaveBeenCalledOnce();
    } finally {
      injected.restore();
    }
  });

  it("clears only records owned by one goal", async () => {
    await putBrowserDraft({
      userId: "goal-owner",
      goalId: "g1",
      subjectKey: "cycle:c1:plan",
      body: "first",
      baseRevision: 0,
      updatedAt: new Date().toISOString(),
    });
    await putBrowserDraft({
      userId: "goal-owner",
      goalId: "g2",
      subjectKey: "cycle:c2:plan",
      body: "second",
      baseRevision: 0,
      updatedAt: new Date().toISOString(),
    });

    await clearGoalDrafts("goal-owner", "g1");

    expect(await getBrowserDraft("goal-owner", "cycle:c1:plan")).toBeNull();
    expect((await getBrowserDraft("goal-owner", "cycle:c2:plan"))?.body).toBe(
      "second",
    );
  });

  it("preserves a newer recovery record when an old save finishes late", async () => {
    const userId = "conditional-owner";
    const subjectKey = "cycle:conditional-cycle:plan";
    const oldBody = "old in-flight value";
    const newerBody = "😀".repeat(201) + "\r\nnewer recovery";
    const oldUpdatedAt = new Date().toISOString();
    const newerUpdatedAt = new Date(Date.now() + 1).toISOString();
    await putBrowserDraft({
      userId,
      goalId: "conditional-goal",
      subjectKey,
      body: oldBody,
      baseRevision: 0,
      updatedAt: oldUpdatedAt,
    });
    await putBrowserDraft({
      userId,
      goalId: "conditional-goal",
      subjectKey,
      body: newerBody,
      baseRevision: 1,
      updatedAt: newerUpdatedAt,
    });

    await deleteBrowserDraftIfUnchanged(userId, subjectKey, oldBody, 0);

    expect(await getBrowserDraft(userId, subjectKey)).toEqual({
      userId,
      goalId: "conditional-goal",
      subjectKey,
      body: newerBody,
      baseRevision: 1,
      updatedAt: newerUpdatedAt,
    });

    await deleteBrowserDraftIfUnchanged(userId, subjectKey, newerBody, 0);
    expect((await getBrowserDraft(userId, subjectKey))?.body).toBe(newerBody);

    await deleteBrowserDraftIfUnchanged(userId, subjectKey, oldBody, 1);
    expect((await getBrowserDraft(userId, subjectKey))?.baseRevision).toBe(1);

    await deleteBrowserDraftIfUnchanged(userId, subjectKey, newerBody, 1);
    expect(await getBrowserDraft(userId, subjectKey)).toBeNull();

    await putBrowserDraft({
      userId,
      goalId: "conditional-goal",
      subjectKey,
      body: oldBody,
      baseRevision: 1,
      updatedAt: oldUpdatedAt,
    });
    const concurrentBody = newerBody + "\nconcurrent";
    const concurrentUpdatedAt = new Date(Date.now() + 2).toISOString();
    await Promise.all([
      deleteBrowserDraftIfUnchanged(userId, subjectKey, oldBody, 1),
      putBrowserDraft({
        userId,
        goalId: "conditional-goal",
        subjectKey,
        body: concurrentBody,
        baseRevision: 2,
        updatedAt: concurrentUpdatedAt,
      }),
    ]);
    expect(await getBrowserDraft(userId, subjectKey)).toEqual({
      userId,
      goalId: "conditional-goal",
      subjectKey,
      body: concurrentBody,
      baseRevision: 2,
      updatedAt: concurrentUpdatedAt,
    });
  });

  it("sweeps every expired record while preserving fresh records for every user", async () => {
    const now = Date.parse("2026-08-23T12:00:00.000Z");
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(now);
    const expiredAt = new Date(now - 25 * 60 * 60 * 1000).toISOString();
    const freshAt = new Date(now - 60 * 60 * 1000).toISOString();
    try {
      await putBrowserDraft({
        userId: "cleanup-owner",
        goalId: "cleanup-goal",
        subjectKey: "cycle:cleanup-cycle:plan",
        body: "expired owner record",
        baseRevision: 0,
        updatedAt: expiredAt,
      });
      await putBrowserDraft({
        userId: "cleanup-other",
        goalId: "cleanup-other-goal",
        subjectKey: "goal-draft:cleanup-other-draft",
        body: "expired other-user record",
        baseRevision: 2,
        updatedAt: expiredAt,
      });
      await putBrowserDraft({
        userId: "cleanup-owner",
        goalId: "cleanup-goal",
        subjectKey: "cycle:cleanup-cycle:do",
        body: "fresh owner record",
        baseRevision: 1,
        updatedAt: freshAt,
      });
      await putBrowserDraft({
        userId: "cleanup-other",
        goalId: null,
        subjectKey: "goal-draft:cleanup-fresh-draft",
        body: "fresh other-user record",
        baseRevision: 3,
        updatedAt: freshAt,
      });

      await cleanupExpiredBrowserDrafts();

      nowSpy.mockReturnValue(now - 48 * 60 * 60 * 1000);
      expect(
        await getBrowserDraft("cleanup-owner", "cycle:cleanup-cycle:plan"),
      ).toBeNull();
      expect(
        await getBrowserDraft(
          "cleanup-other",
          "goal-draft:cleanup-other-draft",
        ),
      ).toBeNull();

      nowSpy.mockReturnValue(now);
      expect(
        (await getBrowserDraft("cleanup-owner", "cycle:cleanup-cycle:do"))
          ?.body,
      ).toBe("fresh owner record");
      expect(
        (
          await getBrowserDraft(
            "cleanup-other",
            "goal-draft:cleanup-fresh-draft",
          )
        )?.body,
      ).toBe("fresh other-user record");
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("sweeps invalid timestamps while preserving a fresh valid record", async () => {
    const now = Date.parse("2026-08-23T12:00:00.000Z");
    const freshAt = new Date(now - 60 * 60 * 1000).toISOString();
    await putBrowserDraft({
      userId: "invalid-cleanup-owner",
      goalId: "invalid-cleanup-goal",
      subjectKey: "cycle:invalid-cleanup-cycle:plan",
      body: "invalid cleanup record",
      baseRevision: 0,
      updatedAt: "invalid-cleanup-instant",
    });
    await putBrowserDraft({
      userId: "invalid-cleanup-owner",
      goalId: "invalid-cleanup-goal",
      subjectKey: "cycle:invalid-cleanup-cycle:do",
      body: "fresh cleanup record",
      baseRevision: 1,
      updatedAt: freshAt,
    });

    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      await cleanupExpiredBrowserDrafts();

      const parseSpy = vi.spyOn(Date, "parse").mockReturnValue(now);
      try {
        expect(
          await getBrowserDraft(
            "invalid-cleanup-owner",
            "cycle:invalid-cleanup-cycle:plan",
          ),
        ).toBeNull();
        expect(
          (
            await getBrowserDraft(
              "invalid-cleanup-owner",
              "cycle:invalid-cleanup-cycle:do",
            )
          )?.body,
        ).toBe("fresh cleanup record");
      } finally {
        parseSpy.mockRestore();
      }
    } finally {
      nowSpy.mockRestore();
    }
  });
});

function readAccountDeletionPrivacyRecords(): Promise<{
  readonly tombstones: readonly Record<string, unknown>[];
  readonly metadata: readonly Record<string, unknown>[];
}> {
  return new Promise((resolve, reject) => {
    const openRequest = indexedDB.open("fukamu-cycle-browser-drafts-v2", 2);
    openRequest.onerror = () => reject(openRequest.error);
    openRequest.onsuccess = () => {
      const database = openRequest.result;
      const transaction = database.transaction([
        "account-deletion-tombstones",
        "metadata",
      ]);
      const tombstonesRequest = transaction
        .objectStore("account-deletion-tombstones")
        .getAll();
      const metadataRequest = transaction.objectStore("metadata").getAll();
      const closeAndReject = () => {
        database.close();
        reject(transaction.error);
      };
      transaction.oncomplete = () => {
        database.close();
        resolve({
          tombstones: tombstonesRequest.result as readonly Record<
            string,
            unknown
          >[],
          metadata: metadataRequest.result as readonly Record<
            string,
            unknown
          >[],
        });
      };
      transaction.onerror = closeAndReject;
      transaction.onabort = closeAndReject;
    };
  });
}

const browserDraftDatabaseName = "fukamu-cycle-browser-drafts-v2";
const browserDraftStoreName = "drafts";

type DraftTransactionInterleaving = {
  readonly writeCompleted: Promise<void>;
  readonly restore: () => void;
};

function queueDraftWriteAfterNextDraftTransaction(
  draft: BrowserDraftFixture,
): DraftTransactionInterleaving {
  return arrangeNextDraftTransaction((originalTransaction, args) => {
    const requested = callTransaction(originalTransaction, args);
    const write = originalTransaction(browserDraftStoreName, "readwrite");
    write.objectStore(browserDraftStoreName).put(storedFixture(draft));
    return { requested, write };
  });
}

function queueDraftWriteBeforeNextDraftTransaction(
  draft: BrowserDraftFixture,
): DraftTransactionInterleaving {
  return arrangeNextDraftTransaction((originalTransaction, args) => {
    const write = originalTransaction(browserDraftStoreName, "readwrite");
    write.objectStore(browserDraftStoreName).put(storedFixture(draft));
    return {
      requested: callTransaction(originalTransaction, args),
      write,
    };
  });
}

type BrowserDraftFixture = {
  readonly userId: string;
  readonly goalId: string | null;
  readonly subjectKey: string;
  readonly body: string;
  readonly baseRevision: number;
  readonly updatedAt: string;
};

type TransactionArguments = Parameters<IDBDatabase["transaction"]>;
type BoundTransaction = (
  storeNames: string | Iterable<string>,
  mode?: IDBTransactionMode,
  options?: IDBTransactionOptions,
) => IDBTransaction;

function arrangeNextDraftTransaction(
  arrange: (
    originalTransaction: BoundTransaction,
    args: TransactionArguments,
  ) => { readonly requested: IDBTransaction; readonly write: IDBTransaction },
): DraftTransactionInterleaving {
  const originalOpen = indexedDB.open.bind(indexedDB);
  const openSpy = vi
    .spyOn(indexedDB, "open")
    .mockImplementation((name, version) =>
      version === undefined ? originalOpen(name) : originalOpen(name, version),
    );
  let resolveWrite!: () => void;
  let rejectWrite!: (reason: unknown) => void;
  const writeCompleted = new Promise<void>((resolve, reject) => {
    resolveWrite = resolve;
    rejectWrite = reject;
  });
  let transactionSpy: ReturnType<typeof vi.spyOn> | undefined;
  let arranged = false;
  openSpy.mockImplementation((name, version) => {
    const request =
      version === undefined ? originalOpen(name) : originalOpen(name, version);
    if (name !== browserDraftDatabaseName) return request;
    request.addEventListener("success", () => {
      const database = request.result;
      const originalTransaction = database.transaction.bind(database);
      transactionSpy = vi.spyOn(database, "transaction");
      transactionSpy.mockImplementation((...args: TransactionArguments) => {
        if (arranged || !includesDraftStore(args[0])) {
          return callTransaction(originalTransaction, args);
        }
        arranged = true;
        const transactions = arrange(originalTransaction, args);
        transactions.write.oncomplete = () => resolveWrite();
        transactions.write.onerror = () =>
          rejectWrite(transactions.write.error);
        transactions.write.onabort = () =>
          rejectWrite(transactions.write.error);
        return transactions.requested;
      });
    });
    return request;
  });
  return {
    writeCompleted,
    restore: () => {
      transactionSpy?.mockRestore();
      openSpy.mockRestore();
    },
  };
}

function abortNextExpiredDraftDeletion(): {
  readonly closeSpy: ReturnType<typeof vi.spyOn>;
  readonly abortTriggered: boolean;
  readonly restore: () => void;
} {
  let abortTriggered = false;
  const injection = interceptNextDraftDatabase((database) => {
    const originalTransaction = database.transaction.bind(database);
    const transactionSpy = vi.spyOn(database, "transaction");
    let intercepted = false;
    transactionSpy.mockImplementation((...args: TransactionArguments) => {
      const transaction = callTransaction(originalTransaction, args);
      if (intercepted || !includesDraftStore(args[0])) return transaction;
      intercepted = true;
      const originalObjectStore = transaction.objectStore.bind(transaction);
      vi.spyOn(transaction, "objectStore").mockImplementation((name) => {
        const store = originalObjectStore(name);
        const originalDelete = store.delete.bind(store);
        vi.spyOn(store, "delete").mockImplementation((query) => {
          const request = originalDelete(query);
          request.addEventListener(
            "success",
            () => {
              abortTriggered = true;
              transaction.abort();
            },
            { once: true },
          );
          return request;
        });
        return store;
      });
      return transaction;
    });
    return transactionSpy;
  });
  return {
    get closeSpy() {
      return injection.closeSpy;
    },
    get abortTriggered() {
      return abortTriggered;
    },
    restore: injection.restore,
  };
}

function failNextExpiredDraftDeletion(draft: BrowserDraftFixture): {
  readonly closeSpy: ReturnType<typeof vi.spyOn>;
  readonly restore: () => void;
} {
  return interceptNextDraftDatabase((database) => {
    const originalTransaction = database.transaction.bind(database);
    const transactionSpy = vi.spyOn(database, "transaction");
    let intercepted = false;
    transactionSpy.mockImplementation((...args: TransactionArguments) => {
      const transaction = callTransaction(originalTransaction, args);
      if (intercepted || !includesDraftStore(args[0])) return transaction;
      intercepted = true;
      const originalObjectStore = transaction.objectStore.bind(transaction);
      vi.spyOn(transaction, "objectStore").mockImplementation((name) => {
        const store = originalObjectStore(name);
        const originalAdd = store.add.bind(store);
        vi.spyOn(store, "delete").mockImplementation(
          () =>
            originalAdd(
              storedFixture(draft),
            ) as unknown as IDBRequest<undefined>,
        );
        return store;
      });
      return transaction;
    });
    return transactionSpy;
  });
}

function failNextDraftTransaction(): {
  readonly closeSpy: ReturnType<typeof vi.spyOn>;
  readonly restore: () => void;
} {
  return interceptNextDraftDatabase((database) =>
    vi.spyOn(database, "transaction").mockImplementation(() => {
      throw new Error("injected transaction failure");
    }),
  );
}

function interceptNextDraftDatabase(
  intercept: (database: IDBDatabase) => { mockRestore: () => void },
): {
  readonly closeSpy: ReturnType<typeof vi.spyOn>;
  readonly restore: () => void;
} {
  const originalOpen = indexedDB.open.bind(indexedDB);
  const openSpy = vi.spyOn(indexedDB, "open");
  let operationSpy: { mockRestore: () => void } | undefined;
  let closeSpy: ReturnType<typeof vi.spyOn> | undefined;
  let openedDatabase: IDBDatabase | undefined;
  openSpy.mockImplementation((name, version) => {
    const request =
      version === undefined ? originalOpen(name) : originalOpen(name, version);
    if (name !== browserDraftDatabaseName) return request;
    request.addEventListener("success", () => {
      openedDatabase = request.result;
      closeSpy = vi.spyOn(request.result, "close");
      operationSpy = intercept(request.result);
    });
    return request;
  });
  return {
    get closeSpy() {
      if (closeSpy === undefined) throw new Error("database did not open");
      return closeSpy;
    },
    restore: () => {
      operationSpy?.mockRestore();
      closeSpy?.mockRestore();
      openedDatabase?.close();
      openSpy.mockRestore();
    },
  };
}

function callTransaction(
  transaction: BoundTransaction,
  args: TransactionArguments,
): IDBTransaction {
  const [storeNames, mode, options] = args;
  if (options !== undefined) return transaction(storeNames, mode, options);
  if (mode !== undefined) return transaction(storeNames, mode);
  return transaction(storeNames);
}

function includesDraftStore(storeNames: string | Iterable<string>): boolean {
  return typeof storeNames === "string"
    ? storeNames === browserDraftStoreName
    : [...storeNames].includes(browserDraftStoreName);
}

function storedFixture(draft: BrowserDraftFixture): BrowserDraftFixture & {
  readonly key: string;
} {
  return { ...draft, key: `${draft.userId}:${draft.subjectKey}` };
}

function readStoredDraft(
  userId: string,
  subjectKey: string,
): Promise<Record<string, unknown> | undefined> {
  return new Promise((resolve, reject) => {
    const openRequest = indexedDB.open(browserDraftDatabaseName, 2);
    openRequest.onerror = () => reject(openRequest.error);
    openRequest.onsuccess = () => {
      const database = openRequest.result;
      const transaction = database.transaction(browserDraftStoreName);
      const request = transaction
        .objectStore(browserDraftStoreName)
        .get(`${userId}:${subjectKey}`);
      transaction.oncomplete = () => {
        database.close();
        resolve(request.result as Record<string, unknown> | undefined);
      };
      const closeAndReject = () => {
        database.close();
        reject(transaction.error);
      };
      transaction.onerror = closeAndReject;
      transaction.onabort = closeAndReject;
    };
  });
}
