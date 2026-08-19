import { act, renderHook } from "@testing-library/react";

import { useDraftAutoSave } from "./useDraftAutoSave";

vi.mock("../drafts/browserDraftCache", () => ({
  deleteBrowserDraft: vi.fn().mockResolvedValue(undefined),
  getBrowserDraft: vi.fn().mockResolvedValue(null),
  putBrowserDraft: vi.fn().mockResolvedValue(undefined),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("useDraftAutoSave", () => {
  afterEach(() => vi.useRealTimers());

  it("serializes an edit made while the previous save is in flight", async () => {
    vi.useFakeTimers();
    const first = deferred<{ body: string; revision: number }>();
    const second = deferred<{ body: string; revision: number }>();
    const save = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const input = {
      userId: "user-1",
      subjectKey: "goal-draft:one",
      initialBody: "",
      initialRevision: 0,
      save,
    };
    const { result } = renderHook(() => useDraftAutoSave(input));

    act(() => result.current.setBody("first"));
    await act(() => vi.advanceTimersByTimeAsync(800));
    expect(save).toHaveBeenNthCalledWith(1, "first", 0);

    act(() => result.current.setBody("second"));
    await act(() => vi.advanceTimersByTimeAsync(800));
    expect(save).toHaveBeenCalledTimes(1);

    await act(async () => first.resolve({ body: "first", revision: 1 }));
    await act(() => vi.advanceTimersByTimeAsync(800));
    expect(save).toHaveBeenNthCalledWith(2, "second", 1);

    await act(async () => second.resolve({ body: "second", revision: 2 }));
    expect(result.current.state).toBe("saved");
    expect(result.current.body).toBe("second");
    expect(result.current.revision).toBe(2);
  });
});
