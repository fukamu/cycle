import { QueryClient } from "@tanstack/react-query";

import { userQueryKeys } from "../goal-collection";
import {
  SessionIdentityError,
  type AuthenticatedRequestLease,
} from "../../shared/api/client";
import type {
  Cycle,
  Goal,
  GoalDraft,
  GoalReview,
} from "../../shared/api/schemas";
import { getReview } from "../../shared/api/workspace";
import { goalReviewQueryOptions } from "./goalReviewQueryOptions";

vi.mock("../../shared/api/workspace", () => ({ getReview: vi.fn() }));

const userId = "10000000-0000-7000-8000-000000000001";
const goalId = "20000000-0000-7000-8000-000000000001";
const version = {
  id: "30000000-0000-7000-8000-000000000001",
  versionNumber: 1,
  body: "現在の目標",
  createdAt: "2026-08-20T00:00:00.000Z",
} as const;

function reviewGeneration({
  goalRevision,
  draftId,
  draftRevision,
  cycleId,
  sequenceNumber,
}: {
  readonly goalRevision: number;
  readonly draftId: string;
  readonly draftRevision: number;
  readonly cycleId: string;
  readonly sequenceNumber: number;
}): GoalReview {
  const goal: Goal = {
    id: goalId,
    status: "goal_review",
    revision: goalRevision,
    currentVersion: version,
    currentWork: {
      kind: "goal_review",
      reviewDraftId: draftId,
      triggerCycleId: cycleId,
      triggerCycleSequenceNumber: sequenceNumber,
    },
    nextCycleSequenceNumber: sequenceNumber + 1,
    cycleCount: sequenceNumber,
    createdAt: "2026-08-20T00:00:00.000Z",
    terminalAt: null,
  };
  const reviewDraft: GoalDraft = {
    id: draftId,
    draftType: "review",
    goalId,
    baseGoalVersionId: version.id,
    reviewCycleId: cycleId,
    body: `Review ${draftId}`,
    revision: draftRevision,
    updatedAt: "2026-08-20T01:00:00.000Z",
  };
  const triggerCycle: Cycle = {
    id: cycleId,
    goalId,
    sequenceNumber,
    status: "completed",
    goalVersion: version,
    startedAt: "2026-08-20T00:00:00.000Z",
    completedAt: "2026-08-20T01:00:00.000Z",
    canceledAt: null,
    cancellationReason: null,
    plan: "計画",
    do: "実行",
    check: "評価",
    action: "改善",
    contentRevision: 4,
    frameRevisions: { plan: 1, do: 1, check: 1, action: 1 },
  };
  return { goal, reviewDraft, triggerCycle };
}

const reviewA = reviewGeneration({
  goalRevision: 2,
  draftId: "40000000-0000-7000-8000-000000000001",
  draftRevision: 2,
  cycleId: "50000000-0000-7000-8000-000000000001",
  sequenceNumber: 1,
});
const reviewB = reviewGeneration({
  goalRevision: 4,
  draftId: "40000000-0000-7000-8000-000000000002",
  draftRevision: 0,
  cycleId: "50000000-0000-7000-8000-000000000002",
  sequenceNumber: 2,
});

function currentLease(): AuthenticatedRequestLease {
  return {
    expectedUserId: userId,
    signal: new AbortController().signal,
    isCurrent: () => true,
  };
}

