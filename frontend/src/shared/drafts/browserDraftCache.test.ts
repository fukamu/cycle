import {
  cleanupExpiredBrowserDrafts,
  clearGoalDrafts,
  clearUserDrafts,
  deleteBrowserDraftIfUnchanged,
  getBrowserDraft,
  putBrowserDraft,
  tombstoneDeletedGoalAndClearDrafts,
} from "./browserDraftCache";

describe("browser draft cache", () => {
  it("migrates v2 in place, preserves the account digest contract, and fences v2 writers", async () => {
    const deletedUserId = "00000000-0000-7000-8000-000000000126";
    const otherUserId = "00000000-0000-7000-8000-000000000128";
    const preservedDraft = {
      userId: otherUserId,
      goalId: "00000000-0000-7000-8000-000000000129",
      subjectKey: "cycle:legacy-v2-cycle:plan",
      body: "legacy v2 content",
      baseRevision: 2,
      updatedAt: new Date().toISOString(),
    } as const;
    const legacyConnection = await resetAsLegacyV2Database({
      accountDeletionDigests: [fixedAccountDeletionDigest],
      drafts: [preservedDraft],
    });
    legacyConnection.close();

    await putBrowserDraft({
      userId: deletedUserId,
      goalId: "00000000-0000-7000-8000-000000000127",
      subjectKey: "cycle:blocked-after-v2-upgrade:plan",
      body: "must remain blocked by the legacy account tombstone",
      baseRevision: 0,
      updatedAt: new Date().toISOString(),
    });

    const schema = await readDraftDatabaseSchema();
    expect(schema).toEqual({
      version: 3,
      stores: [
        "account-deletion-tombstones",
        "drafts",
        "goal-deletion-tombstones",
        "metadata",
      ],
      goalDeletionIndexes: ["ownerDigest"],
    });
    expect(
      await getBrowserDraft(
        deletedUserId,
        "cycle:blocked-after-v2-upgrade:plan",
      ),
    ).toBeNull();
    expect(
      await getBrowserDraft(otherUserId, preservedDraft.subjectKey),
    ).toEqual(preservedDraft);
    await expect(openLegacyV2Writer()).resolves.toBe("VersionError");
  });

  it("fails closed without hanging when a legacy v2 connection blocks the upgrade", async () => {
    const legacyConnection = await resetAsLegacyV2Database();
    const blockedDraft = {
      userId: "blocked-upgrade-owner",
      goalId: "blocked-upgrade-goal",
      subjectKey: "cycle:blocked-upgrade-cycle:plan",
      body: "must not be written through a blocked privacy upgrade",
      baseRevision: 0,
      updatedAt: new Date().toISOString(),
    } as const;
    try {
      await expect(putBrowserDraft(blockedDraft)).rejects.toThrow(
        "browser draft privacy guard unavailable",
      );
    } finally {
      legacyConnection.close();
    }

    await waitForCurrentDatabaseOpenToSettle();
    expect(
      await getBrowserDraft(blockedDraft.userId, blockedDraft.subjectKey),
    ).toBeNull();
  });

  it.each([
    { transactionOrder: "put-before-clear", putAfterClear: false },
    { transactionOrder: "clear-before-put", putAfterClear: true },
  ])(
    "does not resurrect a deleted account draft when transactions run $transactionOrder",
    async ({ putAfterClear }) => {
      const deletedUserId = putAfterClear
        ? "00000000-0000-7000-8000-000000000011"
        : "00000000-0000-7000-8000-000000000012";
      const otherUserId = putAfterClear
        ? "00000000-0000-7000-8000-000000000013"
        : "00000000-0000-7000-8000-000000000014";
      const deletedDraft = {
        userId: deletedUserId,
        goalId: "deleted-goal",
        subjectKey: "cycle:deleted-cycle:plan",
        body: "content owned by the deleted account",
        baseRevision: 0,
        updatedAt: new Date().toISOString(),
      } as const;
      const otherDraft = {
        userId: otherUserId,
        goalId: "other-goal",
        subjectKey: "cycle:other-cycle:plan",
        body: "content owned by another account",
        baseRevision: 1,
        updatedAt: new Date().toISOString(),
      } as const;

      await putBrowserDraft(otherDraft);
      if (!putAfterClear) await putBrowserDraft(deletedDraft);
      await clearUserDrafts(deletedUserId);
      if (putAfterClear) await putBrowserDraft(deletedDraft);

      expect(
        await getBrowserDraft(deletedUserId, deletedDraft.subjectKey),
      ).toBeNull();
      expect(await getBrowserDraft(otherUserId, otherDraft.subjectKey)).toEqual(
        otherDraft,
      );
    },
  );

  it("blocks a put that started before Goal Delete but reaches its transaction afterward", async () => {
    const userId = "in-flight-before-goal-delete-owner";
    const goalId = "in-flight-before-goal-delete-goal";
    const draft = draftFixture(
      userId,
      goalId,
      "cycle:in-flight-before-goal-delete:plan",
      "in-flight content must stay deleted",
    );
    const originalDigest = globalThis.crypto.subtle.digest.bind(
      globalThis.crypto.subtle,
    );
    const digestStarted = deferred<void>();
    const releaseDigest = deferred<void>();
    let digestCalls = 0;
    const digestSpy = vi
      .spyOn(globalThis.crypto.subtle, "digest")
      .mockImplementation((algorithm, data) => {
        digestCalls += 1;
        if (digestCalls !== 1) return originalDigest(algorithm, data);
        const digest = originalDigest(algorithm, data);
        digestStarted.resolve(undefined);
        return releaseDigest.promise.then(() => digest);
      });
    try {
      const latePut = putBrowserDraft(draft);
      await digestStarted.promise;
      await tombstoneDeletedGoalAndClearDrafts(userId, goalId);
      releaseDigest.resolve(undefined);
      await latePut;
    } finally {
      releaseDigest.resolve(undefined);
      digestSpy.mockRestore();
    }

    expect(digestCalls).toBeGreaterThanOrEqual(4);
    expect(await getBrowserDraft(userId, draft.subjectKey)).toBeNull();
  });

  it("checks account and goal tombstones with the put in one readwrite transaction", async () => {
    const observation = observeDraftPrivacyTransactions();
    try {
      await putBrowserDraft(
        draftFixture(
          "goal-put-transaction-owner",
          "goal-put-transaction-goal",
          "cycle:goal-put-transaction:plan",
          "atomically guarded content",
        ),
      );
    } finally {
      observation.restore();
    }

    expect(observation.draftTransactions).toEqual([
      {
        mode: "readwrite",
        stores: [
          "account-deletion-tombstones",
          "drafts",
          "goal-deletion-tombstones",
        ],
      },
    ]);
  });

  it("stores account-deletion privacy records without raw identity or draft content", async () => {
    const deletedUserId = "00000000-0000-7000-8000-000000000015";
    const deletedBody = "private deleted account body marker";
    await putBrowserDraft({
      userId: deletedUserId,
      goalId: "privacy-goal",
      subjectKey: "cycle:privacy-cycle:plan",
      body: deletedBody,
      baseRevision: 0,
      updatedAt: new Date().toISOString(),
    });

    await clearUserDrafts(deletedUserId);

    const privacyRecords = await readAccountDeletionPrivacyRecords();
    expect(privacyRecords.tombstones.length).toBeGreaterThan(0);
    for (const tombstone of privacyRecords.tombstones) {
      expect(Object.keys(tombstone)).toEqual(["digest"]);
      expect(tombstone.digest).toMatch(/^[0-9a-f]{64}$/u);
    }
    expect(privacyRecords.metadata).toEqual([
      {
        key: "account-deletion-salt-v1",
        value: expect.stringMatching(/^[0-9a-f]{64}$/u),
      },
    ]);
    const serialized = JSON.stringify(privacyRecords);
    expect(serialized).not.toContain(deletedUserId);
    expect(serialized).not.toContain(deletedBody);
  });

  it.each([
    { transactionOrder: "put-before-goal-delete", putAfterDelete: false },
    { transactionOrder: "goal-delete-before-put", putAfterDelete: true },
  ])(
    "does not resurrect a deleted goal draft when transactions run $transactionOrder",
    async ({ putAfterDelete }) => {
      const userId = putAfterDelete
        ? "goal-delete-after-owner"
        : "goal-delete-before-owner";
      const goalId = putAfterDelete
        ? "goal-delete-after-goal"
        : "goal-delete-before-goal";
      const draft = {
        userId,
        goalId,
        subjectKey: `cycle:${goalId}:plan`,
        body: "deleted goal recovery content",
        baseRevision: 0,
        updatedAt: new Date().toISOString(),
      } as const;

      if (!putAfterDelete) await putBrowserDraft(draft);
      await tombstoneDeletedGoalAndClearDrafts(userId, goalId);
      if (putAfterDelete) await putBrowserDraft(draft);

      expect(await getBrowserDraft(userId, draft.subjectKey)).toBeNull();
    },
  );

  it("isolates goal tombstones by both user and goal", async () => {
    const deletedUserId = "goal-isolation-deleted-owner";
    const otherUserId = "goal-isolation-other-owner";
    const deletedGoalId = "goal-isolation-deleted-goal";
    const otherGoalId = "goal-isolation-other-goal";
    const deletedDraft = draftFixture(
      deletedUserId,
      deletedGoalId,
      "cycle:goal-isolation-deleted:plan",
      "deleted goal content",
    );
    const sameGoalOtherUserDraft = draftFixture(
      otherUserId,
      deletedGoalId,
      "cycle:goal-isolation-other-user:plan",
      "same goal id for another user",
    );
    const sameUserOtherGoalDraft = draftFixture(
      deletedUserId,
      otherGoalId,
      "cycle:goal-isolation-other-goal:plan",
      "another goal for the deleted goal owner",
    );
    await Promise.all([
      putBrowserDraft(deletedDraft),
      putBrowserDraft(sameGoalOtherUserDraft),
      putBrowserDraft(sameUserOtherGoalDraft),
    ]);

    await tombstoneDeletedGoalAndClearDrafts(deletedUserId, deletedGoalId);
    await putBrowserDraft({
      ...deletedDraft,
      body: "late deleted goal content",
    });

    expect(
      await getBrowserDraft(deletedUserId, deletedDraft.subjectKey),
    ).toBeNull();
    expect(
      await getBrowserDraft(otherUserId, sameGoalOtherUserDraft.subjectKey),
    ).toEqual(sameGoalOtherUserDraft);
    expect(
      await getBrowserDraft(deletedUserId, sameUserOtherGoalDraft.subjectKey),
    ).toEqual(sameUserOtherGoalDraft);
  });

  it("keeps Creation Drafts under the account tombstone only", async () => {
    const userId = "creation-draft-after-goal-delete-owner";
    const deletedGoalId = "creation-draft-after-goal-delete-goal";
    await tombstoneDeletedGoalAndClearDrafts(userId, deletedGoalId);
    const creationDraft = {
      userId,
      goalId: null,
      subjectKey: "goal-draft:creation-after-goal-delete",
      body: "new goal creation remains available",
      baseRevision: 0,
      updatedAt: new Date().toISOString(),
    } as const;

    await putBrowserDraft(creationDraft);

    expect(await getBrowserDraft(userId, creationDraft.subjectKey)).toEqual(
      creationDraft,
    );
  });

  it("stores only framed goal and owner digests in goal-deletion privacy records", async () => {
    const userId = "00000000-0000-7000-8000-000000000126";
    const goalId = "00000000-0000-7000-8000-000000000127";
    const privateBody = "goal tombstone private body marker";
    await putBrowserDraft({
      userId,
      goalId,
      subjectKey: "cycle:goal-tombstone-privacy:plan",
      body: privateBody,
      baseRevision: 0,
      updatedAt: new Date().toISOString(),
    });

    await tombstoneDeletedGoalAndClearDrafts(userId, goalId);

    const records = await readGoalDeletionPrivacyRecords();
    const tombstone = records.find(
      (candidate) => candidate.digest === fixedGoalDeletionDigest,
    );
    expect(tombstone).toEqual({
      digest: fixedGoalDeletionDigest,
      ownerDigest: fixedAccountDeletionDigest,
    });
    for (const record of records) {
      expect(Object.keys(record).sort()).toEqual(["digest", "ownerDigest"]);
      expect(record.digest).toMatch(/^[0-9a-f]{64}$/u);
      expect(record.ownerDigest).toMatch(/^[0-9a-f]{64}$/u);
    }
    const serialized = JSON.stringify(records);
    expect(serialized).not.toContain(userId);
    expect(serialized).not.toContain(goalId);
    expect(serialized).not.toContain(privateBody);
    expect(serialized).not.toContain("updatedAt");
  });

  it.each([
    "goal-delete-before-account-delete",
    "account-delete-before-goal-delete",
    "concurrent-account-and-goal-delete",
  ])(
    "does not recreate an owner goal tombstone during %s",
    async (deletionOrder) => {
      const userId = `account-goal-race-owner:${deletionOrder}`;
      const goalId = `account-goal-race-goal:${deletionOrder}`;
      const draft = draftFixture(
        userId,
        goalId,
        `cycle:account-goal-race:${deletionOrder}:plan`,
        "account deletion wins permanently",
      );
      await putBrowserDraft(draft);

      if (deletionOrder === "goal-delete-before-account-delete") {
        await tombstoneDeletedGoalAndClearDrafts(userId, goalId);
        await clearUserDrafts(userId);
        await tombstoneDeletedGoalAndClearDrafts(userId, goalId);
      } else if (deletionOrder === "account-delete-before-goal-delete") {
        await clearUserDrafts(userId);
        await tombstoneDeletedGoalAndClearDrafts(userId, goalId);
      } else {
        await Promise.all([
          tombstoneDeletedGoalAndClearDrafts(userId, goalId),
          clearUserDrafts(userId),
        ]);
      }
      await putBrowserDraft(draft);

      const privacyRecords = await readDeletionPrivacyRecords();
      const ownerDigest = await accountDigestFixture(userId);
      expect(
        privacyRecords.goalTombstones.filter(
          (record) => record.ownerDigest === ownerDigest,
        ),
      ).toEqual([]);
      expect(
        privacyRecords.accountTombstones.some(
          (record) => record.digest === ownerDigest,
        ),
      ).toBe(true);
      expect(await getBrowserDraft(userId, draft.subjectKey)).toBeNull();
    },
  );

  it("rolls back both the goal tombstone and draft deletion when the transaction aborts", async () => {
    const userId = "goal-delete-abort-owner";
    const goalId = "goal-delete-abort-goal";
    const draft = draftFixture(
      userId,
      goalId,
      "cycle:goal-delete-abort-cycle:plan",
      "content retained when deletion guard cannot commit",
    );
    await putBrowserDraft(draft);
    const injected = abortNextGoalDeletionTransaction();
    try {
      await expect(
        tombstoneDeletedGoalAndClearDrafts(userId, goalId),
      ).rejects.toThrow("browser draft privacy guard unavailable");
      expect(injected.abortTriggered).toBe(true);
      expect(injected.closeSpy).toHaveBeenCalledOnce();
    } finally {
      injected.restore();
    }

    expect(await getBrowserDraft(userId, draft.subjectKey)).toEqual(draft);
    const ownerDigest = await accountDigestFixture(userId);
    expect(
      (await readGoalDeletionPrivacyRecords()).filter(
        (record) => record.ownerDigest === ownerDigest,
      ),
    ).toEqual([]);
  });

  it("rolls back the whole Account Delete transaction when owned goal-tombstone cleanup aborts", async () => {
    const userId = "account-delete-abort-owner";
    const deletedGoalId = "account-delete-abort-deleted-goal";
    const remainingDraft = draftFixture(
      userId,
      "account-delete-abort-other-goal",
      "cycle:account-delete-abort-other:plan",
      "account-owned content retained after rollback",
    );
    await tombstoneDeletedGoalAndClearDrafts(userId, deletedGoalId);
    await putBrowserDraft(remainingDraft);
    const ownerDigest = await accountDigestFixture(userId);
    expect(
      (await readGoalDeletionPrivacyRecords()).some(
        (record) => record.ownerDigest === ownerDigest,
      ),
    ).toBe(true);
    const injected = abortNextAccountDeletionGoalTombstoneCleanup();
    try {
      await expect(clearUserDrafts(userId)).rejects.toThrow(
        "browser draft privacy guard unavailable",
      );
      expect(injected.abortTriggered).toBe(true);
      expect(injected.closeSpy).toHaveBeenCalledOnce();
    } finally {
      injected.restore();
    }

    const privacyRecords = await readDeletionPrivacyRecords();
    expect(
      privacyRecords.accountTombstones.some(
        (record) => record.digest === ownerDigest,
      ),
    ).toBe(false);
    expect(
      privacyRecords.goalTombstones.some(
        (record) => record.ownerDigest === ownerDigest,
      ),
    ).toBe(true);
    expect(await getBrowserDraft(userId, remainingDraft.subjectKey)).toEqual(
      remainingDraft,
    );
  });

  it("closes module-opened connections on versionchange", async () => {
    const capture = captureModuleOpenedDatabase();
    try {
      await putBrowserDraft(
        draftFixture(
          "versionchange-handler-owner",
          "versionchange-handler-goal",
          "cycle:versionchange-handler:plan",
          "connection has an upgrade release handler",
        ),
      );
      expect(capture.database).toBeDefined();
      expect(typeof capture.database?.onversionchange).toBe("function");
    } finally {
      capture.restore();
    }
  });

  it("fails closed before publishing when goal digest generation fails", async () => {
    const userId = "goal-digest-failure-owner";
    const goalId = "goal-digest-failure-goal";
    const draft = draftFixture(
      userId,
      goalId,
      "cycle:goal-digest-failure:plan",
      "must not publish without the privacy digest",
    );
    const originalDigest = globalThis.crypto.subtle.digest.bind(
      globalThis.crypto.subtle,
    );
    let digestCalls = 0;
    const digestSpy = vi
      .spyOn(globalThis.crypto.subtle, "digest")
      .mockImplementation((algorithm, data) => {
        digestCalls += 1;
        return digestCalls === 2
          ? Promise.reject(new Error("injected goal digest failure"))
          : originalDigest(algorithm, data);
      });
    try {
      await expect(putBrowserDraft(draft)).rejects.toThrow(
        "browser draft privacy guard unavailable",
      );
    } finally {
      digestSpy.mockRestore();
    }

    expect(digestCalls).toBe(2);
    expect(await getBrowserDraft(userId, draft.subjectKey)).toBeNull();
  });

  it("isolates records by user and subject key", async () => {
    await putBrowserDraft({
      userId: "u1",
      goalId: "g1",
      subjectKey: "goal:d1",
      body: "one",
      baseRevision: 1,
      updatedAt: new Date().toISOString(),
    });
    await putBrowserDraft({
      userId: "u2",
      goalId: "g1",
      subjectKey: "goal:d1",
      body: "two",
      baseRevision: 2,
      updatedAt: new Date().toISOString(),
    });
    expect((await getBrowserDraft("u1", "goal:d1"))?.body).toBe("one");
    expect((await getBrowserDraft("u2", "goal:d1"))?.body).toBe("two");
    await clearUserDrafts("u1");
    expect(await getBrowserDraft("u1", "goal:d1")).toBeNull();
    expect((await getBrowserDraft("u2", "goal:d1"))?.body).toBe("two");
  });

  it("expires recovery data after 24 hours", async () => {
    await putBrowserDraft({
      userId: "old",
      goalId: "g-old",
      subjectKey: "cycle:c1:plan",
      body: "old",
      baseRevision: 0,
      updatedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
    });
    expect(await getBrowserDraft("old", "cycle:c1:plan")).toBeNull();
  });

  it("expires a recovery record whose updatedAt is invalid", async () => {
    await putBrowserDraft({
      userId: "invalid-read-owner",
      goalId: "invalid-read-goal",
      subjectKey: "cycle:invalid-read-cycle:plan",
      body: "invalid timestamp record",
      baseRevision: 0,
      updatedAt: "not-an-instant",
    });

    expect(
      await getBrowserDraft(
        "invalid-read-owner",
        "cycle:invalid-read-cycle:plan",
      ),
    ).toBeNull();
  });

  it("preserves a fresh write queued after expired-record cleanup starts", async () => {
    const now = Date.parse("2026-09-06T12:00:00.000Z");
    const userId = "expired-cleanup-before-put-owner";
    const subjectKey = "cycle:expired-cleanup-before-put-cycle:plan";
    await putBrowserDraft({
      userId,
      goalId: "expired-cleanup-before-put-goal",
      subjectKey,
      body: "expired content",
      baseRevision: 0,
      updatedAt: new Date(now - 25 * 60 * 60 * 1000).toISOString(),
    });
    const freshDraft = {
      userId,
      goalId: "expired-cleanup-before-put-goal",
      subjectKey,
      body: "fresh concurrent content",
      baseRevision: 1,
      updatedAt: new Date(now).toISOString(),
    } as const;
    const interleaving = queueDraftWriteAfterNextDraftTransaction(freshDraft);
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      const [expiredResult] = await Promise.all([
        getBrowserDraft(userId, subjectKey),
        interleaving.writeCompleted,
      ]);
      expect(expiredResult).toBeNull();
      expect(await getBrowserDraft(userId, subjectKey)).toEqual(freshDraft);
    } finally {
      nowSpy.mockRestore();
      interleaving.restore();
    }
  });

  it("reads a fresh write queued before expired-record cleanup starts", async () => {
    const now = Date.parse("2026-09-06T13:00:00.000Z");
    const userId = "put-before-expired-cleanup-owner";
    const subjectKey = "cycle:put-before-expired-cleanup-cycle:plan";
    await putBrowserDraft({
      userId,
      goalId: "put-before-expired-cleanup-goal",
      subjectKey,
      body: "expired content",
      baseRevision: 0,
      updatedAt: new Date(now - 25 * 60 * 60 * 1000).toISOString(),
    });
    const freshDraft = {
      userId,
      goalId: "put-before-expired-cleanup-goal",
      subjectKey,
      body: "fresh content queued first",
      baseRevision: 1,
      updatedAt: new Date(now).toISOString(),
    } as const;
    const interleaving = queueDraftWriteBeforeNextDraftTransaction(freshDraft);
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      const [draft] = await Promise.all([
        getBrowserDraft(userId, subjectKey),
        interleaving.writeCompleted,
      ]);
      expect(draft).toEqual(freshDraft);
    } finally {
      nowSpy.mockRestore();
      interleaving.restore();
    }
  });

  it("rolls back expired-record deletion on abort and closes the database", async () => {
    const now = Date.parse("2026-09-06T14:00:00.000Z");
    const userId = "expired-cleanup-abort-owner";
    const subjectKey = "cycle:expired-cleanup-abort-cycle:plan";
    const expiredDraft = {
      userId,
      goalId: "expired-cleanup-abort-goal",
      subjectKey,
      body: "content retained after abort",
      baseRevision: 0,
      updatedAt: new Date(now - 25 * 60 * 60 * 1000).toISOString(),
    } as const;
    await putBrowserDraft(expiredDraft);
    const injected = abortNextExpiredDraftDeletion();
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      await expect(getBrowserDraft(userId, subjectKey)).rejects.toThrow(
        "browser draft read transaction aborted",
      );
      expect(injected.abortTriggered).toBe(true);
      expect(injected.closeSpy).toHaveBeenCalledOnce();
    } finally {
      nowSpy.mockRestore();
      injected.restore();
    }

    expect(await readStoredDraft(userId, subjectKey)).toEqual({
      ...expiredDraft,
      key: `${userId}:${subjectKey}`,
    });
  });

  it("rejects an asynchronous delete error after rollback and closes the database", async () => {
    const now = Date.parse("2026-09-06T14:30:00.000Z");
    const userId = "expired-cleanup-request-error-owner";
    const subjectKey = "cycle:expired-cleanup-request-error-cycle:plan";
    const expiredDraft = {
      userId,
      goalId: "expired-cleanup-request-error-goal",
      subjectKey,
      body: "content retained after request error",
      baseRevision: 0,
      updatedAt: new Date(now - 25 * 60 * 60 * 1000).toISOString(),
    } as const;
    await putBrowserDraft(expiredDraft);
    const injected = failNextExpiredDraftDeletion(expiredDraft);
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      await expect(getBrowserDraft(userId, subjectKey)).rejects.toMatchObject({
        name: "ConstraintError",
      });
      expect(injected.closeSpy).toHaveBeenCalledOnce();
    } finally {
      nowSpy.mockRestore();
      injected.restore();
    }

    expect(await readStoredDraft(userId, subjectKey)).toEqual({
      ...expiredDraft,
      key: `${userId}:${subjectKey}`,
    });
  });

  it("rejects transaction creation errors and closes the database", async () => {
    const injected = failNextDraftTransaction();
    try {
      await expect(
        getBrowserDraft("transaction-error-owner", "goal:transaction-error"),
      ).rejects.toThrow("injected transaction failure");
      expect(injected.closeSpy).toHaveBeenCalledOnce();
    } finally {
      injected.restore();
    }
  });

  it("clears only records owned by one goal", async () => {
    await putBrowserDraft({
      userId: "goal-owner",
      goalId: "g1",
      subjectKey: "cycle:c1:plan",
      body: "first",
      baseRevision: 0,
      updatedAt: new Date().toISOString(),
    });
    await putBrowserDraft({
      userId: "goal-owner",
      goalId: "g2",
      subjectKey: "cycle:c2:plan",
      body: "second",
      baseRevision: 0,
      updatedAt: new Date().toISOString(),
    });

    await clearGoalDrafts("goal-owner", "g1");

    expect(await getBrowserDraft("goal-owner", "cycle:c1:plan")).toBeNull();
    expect((await getBrowserDraft("goal-owner", "cycle:c2:plan"))?.body).toBe(
      "second",
    );

    const laterTerminalDraft = {
      userId: "goal-owner",
      goalId: "g1",
      subjectKey: "cycle:c1:plan",
      body: "ordinary terminal cleanup does not tombstone the goal",
      baseRevision: 1,
      updatedAt: new Date().toISOString(),
    } as const;
    await putBrowserDraft(laterTerminalDraft);
    expect(await getBrowserDraft("goal-owner", "cycle:c1:plan")).toEqual(
      laterTerminalDraft,
    );
  });

  it("preserves a newer recovery record when an old save finishes late", async () => {
    const userId = "conditional-owner";
    const subjectKey = "cycle:conditional-cycle:plan";
    const oldBody = "old in-flight value";
    const newerBody = "😀".repeat(201) + "\r\nnewer recovery";
    const oldUpdatedAt = new Date().toISOString();
    const newerUpdatedAt = new Date(Date.now() + 1).toISOString();
    await putBrowserDraft({
      userId,
      goalId: "conditional-goal",
      subjectKey,
      body: oldBody,
      baseRevision: 0,
      updatedAt: oldUpdatedAt,
    });
    await putBrowserDraft({
      userId,
      goalId: "conditional-goal",
      subjectKey,
      body: newerBody,
      baseRevision: 1,
      updatedAt: newerUpdatedAt,
    });

    await deleteBrowserDraftIfUnchanged(userId, subjectKey, oldBody, 0);

    expect(await getBrowserDraft(userId, subjectKey)).toEqual({
      userId,
      goalId: "conditional-goal",
      subjectKey,
      body: newerBody,
      baseRevision: 1,
      updatedAt: newerUpdatedAt,
    });

    await deleteBrowserDraftIfUnchanged(userId, subjectKey, newerBody, 0);
    expect((await getBrowserDraft(userId, subjectKey))?.body).toBe(newerBody);

    await deleteBrowserDraftIfUnchanged(userId, subjectKey, oldBody, 1);
    expect((await getBrowserDraft(userId, subjectKey))?.baseRevision).toBe(1);

    await deleteBrowserDraftIfUnchanged(userId, subjectKey, newerBody, 1);
    expect(await getBrowserDraft(userId, subjectKey)).toBeNull();

    await putBrowserDraft({
      userId,
      goalId: "conditional-goal",
      subjectKey,
      body: oldBody,
      baseRevision: 1,
      updatedAt: oldUpdatedAt,
    });
    const concurrentBody = newerBody + "\nconcurrent";
    const concurrentUpdatedAt = new Date(Date.now() + 2).toISOString();
    await Promise.all([
      deleteBrowserDraftIfUnchanged(userId, subjectKey, oldBody, 1),
      putBrowserDraft({
        userId,
        goalId: "conditional-goal",
        subjectKey,
        body: concurrentBody,
        baseRevision: 2,
        updatedAt: concurrentUpdatedAt,
      }),
    ]);
    expect(await getBrowserDraft(userId, subjectKey)).toEqual({
      userId,
      goalId: "conditional-goal",
      subjectKey,
      body: concurrentBody,
      baseRevision: 2,
      updatedAt: concurrentUpdatedAt,
    });
  });

  it("sweeps every expired record while preserving fresh records for every user", async () => {
    const now = Date.parse("2026-08-23T12:00:00.000Z");
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(now);
    const expiredAt = new Date(now - 25 * 60 * 60 * 1000).toISOString();
    const freshAt = new Date(now - 60 * 60 * 1000).toISOString();
    try {
      await putBrowserDraft({
        userId: "cleanup-owner",
        goalId: "cleanup-goal",
        subjectKey: "cycle:cleanup-cycle:plan",
        body: "expired owner record",
        baseRevision: 0,
        updatedAt: expiredAt,
      });
      await putBrowserDraft({
        userId: "cleanup-other",
        goalId: "cleanup-other-goal",
        subjectKey: "goal-draft:cleanup-other-draft",
        body: "expired other-user record",
        baseRevision: 2,
        updatedAt: expiredAt,
      });
      await putBrowserDraft({
        userId: "cleanup-owner",
        goalId: "cleanup-goal",
        subjectKey: "cycle:cleanup-cycle:do",
        body: "fresh owner record",
        baseRevision: 1,
        updatedAt: freshAt,
      });
      await putBrowserDraft({
        userId: "cleanup-other",
        goalId: null,
        subjectKey: "goal-draft:cleanup-fresh-draft",
        body: "fresh other-user record",
        baseRevision: 3,
        updatedAt: freshAt,
      });

      await cleanupExpiredBrowserDrafts();

      nowSpy.mockReturnValue(now - 48 * 60 * 60 * 1000);
      expect(
        await getBrowserDraft("cleanup-owner", "cycle:cleanup-cycle:plan"),
      ).toBeNull();
      expect(
        await getBrowserDraft(
          "cleanup-other",
          "goal-draft:cleanup-other-draft",
        ),
      ).toBeNull();

      nowSpy.mockReturnValue(now);
      expect(
        (await getBrowserDraft("cleanup-owner", "cycle:cleanup-cycle:do"))
          ?.body,
      ).toBe("fresh owner record");
      expect(
        (
          await getBrowserDraft(
            "cleanup-other",
            "goal-draft:cleanup-fresh-draft",
          )
        )?.body,
      ).toBe("fresh other-user record");
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("sweeps invalid timestamps while preserving a fresh valid record", async () => {
    const now = Date.parse("2026-08-23T12:00:00.000Z");
    const freshAt = new Date(now - 60 * 60 * 1000).toISOString();
    await putBrowserDraft({
      userId: "invalid-cleanup-owner",
      goalId: "invalid-cleanup-goal",
      subjectKey: "cycle:invalid-cleanup-cycle:plan",
      body: "invalid cleanup record",
      baseRevision: 0,
      updatedAt: "invalid-cleanup-instant",
    });
    await putBrowserDraft({
      userId: "invalid-cleanup-owner",
      goalId: "invalid-cleanup-goal",
      subjectKey: "cycle:invalid-cleanup-cycle:do",
      body: "fresh cleanup record",
      baseRevision: 1,
      updatedAt: freshAt,
    });

    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      await cleanupExpiredBrowserDrafts();

      const parseSpy = vi.spyOn(Date, "parse").mockReturnValue(now);
      try {
        expect(
          await getBrowserDraft(
            "invalid-cleanup-owner",
            "cycle:invalid-cleanup-cycle:plan",
          ),
        ).toBeNull();
        expect(
          (
            await getBrowserDraft(
              "invalid-cleanup-owner",
              "cycle:invalid-cleanup-cycle:do",
            )
          )?.body,
        ).toBe("fresh cleanup record");
      } finally {
        parseSpy.mockRestore();
      }
    } finally {
      nowSpy.mockRestore();
    }
  });
});

