import { expect, it } from "vitest";

import { isUUIDv7 } from "../../shared/id/uuid";
import { getOrCreateBootstrapID } from "./bootstrapRepository";

it("replaces a stored bootstrap ID from an older UUID version", async () => {
  const database = await openBootstrapDatabase();
  await new Promise<void>((resolve, reject) => {
    const request = database
      .transaction("bootstrap", "readwrite")
      .objectStore("bootstrap")
      .put("123e4567-e89b-42d3-a456-426614174000", "pending");
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
  database.close();

  const id = await getOrCreateBootstrapID();

  expect(isUUIDv7(id)).toBe(true);
  expect(id).not.toBe("123e4567-e89b-42d3-a456-426614174000");
});

function openBootstrapDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("fukamu-cycle-bootstrap", 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("bootstrap");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
