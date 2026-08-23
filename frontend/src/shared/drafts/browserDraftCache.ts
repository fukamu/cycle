const databaseName = "fukamu-cycle-browser-drafts-v2";
const storeName = "drafts";
const ttl = 24 * 60 * 60 * 1000;

export type BrowserDraft = {
  readonly userId: string;
  readonly goalId: string | null;
  readonly subjectKey: string;
  readonly body: string;
  readonly baseRevision: number;
  readonly updatedAt: string;
};
type Stored = BrowserDraft & { readonly key: string };
const keyOf = (draft: Pick<BrowserDraft, "userId" | "subjectKey">) =>
  `${draft.userId}:${draft.subjectKey}`;

export async function putBrowserDraft(draft: BrowserDraft): Promise<void> {
  await withDatabase((db) =>
    mutate(db, (store) => {
      store.put({ ...draft, key: keyOf(draft) } satisfies Stored);
    }),
  );
}
export async function getBrowserDraft(
  userId: string,
  subjectKey: string,
): Promise<BrowserDraft | null> {
  return withDatabase(async (db) => {
    const stored = await read(db, keyOf({ userId, subjectKey }));
    if (!stored) return null;
    if (isExpired(stored.updatedAt, Date.now() - ttl)) {
      await mutate(db, (store) => {
        store.delete(stored.key);
      });
      return null;
    }
    return {
      userId: stored.userId,
      goalId: stored.goalId,
      subjectKey: stored.subjectKey,
      body: stored.body,
      baseRevision: stored.baseRevision,
      updatedAt: stored.updatedAt,
    };
  });
}
export async function deleteBrowserDraft(
  userId: string,
  subjectKey: string,
): Promise<void> {
  await withDatabase((db) =>
    mutate(db, (store) => {
      store.delete(keyOf({ userId, subjectKey }));
    }),
  );
}
export async function deleteBrowserDraftIfUnchanged(
  userId: string,
  subjectKey: string,
  expectedBody: string,
  expectedBaseRevision: number,
): Promise<void> {
  await withDatabase((db) =>
    deleteStoredIf(
      db,
      keyOf({ userId, subjectKey }),
      (stored) =>
        stored.userId === userId &&
        stored.subjectKey === subjectKey &&
        stored.body === expectedBody &&
        stored.baseRevision === expectedBaseRevision,
    ),
  );
}
export async function cleanupExpiredBrowserDrafts(): Promise<void> {
  const expiresBefore = Date.now() - ttl;
  await clearDrafts((item) => isExpired(item.updatedAt, expiresBefore));
}
export async function clearUserDrafts(userId: string): Promise<void> {
  await clearDrafts((item) => item.userId === userId);
}
export async function clearGoalDrafts(
  userId: string,
  goalId: string,
): Promise<void> {
  await clearDrafts((item) => item.userId === userId && item.goalId === goalId);
}
async function clearDrafts(matches: (draft: Stored) => boolean): Promise<void> {
  await withDatabase((db) => deleteStoredMatching(db, matches));
}
function isExpired(updatedAt: string, expiresBefore: number): boolean {
  const timestamp = Date.parse(updatedAt);
  return !Number.isFinite(timestamp) || timestamp < expiresBefore;
}
async function withDatabase<T>(
  operation: (db: IDBDatabase) => Promise<T>,
): Promise<T> {
  const db = await open();
  try {
    return await operation(db);
  } finally {
    db.close();
  }
}
function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(storeName))
        request.result.createObjectStore(storeName, { keyPath: "key" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
function mutate(
  db: IDBDatabase,
  action: (store: IDBObjectStore) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, "readwrite");
    try {
      action(transaction.objectStore(storeName));
    } catch (error) {
      transaction.abort();
      reject(error);
      return;
    }
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}
function read(db: IDBDatabase, key: string): Promise<Stored | undefined> {
  return new Promise((resolve, reject) => {
    const request = db.transaction(storeName).objectStore(storeName).get(key);
    request.onsuccess = () => resolve(request.result as Stored | undefined);
    request.onerror = () => reject(request.error);
  });
}
function deleteStoredIf(
  db: IDBDatabase,
  key: string,
  matches: (draft: Stored) => boolean,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, "readwrite");
    const store = transaction.objectStore(storeName);
    const request = store.get(key);
    request.onsuccess = () => {
      const stored = request.result as Stored | undefined;
      if (stored && matches(stored)) store.delete(key);
    };
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}
function deleteStoredMatching(
  db: IDBDatabase,
  matches: (draft: Stored) => boolean,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, "readwrite");
    const store = transaction.objectStore(storeName);
    const request = store.getAll();
    request.onsuccess = () => {
      for (const stored of request.result as readonly Stored[]) {
        if (matches(stored)) store.delete(stored.key);
      }
    };
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}
