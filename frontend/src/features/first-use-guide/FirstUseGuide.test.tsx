import { render, renderHook, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";

import {
  activateFirstUseGuide,
  clearFirstUseGuidePreferences,
  markFirstUseGuideStageShown,
  readFirstUseGuidePreferences,
  shouldShowFirstUseGuideStage,
  type FirstUseGuideStage,
} from "../../shared/preferences/firstUseGuidePreference";
import { InteractionAvailabilityProvider } from "../../shared/interaction/InteractionAvailabilityProvider";
import { FirstUseGuide } from "./FirstUseGuide";
import {
  FirstUseGuideProvider,
  useFirstUseGuideControls,
  type FirstUseGuidePersistenceOwnership,
} from "./FirstUseGuideProvider";

function GuideControls() {
  const controls = useFirstUseGuideControls();
  return (
    <div>
      <output data-testid="can-replay">
        {controls.canReplay ? "available" : "unavailable"}
      </output>
      <output data-testid="replay-pending">
        {controls.replayPending ? "pending" : "idle"}
      </output>
      <button type="button" onClick={controls.replayCurrentGuide}>
        はじめてガイドを表示
      </button>
      <button type="button" onClick={controls.cancelReplay}>
        表示予約を取り消す
      </button>
    </div>
  );
}

beforeEach(() => {
  window.localStorage.clear();
  clearFirstUseGuidePreferences();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("FirstUseGuide", () => {
  it("does nothing when rendered outside its optional Provider", () => {
    activateFirstUseGuide();

    render(
      <FirstUseGuide stage="goal" autoEligible={true} replayEligible={true} />,
    );

    expect(
      screen.queryByRole("heading", { name: "はじめてガイド" }),
    ).not.toBeInTheDocument();
    expect(readFirstUseGuidePreferences().shown.goal).toBe(false);

    const controls = renderHook(() => useFirstUseGuideControls());
    expect(controls.result.current.canReplay).toBe(false);
    expect(controls.result.current.replayPending).toBe(false);
    expect(() => controls.result.current.replayCurrentGuide()).not.toThrow();
    expect(() => controls.result.current.cancelReplay()).not.toThrow();
  });

  it("marks a normal auto guide only after the panel is committed and keeps it open", () => {
    activateFirstUseGuide();
    const originalSetItem = window.localStorage.setItem.bind(
      window.localStorage,
    );
    const visibleWhenShownWasWritten: boolean[] = [];
    vi.spyOn(window.localStorage, "setItem").mockImplementation(
      (key, value) => {
        if (key.endsWith("shown-goal")) {
          visibleWhenShownWasWritten.push(
            screen.queryByRole("heading", { name: "はじめてガイド" }) !== null,
          );
        }
        originalSetItem(key, value);
      },
    );

    render(
      <FirstUseGuideProvider>
        <FirstUseGuide stage="goal" autoEligible={true} replayEligible={true} />
      </FirstUseGuideProvider>,
    );

    expect(
      screen.getByRole("heading", { name: "はじめてガイド" }),
    ).toBeInTheDocument();
    expect(visibleWhenShownWasWritten).toEqual([true]);
    expect(readFirstUseGuidePreferences().shown.goal).toBe(true);
  });

  it("updates document fences synchronously while delegating only automatic shown and skip persistence", async () => {
    activateFirstUseGuide();
    const persistence = {
      persistStageShown: vi.fn((stage: FirstUseGuideStage) => {
        expect(shouldShowFirstUseGuideStage(stage)).toBe(false);
      }),
      persistSkipped: vi.fn(() => {
        expect(shouldShowFirstUseGuideStage("plan")).toBe(false);
      }),
    };
    const user = userEvent.setup();
    render(
      <FirstUseGuideProvider persistence={persistence}>
        <GuideControls />
        <FirstUseGuide stage="goal" autoEligible={true} replayEligible={true} />
      </FirstUseGuideProvider>,
    );

    expect(persistence.persistStageShown).toHaveBeenCalledOnce();
    expect(persistence.persistStageShown.mock.calls[0]?.[0]).toBe("goal");
    expect(readFirstUseGuidePreferences().shown.goal).toBe(false);
    expect(shouldShowFirstUseGuideStage("goal")).toBe(false);

    await user.click(screen.getByRole("button", { name: "閉じる" }));
    await user.click(
      screen.getByRole("button", { name: "はじめてガイドを表示" }),
    );
    await user.click(screen.getByRole("button", { name: "閉じる" }));
    expect(persistence.persistStageShown).toHaveBeenCalledOnce();
    expect(persistence.persistSkipped).not.toHaveBeenCalled();

    await user.click(
      screen.getByRole("button", { name: "はじめてガイドを表示" }),
    );
    await user.click(screen.getByRole("button", { name: "ガイドをスキップ" }));
    expect(persistence.persistSkipped).toHaveBeenCalledOnce();
    expect(readFirstUseGuidePreferences().skipped).toBe(false);
    expect(shouldShowFirstUseGuideStage("plan")).toBe(false);

    await user.click(
      screen.getByRole("button", { name: "はじめてガイドを表示" }),
    );
    await user.click(screen.getByRole("button", { name: "ガイドをスキップ" }));
    expect(persistence.persistSkipped).toHaveBeenCalledOnce();
  });

  it("invalidates captured shown and skip persistence ownership when the route registration changes", async () => {
    activateFirstUseGuide();
    const shownOwnership: FirstUseGuidePersistenceOwnership[] = [];
    const skipOwnership: FirstUseGuidePersistenceOwnership[] = [];
    const persistence = {
      persistStageShown: (
        _stage: FirstUseGuideStage,
        ownership: FirstUseGuidePersistenceOwnership,
      ) => shownOwnership.push(ownership),
      persistSkipped: (ownership: FirstUseGuidePersistenceOwnership) =>
        skipOwnership.push(ownership),
    };
    const user = userEvent.setup();
    function RouteHarness() {
      const [stage, setStage] = useState<"plan" | "do">("plan");
      return (
        <>
          <button type="button" onClick={() => setStage("do")}>
            Dへ移動
          </button>
          <FirstUseGuide
            stage={stage}
            autoEligible={stage === "plan"}
            replayEligible={true}
          />
        </>
      );
    }
    render(
      <FirstUseGuideProvider persistence={persistence}>
        <RouteHarness />
      </FirstUseGuideProvider>,
    );

    expect(shownOwnership).toHaveLength(1);
    expect(shownOwnership[0]?.isCurrent()).toBe(true);
    await user.click(screen.getByRole("button", { name: "ガイドをスキップ" }));
    expect(skipOwnership).toHaveLength(1);
    expect(skipOwnership[0]?.isCurrent()).toBe(true);

    await user.click(screen.getByRole("button", { name: "Dへ移動" }));

    expect(shownOwnership[0]?.isCurrent()).toBe(false);
    expect(skipOwnership[0]?.isCurrent()).toBe(false);
  });

  it("closes only the current automatic stage while retaining its shown state", async () => {
    activateFirstUseGuide();
    const user = userEvent.setup();
    render(
      <FirstUseGuideProvider>
        <FirstUseGuide stage="goal" autoEligible={true} replayEligible={true} />
      </FirstUseGuideProvider>,
    );

    await user.click(screen.getByRole("button", { name: "閉じる" }));

    expect(
      screen.queryByRole("heading", { name: "はじめてガイド" }),
    ).not.toBeInTheDocument();
    expect(readFirstUseGuidePreferences().shown.goal).toBe(true);
  });

  it("does not leak an open panel into a newly selected stage", async () => {
    activateFirstUseGuide();
    const user = userEvent.setup();
    function StageHarness() {
      const [stage, setStage] = useState<"plan" | "do">("plan");
      return (
        <>
          <button type="button" onClick={() => setStage("do")}>
            Dへ切替
          </button>
          <FirstUseGuide
            stage={stage}
            autoEligible={stage === "plan"}
            replayEligible={true}
          />
        </>
      );
    }
    render(
      <FirstUseGuideProvider>
        <StageHarness />
      </FirstUseGuideProvider>,
    );
    expect(
      screen.getByText("現在地：P — 今回試すことを決める"),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Dへ切替" }));

    expect(
      screen.queryByRole("heading", { name: "はじめてガイド" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("現在地：P — 今回試すことを決める"),
    ).not.toBeInTheDocument();
    expect(readFirstUseGuidePreferences().shown.do).toBe(false);
  });

  it("does not resurrect an old stage when an already-shown stage is visited between selections", async () => {
    activateFirstUseGuide();
    markFirstUseGuideStageShown("do");
    const user = userEvent.setup();
    function ShownStageHarness() {
      const [stage, setStage] = useState<"plan" | "do">("plan");
      return (
        <>
          <button type="button" onClick={() => setStage("plan")}>
            Pを選択
          </button>
          <button type="button" onClick={() => setStage("do")}>
            Dを選択
          </button>
          <FirstUseGuide
            stage={stage}
            autoEligible={true}
            replayEligible={true}
          />
        </>
      );
    }
    render(
      <FirstUseGuideProvider>
        <ShownStageHarness />
      </FirstUseGuideProvider>,
    );
    expect(
      screen.getByText("現在地：P — 今回試すことを決める"),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Dを選択" }));
    expect(
      screen.queryByRole("heading", { name: "はじめてガイド" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Pを選択" }));

    expect(
      screen.queryByRole("heading", { name: "はじめてガイド" }),
    ).not.toBeInTheDocument();
    expect(readFirstUseGuidePreferences().shown.plan).toBe(true);
    expect(readFirstUseGuidePreferences().shown.do).toBe(true);
  });

  it("hides a stale automatic panel when its context becomes ineligible", async () => {
    activateFirstUseGuide();
    const user = userEvent.setup();
    function AutoContextHarness() {
      const [autoEligible, setAutoEligible] = useState(true);
      return (
        <>
          <button type="button" onClick={() => setAutoEligible(false)}>
            Cycle 2へ切替
          </button>
          <button type="button" onClick={() => setAutoEligible(true)}>
            Cycle 1へ戻る
          </button>
          <FirstUseGuide
            stage="plan"
            autoEligible={autoEligible}
            replayEligible={true}
          />
        </>
      );
    }
    render(
      <FirstUseGuideProvider>
        <AutoContextHarness />
      </FirstUseGuideProvider>,
    );
    expect(
      screen.getByText("現在地：P — 今回試すことを決める"),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Cycle 2へ切替" }));
    expect(
      screen.queryByRole("heading", { name: "はじめてガイド" }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Cycle 1へ戻る" }));
    expect(
      screen.queryByRole("heading", { name: "はじめてガイド" }),
    ).not.toBeInTheDocument();
    expect(readFirstUseGuidePreferences().shown.plan).toBe(true);
  });

  it("does not consume an automatic stage until hidden interaction becomes available", async () => {
    activateFirstUseGuide();
    const user = userEvent.setup();
    function AvailabilityHarness() {
      const [available, setAvailable] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setAvailable(true)}>
            操作を再開
          </button>
          <InteractionAvailabilityProvider available={available}>
            <div hidden={!available} inert={!available}>
              <FirstUseGuide
                stage="goal"
                autoEligible={true}
                replayEligible={true}
              />
            </div>
          </InteractionAvailabilityProvider>
        </>
      );
    }
    render(
      <FirstUseGuideProvider>
        <AvailabilityHarness />
      </FirstUseGuideProvider>,
    );

    expect(
      screen.queryByRole("heading", { name: "はじめてガイド" }),
    ).not.toBeInTheDocument();
    expect(readFirstUseGuidePreferences().shown.goal).toBe(false);

    await user.click(screen.getByRole("button", { name: "操作を再開" }));

    expect(
      screen.getByRole("heading", { name: "はじめてガイド" }),
    ).toBeVisible();
    expect(readFirstUseGuidePreferences().shown.goal).toBe(true);
  });

  it("suppresses a repeated auto offer in the same document when the shown write fails", async () => {
    activateFirstUseGuide();
    vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    const user = userEvent.setup();
    function RemountHarness() {
      const [mounted, setMounted] = useState(true);
      return (
        <>
          <button type="button" onClick={() => setMounted((value) => !value)}>
            Guideを切替
          </button>
          {mounted && (
            <FirstUseGuide
              stage="plan"
              autoEligible={true}
              replayEligible={true}
            />
          )}
        </>
      );
    }
    render(
      <FirstUseGuideProvider>
        <RemountHarness />
      </FirstUseGuideProvider>,
    );
    expect(
      screen.getByText("現在地：P — 今回試すことを決める"),
    ).toBeInTheDocument();
    expect(readFirstUseGuidePreferences().shown.plan).toBe(false);

    await user.click(screen.getByRole("button", { name: "閉じる" }));
    await user.click(screen.getByRole("button", { name: "Guideを切替" }));
    await user.click(screen.getByRole("button", { name: "Guideを切替" }));

    expect(
      screen.queryByRole("heading", { name: "はじめてガイド" }),
    ).not.toBeInTheDocument();
    expect(readFirstUseGuidePreferences().shown.plan).toBe(false);
  });

  it("keeps skip as a same-document auto fence when its storage write fails", async () => {
    activateFirstUseGuide();
    vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    const user = userEvent.setup();
    function SkipFailureHarness() {
      const [stage, setStage] = useState<"plan" | "do">("plan");
      return (
        <>
          <button type="button" onClick={() => setStage("do")}>
            Dへ切替
          </button>
          <FirstUseGuide
            stage={stage}
            autoEligible={true}
            replayEligible={true}
          />
        </>
      );
    }
    render(
      <FirstUseGuideProvider>
        <SkipFailureHarness />
      </FirstUseGuideProvider>,
    );

    await user.click(screen.getByRole("button", { name: "ガイドをスキップ" }));
    await user.click(screen.getByRole("button", { name: "Dへ切替" }));

    expect(
      screen.queryByRole("heading", { name: "はじめてガイド" }),
    ).not.toBeInTheDocument();
    expect(readFirstUseGuidePreferences().skipped).toBe(false);
    expect(readFirstUseGuidePreferences().shown.do).toBe(false);
  });

  it("replays the current safe context without changing persistent completion", async () => {
    activateFirstUseGuide();
    const user = userEvent.setup();

    render(
      <FirstUseGuideProvider>
        <GuideControls />
        <FirstUseGuide stage="plan" autoEligible={true} replayEligible={true} />
      </FirstUseGuideProvider>,
    );
    await user.click(screen.getByRole("button", { name: "閉じる" }));
    const beforeReplay = readFirstUseGuidePreferences();

    await user.click(
      screen.getByRole("button", { name: "はじめてガイドを表示" }),
    );

    expect(
      screen.getByText("現在地：P — 今回試すことを決める"),
    ).toBeInTheDocument();
    expect(readFirstUseGuidePreferences()).toEqual(beforeReplay);
  });

  it("keeps a replay armed across stages and resets closed stages when Help is used again", async () => {
    const user = userEvent.setup();
    function ReplayStageHarness() {
      const [stage, setStage] = useState<"plan" | "do">("plan");
      return (
        <>
          <GuideControls />
          <button type="button" onClick={() => setStage("plan")}>
            Pを選択
          </button>
          <button type="button" onClick={() => setStage("do")}>
            Dを選択
          </button>
          <FirstUseGuide
            stage={stage}
            autoEligible={false}
            replayEligible={true}
          />
        </>
      );
    }
    render(
      <FirstUseGuideProvider>
        <ReplayStageHarness />
      </FirstUseGuideProvider>,
    );

    await user.click(
      screen.getByRole("button", { name: "はじめてガイドを表示" }),
    );
    expect(
      screen.getByText("現在地：P — 今回試すことを決める"),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "閉じる" }));

    await user.click(screen.getByRole("button", { name: "Dを選択" }));
    expect(
      screen.getByText("現在地：D — 実際にしたことを記録する"),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Pを選択" }));
    expect(
      screen.queryByRole("heading", { name: "はじめてガイド" }),
    ).not.toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "はじめてガイドを表示" }),
    );
    expect(
      screen.getByText("現在地：P — 今回試すことを決める"),
    ).toBeInTheDocument();
    expect(readFirstUseGuidePreferences()).toEqual({
      eligible: false,
      skipped: false,
      shown: {
        goal: false,
        plan: false,
        do: false,
        check: false,
        action: false,
        review: false,
      },
    });
  });

  it("persists skip across automatic stages and ends the current replay arm", async () => {
    activateFirstUseGuide();
    const user = userEvent.setup();
    const view = render(
      <FirstUseGuideProvider>
        <GuideControls />
        <FirstUseGuide stage="plan" autoEligible={true} replayEligible={true} />
      </FirstUseGuideProvider>,
    );

    await user.click(
      screen.getByRole("button", { name: "はじめてガイドを表示" }),
    );
    await user.click(screen.getByRole("button", { name: "ガイドをスキップ" }));
    view.rerender(
      <FirstUseGuideProvider>
        <GuideControls />
        <FirstUseGuide stage="do" autoEligible={true} replayEligible={true} />
      </FirstUseGuideProvider>,
    );

    expect(
      screen.queryByRole("heading", { name: "はじめてガイド" }),
    ).not.toBeInTheDocument();
    expect(readFirstUseGuidePreferences().shown.do).toBe(false);
    expect(readFirstUseGuidePreferences().skipped).toBe(true);
  });

  it("arms Help outside a context and shows it when a safe target registers", async () => {
    const user = userEvent.setup();
    function PendingReplayHarness() {
      const [showGuide, setShowGuide] = useState(false);
      return (
        <>
          <GuideControls />
          <button type="button" onClick={() => setShowGuide(true)}>
            安全な画面へ移動
          </button>
          {showGuide && (
            <FirstUseGuide
              stage="review"
              autoEligible={false}
              replayEligible={true}
            />
          )}
        </>
      );
    }
    render(
      <FirstUseGuideProvider>
        <PendingReplayHarness />
      </FirstUseGuideProvider>,
    );

    expect(screen.getByTestId("can-replay")).toHaveTextContent("unavailable");
    await user.click(
      screen.getByRole("button", { name: "はじめてガイドを表示" }),
    );
    expect(screen.getByTestId("replay-pending")).toHaveTextContent("pending");

    await user.click(screen.getByRole("button", { name: "安全な画面へ移動" }));

    expect(screen.getByTestId("can-replay")).toHaveTextContent("available");
    expect(screen.getByTestId("replay-pending")).toHaveTextContent("idle");
    expect(screen.getByText("現在地：目標を見直す")).toBeInTheDocument();
    expect(readFirstUseGuidePreferences().shown.review).toBe(false);
  });

  it("cancels an armed replay before a contextual guide registers", async () => {
    const user = userEvent.setup();
    render(
      <FirstUseGuideProvider>
        <GuideControls />
      </FirstUseGuideProvider>,
    );

    await user.click(
      screen.getByRole("button", { name: "はじめてガイドを表示" }),
    );
    await user.click(
      screen.getByRole("button", { name: "表示予約を取り消す" }),
    );

    expect(screen.getByTestId("replay-pending")).toHaveTextContent("idle");
  });

  it("does not resurrect a replay canceled while its existing context is unsafe", async () => {
    const user = userEvent.setup();
    function UnsafeReplayHarness() {
      const [safe, setSafe] = useState(true);
      return (
        <>
          <GuideControls />
          <button type="button" onClick={() => setSafe(false)}>
            復旧確認を開始
          </button>
          <button type="button" onClick={() => setSafe(true)}>
            復旧確認を完了
          </button>
          <FirstUseGuide
            stage="plan"
            autoEligible={false}
            replayEligible={safe}
          />
        </>
      );
    }
    render(
      <FirstUseGuideProvider>
        <UnsafeReplayHarness />
      </FirstUseGuideProvider>,
    );

    await user.click(
      screen.getByRole("button", { name: "はじめてガイドを表示" }),
    );
    expect(
      screen.getByText("現在地：P — 今回試すことを決める"),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "復旧確認を開始" }));
    expect(screen.getByTestId("replay-pending")).toHaveTextContent("pending");
    await user.click(
      screen.getByRole("button", { name: "表示予約を取り消す" }),
    );
    await user.click(screen.getByRole("button", { name: "復旧確認を完了" }));

    expect(screen.getByTestId("replay-pending")).toHaveTextContent("idle");
    expect(
      screen.queryByRole("heading", { name: "はじめてガイド" }),
    ).not.toBeInTheDocument();
  });

  it("drops an armed replay when its Provider lifecycle is replaced", async () => {
    const user = userEvent.setup();
    const view = render(
      <FirstUseGuideProvider key="first">
        <GuideControls />
      </FirstUseGuideProvider>,
    );
    await user.click(
      screen.getByRole("button", { name: "はじめてガイドを表示" }),
    );
    expect(screen.getByTestId("replay-pending")).toHaveTextContent("pending");

    view.rerender(
      <FirstUseGuideProvider key="second">
        <GuideControls />
      </FirstUseGuideProvider>,
    );

    expect(screen.getByTestId("replay-pending")).toHaveTextContent("idle");
  });

  it("keeps a failed shown write fenced across Provider remounts in one document", async () => {
    activateFirstUseGuide();
    const originalSetItem = window.localStorage.setItem.bind(
      window.localStorage,
    );
    vi.spyOn(window.localStorage, "setItem").mockImplementation(
      (key, value) => {
        if (key.endsWith("shown-plan")) {
          throw new DOMException("blocked", "SecurityError");
        }
        originalSetItem(key, value);
      },
    );
    const user = userEvent.setup();
    const view = render(
      <FirstUseGuideProvider key="first">
        <FirstUseGuide stage="plan" autoEligible={true} replayEligible={true} />
      </FirstUseGuideProvider>,
    );
    expect(
      screen.getByText("現在地：P — 今回試すことを決める"),
    ).toBeInTheDocument();
    expect(readFirstUseGuidePreferences().shown.plan).toBe(false);
    await user.click(screen.getByRole("button", { name: "閉じる" }));

    view.rerender(
      <FirstUseGuideProvider key="second">
        <FirstUseGuide stage="plan" autoEligible={true} replayEligible={true} />
      </FirstUseGuideProvider>,
    );

    expect(
      screen.queryByRole("heading", { name: "はじめてガイド" }),
    ).not.toBeInTheDocument();
    expect(readFirstUseGuidePreferences().shown.plan).toBe(false);
  });

  it("does not let an older registration cleanup remove the current target", async () => {
    const user = userEvent.setup();
    function RegistrationHarness() {
      const [showOldGuide, setShowOldGuide] = useState(true);
      return (
        <>
          <GuideControls />
          {showOldGuide && (
            <FirstUseGuide
              stage="goal"
              autoEligible={false}
              replayEligible={true}
            />
          )}
          <FirstUseGuide
            stage="review"
            autoEligible={false}
            replayEligible={true}
          />
          <button type="button" onClick={() => setShowOldGuide(false)}>
            古い画面を外す
          </button>
        </>
      );
    }
    render(
      <FirstUseGuideProvider>
        <RegistrationHarness />
      </FirstUseGuideProvider>,
    );

    await user.click(screen.getByRole("button", { name: "古い画面を外す" }));

    expect(screen.getByTestId("can-replay")).toHaveTextContent("available");
    await user.click(
      screen.getByRole("button", { name: "はじめてガイドを表示" }),
    );
    expect(screen.getByText("現在地：目標を見直す")).toBeInTheDocument();
  });
});