function readAccountDeletionPrivacyRecords(): Promise<{
  readonly tombstones: readonly Record<string, unknown>[];
  readonly metadata: readonly Record<string, unknown>[];
}> {
  return new Promise((resolve, reject) => {
    const openRequest = indexedDB.open("fukamu-cycle-browser-drafts-v2", 3);
    openRequest.onerror = () => reject(openRequest.error);
    openRequest.onsuccess = () => {
      const database = openRequest.result;
      const transaction = database.transaction([
        "account-deletion-tombstones",
        "metadata",
      ]);
      const tombstonesRequest = transaction
        .objectStore("account-deletion-tombstones")
        .getAll();
      const metadataRequest = transaction.objectStore("metadata").getAll();
      const closeAndReject = () => {
        database.close();
        reject(transaction.error);
      };
      transaction.oncomplete = () => {
        database.close();
        resolve({
          tombstones: tombstonesRequest.result as readonly Record<
            string,
            unknown
          >[],
          metadata: metadataRequest.result as readonly Record<
            string,
            unknown
          >[],
        });
      };
      transaction.onerror = closeAndReject;
      transaction.onabort = closeAndReject;
    };
  });
}

const browserDraftDatabaseName = "fukamu-cycle-browser-drafts-v2";
const browserDraftDatabaseVersion = 3;
const browserDraftStoreName = "drafts";
const accountDeletionTombstoneStoreName = "account-deletion-tombstones";
const goalDeletionTombstoneStoreName = "goal-deletion-tombstones";
const metadataStoreName = "metadata";
const accountDeletionSaltKey = "account-deletion-salt-v1";
const fixedAccountDeletionSalt =
  "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
