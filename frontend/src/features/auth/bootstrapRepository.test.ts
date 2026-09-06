import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { isUUIDv7 } from "../../shared/id/uuid";
import {
  clearBootstrapID,
  getOrCreateBootstrapID,
} from "./bootstrapRepository";

const databaseName = "fukamu-cycle-bootstrap";
const storeName = "bootstrap";
const key = "pending";

describe("bootstrap repository", () => {
  beforeEach(deleteBootstrapDatabase);
  afterEach(deleteBootstrapDatabase);

  it("replaces a stored bootstrap ID from an older UUID version", async () => {
    await writeBootstrapID("123e4567-e89b-42d3-a456-426614174000");

    const id = await getOrCreateBootstrapID();

    expect(isUUIDv7(id)).toBe(true);
    expect(id).not.toBe("123e4567-e89b-42d3-a456-426614174000");
    await expect(readBootstrapID()).resolves.toBe(id);
  });

  it("converges concurrent get-or-create operations on one stored ID", async () => {
    const ids = await Promise.all(
      Array.from({ length: 8 }, () => getOrCreateBootstrapID()),
    );

    expect(ids.every(isUUIDv7)).toBe(true);
    expect(new Set(ids).size).toBe(1);
    await expect(readBootstrapID()).resolves.toBe(ids[0]);
  });

  it("does not clear a successor committed before stale cleanup", async () => {
    const completedId = await getOrCreateBootstrapID();
    const successorId = "00000000-0000-7000-8000-000000000099";
    await writeBootstrapID(successorId);

    await clearBootstrapID(completedId);

    await expect(readBootstrapID()).resolves.toBe(successorId);
  });

  it("keeps a successor across concurrent compare-and-delete", async () => {
    const completedId = await getOrCreateBootstrapID();
    const successorId = "00000000-0000-7000-8000-000000000099";

    await Promise.all([
      clearBootstrapID(completedId),
      writeBootstrapID(successorId),
    ]);

    await expect(readBootstrapID()).resolves.toBe(successorId);
  });

  it("clears the bootstrap ID that completed successfully", async () => {
    const completedId = await getOrCreateBootstrapID();

    await clearBootstrapID(completedId);

    await expect(readBootstrapID()).resolves.toBeUndefined();
  });

  it("rejects a transaction creation failure and releases its connection", async () => {
    const databaseWithoutStore = await openDatabaseWithoutStore();
    databaseWithoutStore.close();
    const opened: IDBDatabase[] = [];
    const open = spyOnDatabaseOpens((database) => opened.push(database));

    try {
      await expect(getOrCreateBootstrapID()).rejects.toMatchObject({
        name: "NotFoundError",
      });
      expect(opened).toHaveLength(1);
      expectDatabaseClosed(openedDatabaseAt(opened, 0));
    } finally {
      open.mockRestore();
      closeDatabases(opened);
    }

    const upgradedDatabase = await openBootstrapDatabase(2);
    upgradedDatabase.close();
  });

  it("does not return an ID when its write transaction aborts", async () => {
    let opened: IDBDatabase | undefined;
    const open = spyOnDatabaseOpens((database) => {
      if (opened !== undefined) return;
      opened = database;
      const originalTransaction = database.transaction.bind(database);
      vi.spyOn(database, "transaction").mockImplementation(
        (storeNames, mode, options) => {
          const transaction = originalTransaction(storeNames, mode, options);
          const store = transaction.objectStore(storeName);
          const originalPut = store.put.bind(store);
          vi.spyOn(store, "put").mockImplementation((value, objectKey) => {
            const request =
              objectKey === undefined
                ? originalPut(value)
                : originalPut(value, objectKey);
            request.addEventListener("success", () => transaction.abort(), {
              once: true,
            });
            return request;
          });
          return transaction;
        },
      );
    });

    try {
      await expect(getOrCreateBootstrapID()).rejects.toBeDefined();
      if (opened === undefined)
        throw new Error("bootstrap database was not opened");
      expectDatabaseClosed(opened);
    } finally {
      open.mockRestore();
      opened?.close();
    }
    await expect(readBootstrapID()).resolves.toBeUndefined();

    const upgradedDatabase = await openBootstrapDatabase(2);
    upgradedDatabase.close();
  });

  it("releases successful operation connections before a version upgrade", async () => {
    const id = await getOrCreateBootstrapID();
    await clearBootstrapID(id);

    const upgradedDatabase = await openBootstrapDatabase(2);

    expect(upgradedDatabase.version).toBe(2);
    upgradedDatabase.close();
  });

  it("closes every successful operation connection before resolving", async () => {
    const opened: IDBDatabase[] = [];
    const open = spyOnDatabaseOpens((database) => opened.push(database));

    try {
      const id = await getOrCreateBootstrapID();
      expect(opened).toHaveLength(1);
      expectDatabaseClosed(openedDatabaseAt(opened, 0));

      await clearBootstrapID(id);
      expect(opened).toHaveLength(2);
      expectDatabaseClosed(openedDatabaseAt(opened, 1));
    } finally {
      open.mockRestore();
      closeDatabases(opened);
    }
  });

  it("closes a stale operation connection when its version changes", async () => {
    let heldConnection: IDBDatabase | undefined;
    let closeCalls = 0;
    let restoreClose: () => void = () => undefined;
    const open = spyOnDatabaseOpens((database) => {
      if (heldConnection !== undefined) {
        database.close();
        return;
      }
      heldConnection = database;
      const originalClose = database.close.bind(database);
      const close = vi.spyOn(database, "close").mockImplementation(() => {
        closeCalls++;
        if (closeCalls > 1) originalClose();
      });
      restoreClose = () => close.mockRestore();
    });

    let upgradedDatabase: IDBDatabase | undefined;
    try {
      await getOrCreateBootstrapID();
      expect(closeCalls).toBe(1);

      upgradedDatabase = await openBootstrapDatabase(2);

      expect(upgradedDatabase.version).toBe(2);
      expect(closeCalls).toBe(2);
    } finally {
      open.mockRestore();
      restoreClose();
      heldConnection?.close();
      upgradedDatabase?.close();
    }
  });
});