function createCache(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const runRequest = <Result>(request: () => Promise<Result>) => request();

describe("goalReviewQueryOptions", () => {
  beforeEach(() => vi.clearAllMocks());

  it("isolates each route mount under a nested transport key", () => {
    const lease = currentLease();

    expect(
      goalReviewQueryOptions(userId, goalId, "entry-a", lease, runRequest)
        .queryKey,
    ).toEqual(userQueryKeys.reviewTransport(userId, goalId, "entry-a"));
    expect(
      goalReviewQueryOptions(userId, goalId, "entry-b", lease, runRequest)
        .queryKey,
    ).toEqual(userQueryKeys.reviewTransport(userId, goalId, "entry-b"));
  });

  it("publishes and returns an accepted Review snapshot", async () => {
    vi.mocked(getReview).mockResolvedValueOnce(reviewA);
    const cache = createCache();
    const options = goalReviewQueryOptions(
      userId,
      goalId,
      "entry-accept",
      currentLease(),
      runRequest,
    );

    await expect(cache.fetchQuery(options)).resolves.toBe(reviewA);
    expect(cache.getQueryData(userQueryKeys.review(userId, goalId))).toBe(
      reviewA,
    );
    expect(cache.getQueryData(userQueryKeys.goal(userId, goalId))).toEqual({
      goal: reviewA.goal,
    });
    expect(cache.getQueryData(options.queryKey)).toBe(reviewA);
  });

  it("returns the canonical Review without freshening its live cache for a late payload", async () => {
    vi.mocked(getReview).mockResolvedValueOnce(reviewA);
    const cache = createCache();
    const goalKey = userQueryKeys.goal(userId, goalId);
    const reviewKey = userQueryKeys.review(userId, goalId);
    cache.setQueryData(goalKey, { goal: reviewB.goal }, { updatedAt: 1_000 });
    cache.setQueryData(reviewKey, reviewB, { updatedAt: 2_000 });
    const before = cache.getQueryState(reviewKey);
    const options = goalReviewQueryOptions(
      userId,
      goalId,
      "entry-preserve",
      currentLease(),
      runRequest,
    );

    await expect(cache.fetchQuery(options)).resolves.toBe(reviewB);
    expect(cache.getQueryData(reviewKey)).toBe(reviewB);
    expect(cache.getQueryState(reviewKey)?.dataUpdatedAt).toBe(
      before?.dataUpdatedAt,
    );
    expect(cache.getQueryState(reviewKey)?.dataUpdateCount).toBe(
      before?.dataUpdateCount,
    );
    expect(cache.getQueryData(options.queryKey)).toBe(reviewB);
  });

  it("returns raw transport data without publishing over a moved workspace", async () => {
    vi.mocked(getReview).mockResolvedValueOnce(reviewA);
    const cache = createCache();
    const activeGoal: Goal = {
      ...reviewA.goal,
      status: "active_cycle",
      revision: reviewA.goal.revision + 1,
      currentWork: {
        kind: "active_cycle",
        cycleId: "50000000-0000-7000-8000-000000000009",
        cycleSequenceNumber: 2,
      },
    };
    const goalKey = userQueryKeys.goal(userId, goalId);
    const reviewKey = userQueryKeys.review(userId, goalId);
    cache.setQueryData(goalKey, { goal: activeGoal }, { updatedAt: 1_000 });
    cache.setQueryData(reviewKey, reviewA, { updatedAt: 2_000 });
    const before = cache.getQueryState(reviewKey);
    const options = goalReviewQueryOptions(
      userId,
      goalId,
      "entry-moved",
      currentLease(),
      runRequest,
    );

    await expect(cache.fetchQuery(options)).resolves.toBe(reviewA);
    expect(cache.getQueryData(goalKey)).toEqual({ goal: activeGoal });
    expect(cache.getQueryData(reviewKey)).toBe(reviewA);
    expect(cache.getQueryState(reviewKey)?.dataUpdatedAt).toBe(
      before?.dataUpdatedAt,
    );
    expect(cache.getQueryState(reviewKey)?.dataUpdateCount).toBe(
      before?.dataUpdateCount,
    );
  });

  it("returns raw transport data and fails closed on an invariant conflict", async () => {
    const conflicting = reviewGeneration({
      goalRevision: reviewA.goal.revision,
      draftId: reviewB.reviewDraft.id,
      draftRevision: 0,
      cycleId: reviewB.triggerCycle.id,
      sequenceNumber: reviewB.triggerCycle.sequenceNumber,
    });
    vi.mocked(getReview).mockResolvedValueOnce(conflicting);
    const cache = createCache();
    const reviewKey = userQueryKeys.review(userId, goalId);
    cache.setQueryData(reviewKey, reviewA, { updatedAt: 2_000 });
    const before = cache.getQueryState(reviewKey);
    const options = goalReviewQueryOptions(
      userId,
      goalId,
      "entry-invariant",
      currentLease(),
      runRequest,
    );

    await expect(cache.fetchQuery(options)).resolves.toBe(conflicting);
    expect(cache.getQueryData(reviewKey)).toBe(reviewA);
    expect(cache.getQueryState(reviewKey)?.dataUpdatedAt).toBe(
      before?.dataUpdatedAt,
    );
    expect(cache.getQueryData(options.queryKey)).toBe(conflicting);
  });

  it("does not publish after the authenticated lease becomes stale", async () => {
    const response = deferred<GoalReview>();
    let current = true;
    const lease: AuthenticatedRequestLease = {
      expectedUserId: userId,
      signal: new AbortController().signal,
      isCurrent: () => current,
    };
    vi.mocked(getReview).mockReturnValueOnce(response.promise);
    const cache = createCache();
    const request = cache.fetchQuery(
      goalReviewQueryOptions(userId, goalId, "entry-stale", lease, runRequest),
    );

    current = false;
    response.resolve(reviewA);

    await expect(request).rejects.toBeInstanceOf(SessionIdentityError);
    expect(
      cache.getQueryData(userQueryKeys.review(userId, goalId)),
    ).toBeUndefined();
    expect(
      cache.getQueryData(userQueryKeys.goal(userId, goalId)),
    ).toBeUndefined();
  });

  it("does not publish after its transport query is aborted", async () => {
    const response = deferred<GoalReview>();
    vi.mocked(getReview).mockReturnValueOnce(response.promise);
    const cache = createCache();
    const options = goalReviewQueryOptions(
      userId,
      goalId,
      "entry-aborted",
      currentLease(),
      runRequest,
    );
    const request = cache.fetchQuery(options);

    await cache.cancelQueries({ queryKey: options.queryKey, exact: true });
    response.resolve(reviewA);
    await request.catch(() => undefined);
    await Promise.resolve();

    expect(
      cache.getQueryData(userQueryKeys.review(userId, goalId)),
    ).toBeUndefined();
    expect(
      cache.getQueryData(userQueryKeys.goal(userId, goalId)),
    ).toBeUndefined();
  });
});
