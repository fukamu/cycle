import type { Frame } from "../../../shared/api/schemas";

const databaseName = "pdcai-drafts";
const storeName = "drafts";
const draftTTL = 24 * 60 * 60 * 1000;

export type DraftRecord = {
  readonly userId: string;
  readonly cycleId: string;
  readonly frame: Frame;
  readonly content: string;
  readonly baseFrameRevision: number;
  readonly updatedAt: string;
};

type StoredDraft = DraftRecord & { readonly key: string };

export async function putDraft(record: DraftRecord): Promise<void> {
  const database = await openDatabase();
  await runRequest(database, "readwrite", (store) =>
    store.put({ ...record, key: draftKey(record) } satisfies StoredDraft),
  );
}

export async function deleteDraft(
  userId: string,
  cycleId: string,
  frame: Frame,
): Promise<void> {
  const database = await openDatabase();
  await runRequest(database, "readwrite", (store) =>
    store.delete(draftKey({ userId, cycleId, frame })),
  );
}

export async function listCycleDrafts(
  userId: string,
  cycleId: string,
): Promise<readonly DraftRecord[]> {
  const database = await openDatabase();
  const records = await getAll(database);
  const cutoff = Date.now() - draftTTL;
  const expired = records.filter(
    (record) => Date.parse(record.updatedAt) < cutoff,
  );
  await Promise.all(
    expired.map((record) =>
      deleteDraft(record.userId, record.cycleId, record.frame),
    ),
  );
  return records
    .filter(
      (record) =>
        record.userId === userId &&
        record.cycleId === cycleId &&
        Date.parse(record.updatedAt) >= cutoff,
    )
    .map((record) => ({
      userId: record.userId,
      cycleId: record.cycleId,
      frame: record.frame,
      content: record.content,
      baseFrameRevision: record.baseFrameRevision,
      updatedAt: record.updatedAt,
    }));
}

export async function clearUserDrafts(userId: string): Promise<void> {
  const database = await openDatabase();
  const records = await getAll(database);
  await Promise.all(
    records
      .filter((record) => record.userId === userId)
      .map((record) =>
        deleteDraft(record.userId, record.cycleId, record.frame),
      ),
  );
}

function draftKey(
  record: Pick<DraftRecord, "userId" | "cycleId" | "frame">,
): string {
  return `${record.userId}:${record.cycleId}:${record.frame}`;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(storeName)) {
        request.result.createObjectStore(storeName, { keyPath: "key" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("draft database open failed"));
  });
}

function runRequest(
  database: IDBDatabase,
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(storeName, mode);
    const request = operation(transaction.objectStore(storeName));
    request.onerror = () =>
      reject(request.error ?? new Error("draft operation failed"));
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("draft transaction failed"));
  });
}

function getAll(database: IDBDatabase): Promise<readonly StoredDraft[]> {
  return new Promise((resolve, reject) => {
    const request = database
      .transaction(storeName)
      .objectStore(storeName)
      .getAll();
    request.onsuccess = () => resolve(request.result as readonly StoredDraft[]);
    request.onerror = () =>
      reject(request.error ?? new Error("draft list failed"));
  });
}