const fixedAccountDeletionDigest =
  "1bbbe67328ca265561b513bccc9bfa954c172f93adadab1c48a39a1b92f843eb";
const fixedGoalDeletionDigest =
  "cd2ae0c4f33912a769d459770604713a3e3670191564585ea9239bebd1c8e578";

type DraftTransactionInterleaving = {
  readonly writeCompleted: Promise<void>;
  readonly restore: () => void;
};

function queueDraftWriteAfterNextDraftTransaction(
  draft: BrowserDraftFixture,
): DraftTransactionInterleaving {
  return arrangeNextDraftTransaction((originalTransaction, args) => {
    const requested = callTransaction(originalTransaction, args);
    const write = originalTransaction(browserDraftStoreName, "readwrite");
    write.objectStore(browserDraftStoreName).put(storedFixture(draft));
    return { requested, write };
  });
}

function queueDraftWriteBeforeNextDraftTransaction(
  draft: BrowserDraftFixture,
): DraftTransactionInterleaving {
  return arrangeNextDraftTransaction((originalTransaction, args) => {
    const write = originalTransaction(browserDraftStoreName, "readwrite");
    write.objectStore(browserDraftStoreName).put(storedFixture(draft));
    return {
      requested: callTransaction(originalTransaction, args),
      write,
    };
  });
}

