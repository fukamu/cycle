import { renderHook } from "@testing-library/react";

import { APIError } from "../api/client";
import { isUUIDv7 } from "../id/uuid";
import { commandFingerprint, useCommandOperation } from "./useCommandOperation";

const requestId = "00000000-0000-7000-8000-000000000001";

describe("useCommandOperation", () => {
  it("reuses one operation ID after ambiguous response loss", async () => {
    const { result } = renderHook(() => useCommandOperation());
    const fingerprint = commandFingerprint("complete_cycle", {
      cycleId: "cycle-1",
      expectedContentRevision: 4,
      expectedGoalRevision: 2,
      goalId: "goal-1",
    });
    const seen: string[] = [];

    for (const failure of [
      new TypeError("response lost"),
      new Error("response schema was invalid"),
      new APIError(
        502,
        "INVALID_ERROR_RESPONSE",
        "invalid response",
        "unknown",
      ),
    ]) {
      await expect(
        result.current.invoke(fingerprint, async (operationId) => {
          seen.push(operationId);
          throw failure;
        }),
      ).rejects.toBe(failure);
    }

    expect(seen).toHaveLength(3);
    expect(isUUIDv7(seen[0] ?? "")).toBe(true);
    expect(new Set(seen).size).toBe(1);
  });

  it("retains the operation while the server reports it is running", async () => {
    const { result } = renderHook(() => useCommandOperation());
    const fingerprint = commandFingerprint("goal_refine", {
      draftId: "draft-1",
      expectedDraftRevision: 0,
    });
    const seen: string[] = [];
    const running = new APIError(
      409,
      "AI_OPERATION_IN_PROGRESS",
      "running",
      requestId,
    );

    await expect(
      result.current.invoke(fingerprint, async (operationId) => {
        seen.push(operationId);
        throw running;
      }),
    ).rejects.toBe(running);
    await result.current.invoke(fingerprint, async (operationId) => {
      seen.push(operationId);
      return "replayed";
    });

    expect(seen[1]).toBe(seen[0]);
  });

  it("rotates after success, changed input, definitive failure, or abandonment", async () => {
    const { result } = renderHook(() => useCommandOperation());
    const firstFingerprint = commandFingerprint("action_generate", {
      confirmReplace: false,
      cycleId: "cycle-1",
      expectedContentRevision: 3,
      goalId: "goal-1",
    });
    const changedFingerprint = commandFingerprint("action_generate", {
      confirmReplace: true,
      cycleId: "cycle-1",
      expectedContentRevision: 3,
      goalId: "goal-1",
    });
    const ids: string[] = [];

    await result.current.invoke(firstFingerprint, async (operationId) => {
      ids.push(operationId);
      return "success";
    });
    await expect(
      result.current.invoke(firstFingerprint, async (operationId) => {
        ids.push(operationId);
        throw new TypeError("response lost");
      }),
    ).rejects.toBeInstanceOf(TypeError);
    await expect(
      result.current.invoke(changedFingerprint, async (operationId) => {
        ids.push(operationId);
        throw new APIError(
          503,
          "AI_PROVIDER_UNAVAILABLE",
          "unavailable",
          requestId,
        );
      }),
    ).rejects.toBeInstanceOf(APIError);
    await result.current.invoke(changedFingerprint, async (operationId) => {
      ids.push(operationId);
      return "new attempt after a definitive failure";
    });
    await expect(
      result.current.invoke(changedFingerprint, async (operationId) => {
        ids.push(operationId);
        throw new TypeError("response lost");
      }),
    ).rejects.toBeInstanceOf(TypeError);
    result.current.abandon();
    await result.current.invoke(changedFingerprint, async (operationId) => {
      ids.push(operationId);
      return "new attempt after abandonment";
    });

    expect(new Set(ids).size).toBe(ids.length);
  });

  it("does not let an older late completion clear a newer operation", async () => {
    const { result } = renderHook(() => useCommandOperation());
    const oldFingerprint = commandFingerprint("action_refine", {
      cycleId: "cycle-1",
      expectedContentRevision: 3,
      goalId: "goal-1",
    });
    const newFingerprint = commandFingerprint("action_refine", {
      cycleId: "cycle-1",
      expectedContentRevision: 4,
      goalId: "goal-1",
    });
    let finishOld: ((value: string) => void) | undefined;
    let oldId = "";
    let newId = "";
    const oldResult = result.current.invoke(
      oldFingerprint,
      (operationId) =>
        new Promise<string>((resolve) => {
          oldId = operationId;
          finishOld = resolve;
        }),
    );

    await expect(
      result.current.invoke(newFingerprint, async (operationId) => {
        newId = operationId;
        throw new TypeError("response lost");
      }),
    ).rejects.toBeInstanceOf(TypeError);
    finishOld?.("late success");
    await expect(oldResult).resolves.toBe("late success");

    let retryId = "";
    await result.current.invoke(newFingerprint, async (operationId) => {
      retryId = operationId;
      return "replayed";
    });
    expect(newId).not.toBe(oldId);
    expect(retryId).toBe(newId);
  });
});

describe("commandFingerprint", () => {
  it("is stable across field order and changes when a canonical field changes", () => {
    const first = commandFingerprint("continue_review", {
      expectedDraftRevision: 3,
      expectedGoalRevision: 2,
      goalId: "goal-1",
    });
    const reordered = commandFingerprint("continue_review", {
      goalId: "goal-1",
      expectedGoalRevision: 2,
      expectedDraftRevision: 3,
    });
    const changed = commandFingerprint("continue_review", {
      expectedDraftRevision: 4,
      expectedGoalRevision: 2,
      goalId: "goal-1",
    });

    expect(reordered).toBe(first);
    expect(changed).not.toBe(first);
    expect(() =>
      commandFingerprint("continue_review", {
        expectedDraftRevision: Number.NaN,
      }),
    ).toThrow(RangeError);
  });
});
