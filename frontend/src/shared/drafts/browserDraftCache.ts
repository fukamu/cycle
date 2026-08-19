const databaseName = "pdcai-browser-drafts-v2";
const storeName = "drafts";
const ttl = 24 * 60 * 60 * 1000;

export type BrowserDraft = {
  readonly userId: string;
  readonly subjectKey: string;
  readonly body: string;
  readonly baseRevision: number;
  readonly updatedAt: string;
};
type Stored = BrowserDraft & { readonly key: string };
const keyOf = (draft: Pick<BrowserDraft, "userId" | "subjectKey">) =>
  `${draft.userId}:${draft.subjectKey}`;

export async function putBrowserDraft(draft: BrowserDraft): Promise<void> {
  const db = await open();
  await mutate(db, (store) =>
    store.put({ ...draft, key: keyOf(draft) } satisfies Stored),
  );
}
export async function getBrowserDraft(
  userId: string,
  subjectKey: string,
): Promise<BrowserDraft | null> {
  const db = await open();
  const stored = await read(db, keyOf({ userId, subjectKey }));
  if (!stored) return null;
  if (Date.parse(stored.updatedAt) < Date.now() - ttl) {
    await deleteBrowserDraft(userId, subjectKey);
    return null;
  }
  return {
    userId: stored.userId,
    subjectKey: stored.subjectKey,
    body: stored.body,
    baseRevision: stored.baseRevision,
    updatedAt: stored.updatedAt,
  };
}
export async function deleteBrowserDraft(
  userId: string,
  subjectKey: string,
): Promise<void> {
  const db = await open();
  await mutate(db, (store) => store.delete(keyOf({ userId, subjectKey })));
}
export async function clearUserDrafts(userId: string): Promise<void> {
  const db = await open();
  const records = await all(db);
  await Promise.all(
    records
      .filter((item) => item.userId === userId)
      .map((item) => deleteBrowserDraft(userId, item.subjectKey)),
  );
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
  action: (store: IDBObjectStore) => IDBRequest,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, "readwrite");
    action(transaction.objectStore(storeName));
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}
function read(db: IDBDatabase, key: string): Promise<Stored | undefined> {
  return new Promise((resolve, reject) => {
    const request = db.transaction(storeName).objectStore(storeName).get(key);
    request.onsuccess = () => resolve(request.result as Stored | undefined);
    request.onerror = () => reject(request.error);
  });
}
function all(db: IDBDatabase): Promise<readonly Stored[]> {
  return new Promise((resolve, reject) => {
    const request = db.transaction(storeName).objectStore(storeName).getAll();
    request.onsuccess = () => resolve(request.result as readonly Stored[]);
    request.onerror = () => reject(request.error);
  });
}
