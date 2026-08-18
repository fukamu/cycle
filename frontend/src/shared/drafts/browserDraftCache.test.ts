import {
  clearUserDrafts,
  getBrowserDraft,
  putBrowserDraft,
} from "./browserDraftCache";

describe("browser draft cache", () => {
  it("isolates records by user and subject key", async () => {
    await putBrowserDraft({
      userId: "u1",
      subjectKey: "goal:d1",
      body: "one",
      baseRevision: 1,
      updatedAt: new Date().toISOString(),
    });
    await putBrowserDraft({
      userId: "u2",
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
      subjectKey: "cycle:c1:plan",
      body: "old",
      baseRevision: 0,
      updatedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
    });
    expect(await getBrowserDraft("old", "cycle:c1:plan")).toBeNull();
  });
});