type BrowserDraftFixture = {
  readonly userId: string;
  readonly goalId: string | null;
  readonly subjectKey: string;
  readonly body: string;
  readonly baseRevision: number;
  readonly updatedAt: string;
};

function draftFixture(
  userId: string,
  goalId: string,
  subjectKey: string,
  body: string,
): BrowserDraftFixture {
  return {
    userId,
    goalId,
    subjectKey,
    body,
    baseRevision: 0,
    updatedAt: new Date().toISOString(),
  };
}

async function resetAsLegacyV2Database(
  options: {
    readonly accountDeletionDigests?: readonly string[];
    readonly drafts?: readonly BrowserDraftFixture[];
  } = {},
): Promise<IDBDatabase> {
  await deleteDraftDatabase();
  return new Promise((resolve, reject) => {
    const openRequest = indexedDB.open(browserDraftDatabaseName, 2);
    openRequest.onupgradeneeded = () => {
      const database = openRequest.result;
      database.createObjectStore(browserDraftStoreName, { keyPath: "key" });
      database.createObjectStore(accountDeletionTombstoneStoreName, {
        keyPath: "digest",
      });
      database.createObjectStore(metadataStoreName, { keyPath: "key" });
    };
    openRequest.onerror = () => reject(openRequest.error);
    openRequest.onsuccess = () => {
      const database = openRequest.result;
      const transaction = database.transaction(
        [
          browserDraftStoreName,
          accountDeletionTombstoneStoreName,
          metadataStoreName,
        ],
        "readwrite",
      );
      transaction.objectStore(metadataStoreName).put({
        key: accountDeletionSaltKey,
        value: fixedAccountDeletionSalt,
      });
      const accountTombstones = transaction.objectStore(
        accountDeletionTombstoneStoreName,
      );
      for (const digest of options.accountDeletionDigests ?? []) {
        accountTombstones.put({ digest });
      }
      const drafts = transaction.objectStore(browserDraftStoreName);
      for (const draft of options.drafts ?? []) {
        drafts.put(storedFixture(draft));
      }
      transaction.oncomplete = () => resolve(database);
      const closeAndReject = () => {
        database.close();
        reject(transaction.error);
      };
      transaction.onerror = closeAndReject;
      transaction.onabort = closeAndReject;
    };
  });
}

