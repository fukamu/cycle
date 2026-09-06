import { isUUIDv7, newUUIDv7 } from "../../shared/id/uuid";

const databaseName = "fukamu-cycle-bootstrap";
const storeName = "bootstrap";
const key = "pending";

export async function getOrCreateBootstrapID(): Promise<string> {
  const database = await openDatabase();
  try {
    return await getOrCreate(database);
  } finally {
    database.close();
  }
}

export async function clearBootstrapID(expectedId: string): Promise<void> {
  const database = await openDatabase();
  try {
    await clearIfExpected(database, expectedId);
  } finally {
    database.close();
  }
}

function getOrCreate(database: IDBDatabase): Promise<string> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(storeName, "readwrite");
    const store = transaction.objectStore(storeName);
    const request = store.get(key);
    let selected: string | undefined;
    let failure: unknown;

    request.onsuccess = () => {
      const existing = request.result as unknown;
      if (typeof existing === "string" && isUUIDv7(existing)) {
        selected = existing;
        return;
      }
      selected = newUUIDv7();
      store.put(selected, key);
    };
    request.onerror = () => {
      failure = request.error ?? new Error("bootstrap read failed");
    };
    transaction.oncomplete = () => {
      if (selected === undefined) {
        reject(new Error("bootstrap transaction completed without an ID"));
        return;
      }
      resolve(selected);
    };
    transaction.onerror = () =>
      reject(
        failure ??
          transaction.error ??
          new Error("bootstrap transaction failed"),
      );
    transaction.onabort = () =>
      reject(
        failure ??
          transaction.error ??
          new Error("bootstrap transaction aborted"),
      );
  });
}

function clearIfExpected(
  database: IDBDatabase,
  expectedId: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(storeName, "readwrite");
    const store = transaction.objectStore(storeName);
    const request = store.get(key);
    let failure: unknown;

    request.onsuccess = () => {
      if (request.result === expectedId) store.delete(key);
    };
    request.onerror = () => {
      failure = request.error ?? new Error("bootstrap read failed");
    };
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(
        failure ??
          transaction.error ??
          new Error("bootstrap cleanup transaction failed"),
      );
    transaction.onabort = () =>
      reject(
        failure ??
          transaction.error ??
          new Error("bootstrap cleanup transaction aborted"),
      );
  });
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(storeName)) {
        request.result.createObjectStore(storeName);
      }
    };
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => database.close();
      resolve(database);
    };
    request.onerror = () =>
      reject(request.error ?? new Error("bootstrap database open failed"));
  });
}
