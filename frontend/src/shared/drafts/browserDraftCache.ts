const databaseName = "fukamu-cycle-browser-drafts-v2";
const databaseVersion = 3;
const storeName = "drafts";
const accountDeletionTombstoneStoreName = "account-deletion-tombstones";
const goalDeletionTombstoneStoreName = "goal-deletion-tombstones";
const goalDeletionOwnerDigestIndexName = "ownerDigest";
const metadataStoreName = "metadata";
const accountDeletionSaltKey = "account-deletion-salt-v1";
const goalDeletionDigestDomain = "fukamu-cycle-goal-deletion-v1";
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
type StoredGoalDeletionTombstone = {
  readonly digest: string;
  readonly ownerDigest: string;
};
type StoredMetadata = { readonly key: string; readonly value: string };
const keyOf = (draft: Pick<BrowserDraft, "userId" | "subjectKey">) =>
  `${draft.userId}:${draft.subjectKey}`;

export async function putBrowserDraft(draft: BrowserDraft): Promise<void> {
  const deletionDigests = await deletionDigestsFor(draft.userId, draft.goalId);
  await withDatabase((db) =>
    putStoredUnlessDeleted(
      db,
      deletionDigests.ownerDigest,
      deletionDigests.goalDigest,
      {
        ...draft,
        key: keyOf(draft),
      } satisfies Stored,
    ),
  );
}
export async function getBrowserDraft(
  userId: string,
  subjectKey: string,
): Promise<BrowserDraft | null> {
  return withDatabase(async (db) => {
    const stored = await readStoredAndDeleteIfExpired(
      db,
      keyOf({ userId, subjectKey }),
      Date.now() - ttl,
    );
    if (!stored) return null;
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
export async function tombstoneDeletedGoalAndClearDrafts(
  userId: string,
  goalId: string,
): Promise<void> {
  const { ownerDigest, goalDigest } = await deletionDigestsFor(userId, goalId);
  if (goalDigest === null) throw new Error(privacyGuardUnavailable);
  await withDatabase((db) =>
    tombstoneGoalAndDeleteStoredMatching(
      db,
      ownerDigest,
      goalDigest,
      userId,
      goalId,
    ),
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
    let settled = false;
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
      let goalDeletionTombstones: IDBObjectStore;
      if (!database.objectStoreNames.contains(goalDeletionTombstoneStoreName)) {
        goalDeletionTombstones = database.createObjectStore(
          goalDeletionTombstoneStoreName,
          { keyPath: "digest" },
        );
      } else {
        const transaction = request.transaction;
        if (transaction === null) throw new Error(privacyGuardUnavailable);
        goalDeletionTombstones = transaction.objectStore(
          goalDeletionTombstoneStoreName,
        );
      }
      if (
        !goalDeletionTombstones.indexNames.contains(
          goalDeletionOwnerDigestIndexName,
        )
      ) {
        goalDeletionTombstones.createIndex(
          goalDeletionOwnerDigestIndexName,
          "ownerDigest",
        );
      }
      if (!database.objectStoreNames.contains(metadataStoreName)) {
        database.createObjectStore(metadataStoreName, { keyPath: "key" });
      }
    };
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => database.close();
      if (settled) {
        database.close();
        return;
      }
      settled = true;
      resolve(database);
    };
    request.onerror = () => {
      if (settled) return;
      settled = true;
      reject(request.error ?? new Error(privacyGuardUnavailable));
    };
    request.onblocked = () => {
      if (settled) return;
      settled = true;
      reject(new Error(privacyGuardUnavailable));
    };
  });
}

async function accountDeletionDigest(userId: string): Promise<string> {
  return (await deletionDigestsFor(userId, null)).ownerDigest;
}

async function deletionDigestsFor(
  userId: string,
  goalId: string | null,
): Promise<{
  readonly ownerDigest: string;
  readonly goalDigest: string | null;
}> {
  try {
    const salt = await withDatabase(getOrCreateAccountDeletionSalt);
    const subtle = globalThis.crypto?.subtle;
    if (subtle === undefined) throw new Error(privacyGuardUnavailable);
    const encoder = new TextEncoder();
    const ownerInput = encoder.encode(`${salt}:${userId}`);
    const ownerDigestPromise = subtle.digest("SHA-256", ownerInput);
    const goalDigestPromise =
      goalId === null
        ? null
        : subtle.digest(
            "SHA-256",
            frameUtf8Parts(
              [goalDeletionDigestDomain, salt, userId, goalId],
              encoder,
            ),
          );
    const [ownerDigestBuffer, goalDigestBuffer] = await Promise.all([
      ownerDigestPromise,
      goalDigestPromise,
    ]);
    const ownerDigest = bytesToHex(new Uint8Array(ownerDigestBuffer));
    const goalDigest =
      goalDigestBuffer === null
        ? null
        : bytesToHex(new Uint8Array(goalDigestBuffer));
    return { ownerDigest, goalDigest };
  } catch {
    throw new Error(privacyGuardUnavailable);
  }
}