function deleteDraftDatabase(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(browserDraftDatabaseName);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () =>
      reject(new Error("test database deletion was blocked"));
  });
}

function readDraftDatabaseSchema(): Promise<{
  readonly version: number;
  readonly stores: readonly string[];
  readonly goalDeletionIndexes: readonly string[];
}> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(browserDraftDatabaseName);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction(goalDeletionTombstoneStoreName);
      const goalDeletionTombstones = transaction.objectStore(
        goalDeletionTombstoneStoreName,
      );
      const schema = {
        version: database.version,
        stores: [...database.objectStoreNames],
        goalDeletionIndexes: [...goalDeletionTombstones.indexNames],
      };
      transaction.oncomplete = () => {
        database.close();
        resolve(schema);
      };
      const closeAndReject = () => {
        database.close();
        reject(transaction.error);
      };
      transaction.onerror = closeAndReject;
      transaction.onabort = closeAndReject;
    };
  });
}

function openLegacyV2Writer(): Promise<string> {
  return new Promise((resolve) => {
    const request = indexedDB.open(browserDraftDatabaseName, 2);
    request.onerror = () => resolve(request.error?.name ?? "UnknownError");
    request.onsuccess = () => {
      request.result.close();
      resolve("opened");
    };
  });
}

function waitForCurrentDatabaseOpenToSettle(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(browserDraftDatabaseName);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      request.result.close();
      resolve();
    };
  });
}

