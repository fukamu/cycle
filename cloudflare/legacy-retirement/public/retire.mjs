export const legacyDraftDatabaseName = "pdcai-browser-drafts-v2";
export const legacyDraftDatabaseVersion = 2;

const draftStoreName = "drafts";
const ttlMilliseconds = 24 * 60 * 60 * 1000;

export class LegacyRetirementBlockedError extends Error {
  constructor() {
    super("legacy retirement blocked");
    this.name = "LegacyRetirementBlockedError";
    this.code = "BLOCKED";
  }
}

class LegacyRetirementUnavailableError extends Error {
  constructor() {
    super("legacy retirement unavailable");
    this.name = "LegacyRetirementUnavailableError";
    this.code = "UNAVAILABLE";
  }
}

export async function retireLegacyDrafts({ factory, now = Date.now() } = {}) {
  const databaseFactory = factory ?? globalThis.indexedDB;
  if (!databaseFactory || !Number.isFinite(now)) {
    throw new LegacyRetirementUnavailableError();
  }

  const database = await openRetirementDatabase(databaseFactory);
  try {
    await deleteInvalidOrExpiredDrafts(database, now);
  } finally {
    database.close();
  }
}

function openRetirementDatabase(factory) {
  return new Promise((resolve, reject) => {
    const request = factory.open(
      legacyDraftDatabaseName,
      legacyDraftDatabaseVersion,
    );
    let settled = false;

    const rejectOnce = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    request.onupgradeneeded = () => {
      try {
        if (!request.result.objectStoreNames.contains(draftStoreName)) {
          request.result.createObjectStore(draftStoreName, { keyPath: "key" });
        }
      } catch {
        request.transaction?.abort();
      }
    };
    request.onblocked = () => rejectOnce(new LegacyRetirementBlockedError());
    request.onerror = () => rejectOnce(new LegacyRetirementUnavailableError());
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
  });
}

function deleteInvalidOrExpiredDrafts(database, now) {
  return new Promise((resolve, reject) => {
    let transaction;
    try {
      transaction = database.transaction(draftStoreName, "readwrite");
    } catch {
      reject(new LegacyRetirementUnavailableError());
      return;
    }

    let settled = false;
    const rejectOnce = () => {
      if (settled) return;
      settled = true;
      reject(new LegacyRetirementUnavailableError());
    };

    transaction.oncomplete = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    transaction.onerror = rejectOnce;
    transaction.onabort = rejectOnce;

    let request;
    try {
      request = transaction.objectStore(draftStoreName).openCursor();
    } catch {
      transaction.abort();
      return;
    }
    request.onerror = () => transaction.abort();
    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor === null) return;
      try {
        if (!isValidFreshDraft(cursor.value, now)) cursor.delete();
        cursor.continue();
      } catch {
        transaction.abort();
      }
    };
  });
}

function isValidFreshDraft(value, now) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  if (
    typeof value.key !== "string" ||
    typeof value.userId !== "string" ||
    value.userId.length === 0 ||
    typeof value.subjectKey !== "string" ||
    value.subjectKey.length === 0 ||
    value.key !== `${value.userId}:${value.subjectKey}` ||
    typeof value.body !== "string" ||
    !Number.isSafeInteger(value.baseRevision) ||
    value.baseRevision < 0 ||
    typeof value.updatedAt !== "string"
  ) {
    return false;
  }

  const updatedAt = Date.parse(value.updatedAt);
  if (
    !Number.isFinite(updatedAt) ||
    new Date(updatedAt).toISOString() !== value.updatedAt ||
    updatedAt > now
  ) {
    return false;
  }
  return updatedAt > now - ttlMilliseconds;
}

async function startRetirementPage() {
  const status = document.querySelector("[data-retirement-status]");
  const retry = document.querySelector("[data-retirement-retry]");
  if (
    !(status instanceof HTMLElement) ||
    !(retry instanceof HTMLButtonElement)
  ) {
    return;
  }

  const run = async () => {
    retry.hidden = true;
    retry.disabled = true;
    status.dataset.state = "working";
    status.textContent =
      "このブラウザに残る旧サイトのデータを安全に確認しています…";
    try {
      await retireLegacyDrafts();
      status.dataset.state = "complete";
      status.textContent =
        "確認が完了しました。旧サイトから新しいデータが保存されることはありません。";
    } catch (error) {
      retry.hidden = false;
      retry.disabled = false;
      if (error instanceof LegacyRetirementBlockedError) {
        status.dataset.state = "blocked";
        status.textContent =
          "他のPDCAIタブをすべて閉じてから、もう一度お試しください。";
      } else {
        status.dataset.state = "error";
        status.textContent =
          "ブラウザ内の確認を完了できませんでした。タブを閉じてから、もう一度お試しください。";
      }
    }
  };

  retry.addEventListener("click", () => void run());
  await run();
}

if (typeof document !== "undefined") {
  void startRetirementPage();
}