function frameUtf8Parts(
  parts: readonly string[],
  encoder: TextEncoder,
): Uint8Array<ArrayBuffer> {
  const encoded = parts.map((part) => encoder.encode(part));
  const byteLength = encoded.reduce(
    (total, part) => total + 4 + part.length,
    0,
  );
  const framed = new Uint8Array(byteLength);
  const view = new DataView(framed.buffer);
  let offset = 0;
  for (const part of encoded) {
    if (part.length > 0xffffffff) throw new Error(privacyGuardUnavailable);
    view.setUint32(offset, part.length, false);
    offset += 4;
    framed.set(part, offset);
    offset += part.length;
  }
  return framed;
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

function putStoredUnlessDeleted(
  db: IDBDatabase,
  ownerDigest: string,
  goalDigest: string | null,
  stored: Stored,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(
      goalDigest === null
        ? [storeName, accountDeletionTombstoneStoreName]
        : [
            storeName,
            accountDeletionTombstoneStoreName,
            goalDeletionTombstoneStoreName,
          ],
      "readwrite",
    );
    const accountRequest = transaction
      .objectStore(accountDeletionTombstoneStoreName)
      .get(ownerDigest);
    accountRequest.onsuccess = () => {
      if (accountRequest.result !== undefined) return;
      if (goalDigest === null) {
        transaction.objectStore(storeName).put(stored);
        return;
      }
      const goalRequest = transaction
        .objectStore(goalDeletionTombstoneStoreName)
        .get(goalDigest);
      goalRequest.onsuccess = () => {
        if (goalRequest.result === undefined) {
          transaction.objectStore(storeName).put(stored);
        }
      };
    };
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error(privacyGuardUnavailable));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error(privacyGuardUnavailable));
  });
}

function tombstoneAndDeleteStoredMatching(
  db: IDBDatabase,
  deletionDigest: string,
  userId: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(
      [
        storeName,
        accountDeletionTombstoneStoreName,
        goalDeletionTombstoneStoreName,
      ],
      "readwrite",
    );
    const accountTombstoneRequest = transaction
      .objectStore(accountDeletionTombstoneStoreName)
      .put({ digest: deletionDigest } satisfies StoredAccountDeletionTombstone);
    accountTombstoneRequest.onsuccess = () => {
      const drafts = transaction.objectStore(storeName);
      const draftsRequest = drafts.getAll();
      draftsRequest.onsuccess = () => {
        for (const stored of draftsRequest.result as readonly Stored[]) {
          if (stored.userId === userId) drafts.delete(stored.key);
        }
      };
      const goalTombstones = transaction.objectStore(
        goalDeletionTombstoneStoreName,
      );
      const ownedGoalTombstones = goalTombstones
        .index(goalDeletionOwnerDigestIndexName)
        .openKeyCursor(deletionDigest);
      ownedGoalTombstones.onsuccess = () => {
        const cursor = ownedGoalTombstones.result;
        if (cursor === null) return;
        goalTombstones.delete(cursor.primaryKey);
        cursor.continue();
      };
    };
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error(privacyGuardUnavailable));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error(privacyGuardUnavailable));
  });
}

function tombstoneGoalAndDeleteStoredMatching(
  db: IDBDatabase,
  ownerDigest: string,
  goalDigest: string,
  userId: string,
  goalId: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(
      [
        storeName,
        accountDeletionTombstoneStoreName,
        goalDeletionTombstoneStoreName,
      ],
      "readwrite",
    );
    const accountRequest = transaction
      .objectStore(accountDeletionTombstoneStoreName)
      .get(ownerDigest);
    accountRequest.onsuccess = () => {
      if (accountRequest.result === undefined) {
        transaction.objectStore(goalDeletionTombstoneStoreName).put({
          digest: goalDigest,
          ownerDigest,
        } satisfies StoredGoalDeletionTombstone);
      }
      const drafts = transaction.objectStore(storeName);
      const draftsRequest = drafts.getAll();
      draftsRequest.onsuccess = () => {
        for (const stored of draftsRequest.result as readonly Stored[]) {
          if (stored.userId === userId && stored.goalId === goalId) {
            drafts.delete(stored.key);
          }
        }
      };
    };
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error(privacyGuardUnavailable));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error(privacyGuardUnavailable));
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
function readStoredAndDeleteIfExpired(
  db: IDBDatabase,
  key: string,
  expiresBefore: number,
): Promise<Stored | undefined> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, "readwrite");
    const store = transaction.objectStore(storeName);
    const request = store.get(key);
    let selected: Stored | undefined;
    let requestError: DOMException | null = null;
    request.onerror = () => {
      requestError = request.error;
    };
    request.onsuccess = () => {
      const stored = request.result as Stored | undefined;
      if (stored && isExpired(stored.updatedAt, expiresBefore)) {
        const deletion = store.delete(key);
        deletion.onerror = () => {
          requestError = deletion.error;
        };
        return;
      }
      selected = stored;
    };
    transaction.oncomplete = () => resolve(selected);
    transaction.onabort = () =>
      reject(
        transaction.error ??
          requestError ??
          new Error("browser draft read transaction aborted"),
      );
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