function readGoalDeletionPrivacyRecords(): Promise<
  readonly Record<string, string>[]
> {
  return readDeletionPrivacyRecords().then((records) => records.goalTombstones);
}

function readDeletionPrivacyRecords(): Promise<{
  readonly accountTombstones: readonly Record<string, string>[];
  readonly goalTombstones: readonly Record<string, string>[];
  readonly metadata: readonly Record<string, string>[];
}> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(
      browserDraftDatabaseName,
      browserDraftDatabaseVersion,
    );
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction([
        accountDeletionTombstoneStoreName,
        goalDeletionTombstoneStoreName,
        metadataStoreName,
      ]);
      const accountTombstones = transaction
        .objectStore(accountDeletionTombstoneStoreName)
        .getAll();
      const goalTombstones = transaction
        .objectStore(goalDeletionTombstoneStoreName)
        .getAll();
      const metadata = transaction.objectStore(metadataStoreName).getAll();
      transaction.oncomplete = () => {
        database.close();
        resolve({
          accountTombstones: accountTombstones.result as readonly Record<
            string,
            string
          >[],
          goalTombstones: goalTombstones.result as readonly Record<
            string,
            string
          >[],
          metadata: metadata.result as readonly Record<string, string>[],
        });
      };
      const closeAndReject = () => {
        database.close();
        reject(transaction.error);
      };
      transaction.onerror = closeAndReject;
      transaction.onabort = closeAndReject;
    };
  });
}

