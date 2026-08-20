import { isUUIDv7, newUUIDv7 } from "../../shared/id/uuid";

const databaseName = "pdcai-bootstrap";
const storeName = "bootstrap";
const key = "pending";

export async function getOrCreateBootstrapID(): Promise<string> {
  const database = await openDatabase();
  const existing = await new Promise<string | undefined>((resolve, reject) => {
    const request = database
      .transaction(storeName)
      .objectStore(storeName)
      .get(key);
    request.onsuccess = () => resolve(request.result as string | undefined);
    request.onerror = () =>
      reject(request.error ?? new Error("bootstrap read failed"));
  });
  if (existing !== undefined && isUUIDv7(existing)) {
    return existing;
  }
  const created = newUUIDv7();
  await new Promise<void>((resolve, reject) => {
    const request = database
      .transaction(storeName, "readwrite")
      .objectStore(storeName)
      .put(created, key);
    request.onsuccess = () => resolve();
    request.onerror = () =>
      reject(request.error ?? new Error("bootstrap write failed"));
  });
  return created;
}

export async function clearBootstrapID(): Promise<void> {
  const database = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const request = database
      .transaction(storeName, "readwrite")
      .objectStore(storeName)
      .delete(key);
    request.onsuccess = () => resolve();
    request.onerror = () =>
      reject(request.error ?? new Error("bootstrap delete failed"));
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
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("bootstrap database open failed"));
  });
}
