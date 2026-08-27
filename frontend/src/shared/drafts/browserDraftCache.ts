const databaseName = "fukamu-cycle-browser-drafts-v2";
const databaseVersion = 2;
const storeName = "drafts";
const accountDeletionTombstoneStoreName = "account-deletion-tombstones";
const metadataStoreName = "metadata";
const accountDeletionSaltKey = "account-deletion-salt-v1";
const saltByteLength = 32;
const ttl = 24 * 60 * 60 * 1000;
const privacyGuardUnavailable = "browser draft privacy guard unavailable";

export type BrowserDraft = {
  readonly userId: string;
  readonly goalId: string | null;
  readonly subjectKey: string;
  readonly body: string;
  readonly baseRevision: number;
  readonly updatedAt: string;
};
type Stored = BrowserDraft & { readonly key: string };
type StoredAccountDeletionTombstone = { readonly digest: string };
type StoredMetadata = { readonly key: string; readonly value: string };
const keyOf = (draft: Pick<BrowserDraft, "userId" | "subjectKey">) =>
  `${draft.userId}:${draft.subjectKey}`;

export async function putBrowserDraft(draft: BrowserDraft): Promise<void> {
  const deletionDigest = await accountDeletionDigest(draft.userId);
  await withDatabase((db) =>
    putStoredUnlessAccountDeleted(db, deletionDigest, {
      ...draft,
      key: keyOf(draft),
    } satisfies Stored),
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
  const deletionDigest = await accountDeletionDigest(userId);
  await withDatabase((db) =>
    tombstoneAndDeleteStoredMatching(db, deletionDigest, userId),
  );
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
    const request = indexedDB.open(databaseName, databaseVersion);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(storeName)) {
        database.createObjectStore(storeName, { keyPath: "key" });
      }
      if (
        !database.objectStoreNames.contains(accountDeletionTombstoneStoreName)
      ) {
        database.createObjectStore(accountDeletionTombstoneStoreName, {
          keyPath: "digest",
        });
      }
      if (!database.objectStoreNames.contains(metadataStoreName)) {
        database.createObjectStore(metadataStoreName, { keyPath: "key" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function accountDeletionDigest(userId: string): Promise<string> {
  try {
    const salt = await withDatabase(getOrCreateAccountDeletionSalt);
    const subtle = globalThis.crypto?.subtle;
    if (subtle === undefined) throw new Error(privacyGuardUnavailable);
    const input = new TextEncoder().encode(`${salt}:${userId}`);
    const digest = await subtle.digest("SHA-256", input);
    return bytesToHex(new Uint8Array(digest));
  } catch {
    throw new Error(privacyGuardUnavailable);
  }
}

function getOrCreateAccountDeletionSalt(db: IDBDatabase): Promise<string> {
  const candidate = generateAccountDeletionSalt();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(metadataStoreName, "readwrite");
    const store = transaction.objectStore(metadataStoreName);
    const request = store.get(accountDeletionSaltKey);
    let selected: string | undefined;

    request.onsuccess = () => {
      const stored = request.result as StoredMetadata | undefined;
      if (stored === undefined) {
        selected = candidate;
        store.put({
          key: accountDeletionSaltKey,
          value: candidate,
        } satisfies StoredMetadata);
        return;
      }
      if (
        stored.key !== accountDeletionSaltKey ||
        !isAccountDeletionSalt(stored.value)
      ) {
        transaction.abort();
        return;
      }
      selected = stored.value;
    };
    transaction.oncomplete = () => {
      if (selected === undefined) {
        reject(new Error(privacyGuardUnavailable));
        return;
      }
      resolve(selected);
    };
    transaction.onerror = () => reject(new Error(privacyGuardUnavailable));
    transaction.onabort = () => reject(new Error(privacyGuardUnavailable));
  });
}

function generateAccountDeletionSalt(): string {
  const crypto = globalThis.crypto;
  if (crypto === undefined) throw new Error(privacyGuardUnavailable);
  const bytes = new Uint8Array(saltByteLength);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

function isAccountDeletionSalt(value: string): boolean {
  return /^[0-9a-f]{64}$/u.test(value);
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

function putStoredUnlessAccountDeleted(
  db: IDBDatabase,
  deletionDigest: string,
  stored: Stored,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(
      [storeName, accountDeletionTombstoneStoreName],
      "readwrite",
    );
    const tombstones = transaction.objectStore(
      accountDeletionTombstoneStoreName,
    );
    const request = tombstones.get(deletionDigest);
    request.onsuccess = () => {
      if (request.result === undefined) {
        transaction.objectStore(storeName).put(stored);
      }
    };
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

function tombstoneAndDeleteStoredMatching(
  db: IDBDatabase,
  deletionDigest: string,
  userId: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(
      [storeName, accountDeletionTombstoneStoreName],
      "readwrite",
    );
    transaction
      .objectStore(accountDeletionTombstoneStoreName)
      .put({ digest: deletionDigest } satisfies StoredAccountDeletionTombstone);
    const drafts = transaction.objectStore(storeName);
    const request = drafts.getAll();
    request.onsuccess = () => {
      for (const stored of request.result as readonly Stored[]) {
        if (stored.userId === userId) drafts.delete(stored.key);
      }
    };
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
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