async function accountDigestFixture(userId: string): Promise<string> {
  const records = await readDeletionPrivacyRecords();
  const metadata = records.metadata.find(
    (record) => record.key === accountDeletionSaltKey,
  );
  if (metadata === undefined) throw new Error("account deletion salt missing");
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${metadata.value}:${userId}`),
  );
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

type TransactionArguments = Parameters<IDBDatabase["transaction"]>;
type BoundTransaction = (
  storeNames: string | Iterable<string>,
  mode?: IDBTransactionMode,
  options?: IDBTransactionOptions,
) => IDBTransaction;

function arrangeNextDraftTransaction(
  arrange: (
    originalTransaction: BoundTransaction,
    args: TransactionArguments,
  ) => { readonly requested: IDBTransaction; readonly write: IDBTransaction },
): DraftTransactionInterleaving {
  const originalOpen = indexedDB.open.bind(indexedDB);
  const openSpy = vi
    .spyOn(indexedDB, "open")
    .mockImplementation((name, version) =>
      version === undefined ? originalOpen(name) : originalOpen(name, version),
    );
  let resolveWrite!: () => void;
  let rejectWrite!: (reason: unknown) => void;
  const writeCompleted = new Promise<void>((resolve, reject) => {
    resolveWrite = resolve;
    rejectWrite = reject;
  });
  let transactionSpy: ReturnType<typeof vi.spyOn> | undefined;
  let arranged = false;
  openSpy.mockImplementation((name, version) => {
    const request =
      version === undefined ? originalOpen(name) : originalOpen(name, version);
    if (name !== browserDraftDatabaseName) return request;
    request.addEventListener("success", () => {
      const database = request.result;
      const originalTransaction = database.transaction.bind(database);
      transactionSpy = vi.spyOn(database, "transaction");
      transactionSpy.mockImplementation((...args: TransactionArguments) => {
        if (arranged || !includesDraftStore(args[0])) {
          return callTransaction(originalTransaction, args);
        }
        arranged = true;
        const transactions = arrange(originalTransaction, args);
        transactions.write.oncomplete = () => resolveWrite();
        transactions.write.onerror = () =>
          rejectWrite(transactions.write.error);
        transactions.write.onabort = () =>
          rejectWrite(transactions.write.error);
        return transactions.requested;
      });
    });
    return request;
  });
  return {
    writeCompleted,
    restore: () => {
      transactionSpy?.mockRestore();
      openSpy.mockRestore();
    },
  };
}

function observeDraftPrivacyTransactions(): {
  readonly draftTransactions: readonly {
    readonly mode: IDBTransactionMode;
    readonly stores: readonly string[];
  }[];
  readonly restore: () => void;
} {
  const draftTransactions: {
    readonly mode: IDBTransactionMode;
    readonly stores: readonly string[];
  }[] = [];
  const injection = interceptNextDraftDatabase((database) => {
    const originalTransaction = database.transaction.bind(database);
    const transactionSpy = vi.spyOn(database, "transaction");
    transactionSpy.mockImplementation((...args: TransactionArguments) => {
      const transaction = callTransaction(originalTransaction, args);
      if (includesDraftStore(args[0])) {
        draftTransactions.push({
          mode: args[1] ?? "readonly",
          stores: normalizedStoreNames(args[0]),
        });
      }
      return transaction;
    });
    return transactionSpy;
  });
  return {
    draftTransactions,
    restore: injection.restore,
  };
}

function captureModuleOpenedDatabase(): {
  readonly database: IDBDatabase | undefined;
  readonly restore: () => void;
} {
  const originalOpen = indexedDB.open.bind(indexedDB);
  const openSpy = vi.spyOn(indexedDB, "open");
  let database: IDBDatabase | undefined;
  openSpy.mockImplementation((name, version) => {
    const request =
      version === undefined ? originalOpen(name) : originalOpen(name, version);
    if (name === browserDraftDatabaseName) {
      request.addEventListener("success", () => {
        database = request.result;
      });
    }
    return request;
  });
  return {
    get database() {
      return database;
    },
    restore: () => {
      database?.close();
      openSpy.mockRestore();
    },
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function abortNextExpiredDraftDeletion(): {
  readonly closeSpy: ReturnType<typeof vi.spyOn>;
  readonly abortTriggered: boolean;
  readonly restore: () => void;
} {
  let abortTriggered = false;
  const injection = interceptNextDraftDatabase((database) => {
    const originalTransaction = database.transaction.bind(database);
    const transactionSpy = vi.spyOn(database, "transaction");
    let intercepted = false;
    transactionSpy.mockImplementation((...args: TransactionArguments) => {
      const transaction = callTransaction(originalTransaction, args);
      if (intercepted || !includesDraftStore(args[0])) return transaction;
      intercepted = true;
      const originalObjectStore = transaction.objectStore.bind(transaction);
      vi.spyOn(transaction, "objectStore").mockImplementation((name) => {
        const store = originalObjectStore(name);
        const originalDelete = store.delete.bind(store);
        vi.spyOn(store, "delete").mockImplementation((query) => {
          const request = originalDelete(query);
          request.addEventListener(
            "success",
            () => {
              abortTriggered = true;
              transaction.abort();
            },
            { once: true },
          );
          return request;
        });
        return store;
      });
      return transaction;
    });
    return transactionSpy;
  });
  return {
    get closeSpy() {
      return injection.closeSpy;
    },
    get abortTriggered() {
      return abortTriggered;
    },
    restore: injection.restore,
  };
}

function abortNextGoalDeletionTransaction(): {
  readonly closeSpy: ReturnType<typeof vi.spyOn>;
  readonly abortTriggered: boolean;
  readonly restore: () => void;
} {
  let abortTriggered = false;
  const injection = interceptNextDraftDatabase((database) => {
    const originalTransaction = database.transaction.bind(database);
    const transactionSpy = vi.spyOn(database, "transaction");
    let intercepted = false;
    transactionSpy.mockImplementation((...args: TransactionArguments) => {
      const transaction = callTransaction(originalTransaction, args);
      if (intercepted || !includesGoalDeletionStore(args[0])) {
        return transaction;
      }
      intercepted = true;
      const originalObjectStore = transaction.objectStore.bind(transaction);
      vi.spyOn(transaction, "objectStore").mockImplementation((name) => {
        const store = originalObjectStore(name);
        if (name !== goalDeletionTombstoneStoreName) return store;
        const originalPut = store.put.bind(store);
        vi.spyOn(store, "put").mockImplementation((value) => {
          const request = originalPut(value);
          request.addEventListener(
            "success",
            () => {
              abortTriggered = true;
              transaction.abort();
            },
            { once: true },
          );
          return request;
        });
        return store;
      });
      return transaction;
    });
    return transactionSpy;
  });
  return {
    get closeSpy() {
      return injection.closeSpy;
    },
    get abortTriggered() {
      return abortTriggered;
    },
    restore: injection.restore,
  };
}

function abortNextAccountDeletionGoalTombstoneCleanup(): {
  readonly closeSpy: ReturnType<typeof vi.spyOn>;
  readonly abortTriggered: boolean;
  readonly restore: () => void;
} {
  let abortTriggered = false;
  const injection = interceptNextDraftDatabase((database) => {
    const originalTransaction = database.transaction.bind(database);
    const transactionSpy = vi.spyOn(database, "transaction");
    let intercepted = false;
    transactionSpy.mockImplementation((...args: TransactionArguments) => {
      const transaction = callTransaction(originalTransaction, args);
      if (intercepted || !includesGoalDeletionStore(args[0])) {
        return transaction;
      }
      intercepted = true;
      const originalObjectStore = transaction.objectStore.bind(transaction);
      vi.spyOn(transaction, "objectStore").mockImplementation((name) => {
        const store = originalObjectStore(name);
        if (name !== goalDeletionTombstoneStoreName) return store;
        const originalDelete = store.delete.bind(store);
        vi.spyOn(store, "delete").mockImplementation((query) => {
          const request = originalDelete(query);
          request.addEventListener(
            "success",
            () => {
              abortTriggered = true;
              transaction.abort();
            },
            { once: true },
          );
          return request;
        });
        return store;
      });
      return transaction;
    });
    return transactionSpy;
  });
  return {
    get closeSpy() {
      return injection.closeSpy;
    },
    get abortTriggered() {
      return abortTriggered;
    },
    restore: injection.restore,
  };
}

function failNextExpiredDraftDeletion(draft: BrowserDraftFixture): {
  readonly closeSpy: ReturnType<typeof vi.spyOn>;
  readonly restore: () => void;
} {
  return interceptNextDraftDatabase((database) => {
    const originalTransaction = database.transaction.bind(database);
    const transactionSpy = vi.spyOn(database, "transaction");
    let intercepted = false;
    transactionSpy.mockImplementation((...args: TransactionArguments) => {
      const transaction = callTransaction(originalTransaction, args);
      if (intercepted || !includesDraftStore(args[0])) return transaction;
      intercepted = true;
      const originalObjectStore = transaction.objectStore.bind(transaction);
      vi.spyOn(transaction, "objectStore").mockImplementation((name) => {
        const store = originalObjectStore(name);
        const originalAdd = store.add.bind(store);
        vi.spyOn(store, "delete").mockImplementation(
          () =>
            originalAdd(
              storedFixture(draft),
            ) as unknown as IDBRequest<undefined>,
        );
        return store;
      });
      return transaction;
    });
    return transactionSpy;
  });
}

function failNextDraftTransaction(): {
  readonly closeSpy: ReturnType<typeof vi.spyOn>;
  readonly restore: () => void;
} {
  return interceptNextDraftDatabase((database) =>
    vi.spyOn(database, "transaction").mockImplementation(() => {
      throw new Error("injected transaction failure");
    }),
  );
}

function interceptNextDraftDatabase(
  intercept: (database: IDBDatabase) => { mockRestore: () => void },
): {
  readonly closeSpy: ReturnType<typeof vi.spyOn>;
  readonly restore: () => void;
} {
  const originalOpen = indexedDB.open.bind(indexedDB);
  const openSpy = vi.spyOn(indexedDB, "open");
  let operationSpy: { mockRestore: () => void } | undefined;
  let closeSpy: ReturnType<typeof vi.spyOn> | undefined;
  let openedDatabase: IDBDatabase | undefined;
  openSpy.mockImplementation((name, version) => {
    const request =
      version === undefined ? originalOpen(name) : originalOpen(name, version);
    if (name !== browserDraftDatabaseName) return request;
    request.addEventListener("success", () => {
      openedDatabase = request.result;
      closeSpy = vi.spyOn(request.result, "close");
      operationSpy = intercept(request.result);
    });
    return request;
  });
  return {
    get closeSpy() {
      if (closeSpy === undefined) throw new Error("database did not open");
      return closeSpy;
    },
    restore: () => {
      operationSpy?.mockRestore();
      closeSpy?.mockRestore();
      openedDatabase?.close();
      openSpy.mockRestore();
    },
  };
}

function callTransaction(
  transaction: BoundTransaction,
  args: TransactionArguments,
): IDBTransaction {
  const [storeNames, mode, options] = args;
  if (options !== undefined) return transaction(storeNames, mode, options);
  if (mode !== undefined) return transaction(storeNames, mode);
  return transaction(storeNames);
}

function includesDraftStore(storeNames: string | Iterable<string>): boolean {
  return typeof storeNames === "string"
    ? storeNames === browserDraftStoreName
    : [...storeNames].includes(browserDraftStoreName);
}

function normalizedStoreNames(
  storeNames: string | Iterable<string>,
): readonly string[] {
  return (
    typeof storeNames === "string" ? [storeNames] : [...storeNames]
  ).sort();
}

function includesGoalDeletionStore(
  storeNames: string | Iterable<string>,
): boolean {
  return typeof storeNames === "string"
    ? storeNames === goalDeletionTombstoneStoreName
    : [...storeNames].includes(goalDeletionTombstoneStoreName);
}

function storedFixture(draft: BrowserDraftFixture): BrowserDraftFixture & {
  readonly key: string;
} {
  return { ...draft, key: `${draft.userId}:${draft.subjectKey}` };
}

function readStoredDraft(
  userId: string,
  subjectKey: string,
): Promise<Record<string, unknown> | undefined> {
  return new Promise((resolve, reject) => {
    const openRequest = indexedDB.open(
      browserDraftDatabaseName,
      browserDraftDatabaseVersion,
    );
    openRequest.onerror = () => reject(openRequest.error);
    openRequest.onsuccess = () => {
      const database = openRequest.result;
      const transaction = database.transaction(browserDraftStoreName);
      const request = transaction
        .objectStore(browserDraftStoreName)
        .get(`${userId}:${subjectKey}`);
      transaction.oncomplete = () => {
        database.close();
        resolve(request.result as Record<string, unknown> | undefined);
      };
      const closeAndReject = () => {
        database.close();
        reject(transaction.error);
      };
      transaction.onerror = closeAndReject;
      transaction.onabort = closeAndReject;
    };
  });
}