async function writeBootstrapID(id: string): Promise<void> {
  const database = await openBootstrapDatabase();
  try {
    await runTransaction(database, "readwrite", (store) => {
      store.put(id, key);
    });
  } finally {
    database.close();
  }
}

async function readBootstrapID(): Promise<string | undefined> {
  const database = await openBootstrapDatabase();
  try {
    let result: string | undefined;
    await runTransaction(database, "readonly", (store) => {
      const request = store.get(key);
      request.onsuccess = () => {
        result = request.result as string | undefined;
      };
    });
    return result;
  } finally {
    database.close();
  }
}

function runTransaction(
  database: IDBDatabase,
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(storeName, mode);
    operation(transaction.objectStore(storeName));
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

function openBootstrapDatabase(version = 1): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, version);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(storeName)) {
        request.result.createObjectStore(storeName);
      }
    };
    request.onblocked = () => reject(new Error("bootstrap database blocked"));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function openDatabaseWithoutStore(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
    request.onblocked = () => reject(new Error("bootstrap database blocked"));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function spyOnDatabaseOpens(onOpen: (database: IDBDatabase) => void) {
  const originalOpen = indexedDB.open.bind(indexedDB);
  return vi.spyOn(indexedDB, "open").mockImplementation((name, version) => {
    const request =
      version === undefined ? originalOpen(name) : originalOpen(name, version);
    request.addEventListener("success", () => onOpen(request.result), {
      once: true,
    });
    return request;
  });
}

function expectDatabaseClosed(database: IDBDatabase): void {
  let failure: unknown;
  try {
    database.transaction(storeName);
  } catch (error) {
    failure = error;
  }
  expect(failure).toMatchObject({ name: "InvalidStateError" });
}

function openedDatabaseAt(
  databases: readonly IDBDatabase[],
  index: number,
): IDBDatabase {
  const database = databases[index];
  if (database === undefined)
    throw new Error("bootstrap database was not opened");
  return database;
}

function closeDatabases(databases: readonly IDBDatabase[]): void {
  for (const database of databases) database.close();
}

function deleteBootstrapDatabase(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(databaseName);
    request.onblocked = () => reject(new Error("bootstrap database blocked"));
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}
