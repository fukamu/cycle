import {
  clearGoalDrafts,
  clearUserDrafts,
  getBrowserDraft,
  putBrowserDraft,
} from "./browserDraftCache";

describe("browser draft cache", () => {
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
  });
});
