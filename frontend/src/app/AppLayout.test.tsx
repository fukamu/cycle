import { useRef, useState } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  Link,
  MemoryRouter,
  Navigate,
  Route,
  Routes,
  useNavigate,
} from "react-router-dom";

import { AutoSaveScopeProvider } from "../shared/autosave/AutoSaveScopeProvider";
import { PostCommitCleanupBoundary } from "../shared/cleanup/PostCommitCleanupBoundary";
import {
  useCapturePostCommitRouteOwnership,
  usePostCommitCleanup,
  type PostCommitSessionOperationRunner,
} from "../shared/cleanup/postCommitCleanupContext";
import {
  readSelectedCycleFrame,
  rememberSelectedCycleFrame,
} from "../shared/preferences/selectedFramePreference";
import { AppLayout, RouteHeadingFocusProvider } from "./AppLayout";

function SamePathPage() {
  const [saved, setSaved] = useState(false);

  return (
    <main>
      <h1>同じ画面</h1>
      <Link to="/same#details">詳細へ移動</Link>
      <div id="details">
        <button type="button" onClick={() => setSaved(true)}>
          保存する
        </button>
        {saved && <p>保存しました</p>}
      </div>
    </main>
  );
}

function DelayedHeadingPage() {
  const [phase, setPhase] = useState<"loading" | "error" | "ready">("loading");
  const [revision, setRevision] = useState(0);
  const [dialogOpen, setDialogOpen] = useState(false);

  if (phase === "loading") {
    return (
      <main>
        <p role="status">読み込み中</p>
        <button type="button" onClick={() => setPhase("error")}>
          エラーへ進める
        </button>
      </main>
    );
  }
  if (phase === "error") {
    return (
      <main>
        <p role="alert">読み込みに失敗しました</p>
        <button type="button" onClick={() => setDialogOpen(true)}>
          確認を開く
        </button>
        <button type="button" onClick={() => setPhase("ready")}>
          再試行
        </button>
        {dialogOpen && (
          <div role="dialog" aria-labelledby="delayed-dialog-heading">
            <h1 id="delayed-dialog-heading">同じ画面の確認</h1>
          </div>
        )}
      </main>
    );
  }
  return (
    <main>
      <h1 key={revision}>読み込み後の画面</h1>
      <button type="button" onClick={() => setRevision((value) => value + 1)}>
        内容を更新
      </button>
    </main>
  );
}

function MixedHeadingPage() {
  return (
    <main>
      <section hidden>
        <h1>非表示の見出し</h1>
      </section>
      <section inert>
        <h1>操作対象外の見出し</h1>
      </section>
      <section aria-hidden="true">
        <h1>支援技術対象外の見出し</h1>
      </section>
      <dialog open>
        <h1>Dialogの見出し</h1>
      </dialog>
      <div role="dialog">
        <h1>ARIA Dialogの見出し</h1>
      </div>
      <h1>遷移先の見出し</h1>
    </main>
  );
}

function BlockedHeadingPage() {
  const [hidden, setHidden] = useState(true);
  const [inert, setInert] = useState(true);

  return (
    <main>
      <button type="button" onClick={() => setHidden(false)}>
        hiddenを解除
      </button>
      <button type="button" onClick={() => setInert(false)}>
        inertを解除
      </button>
      <section hidden={hidden} inert={inert}>
        <h1>解除後の見出し</h1>
      </section>
    </main>
  );
}

function RetryableFocusHeadingPage() {
  const [focusAvailable, setFocusAvailable] = useState(false);
  const originalFocus = useRef<(() => void) | null>(null);

  return (
    <main>
      <h1
        ref={(heading) => {
          if (!heading) return;
          originalFocus.current ??= heading.focus.bind(heading);
          Object.defineProperty(heading, "focus", {
            configurable: true,
            value: focusAvailable ? originalFocus.current : () => undefined,
          });
        }}
      >
        Focus再試行の見出し
      </h1>
      <button type="button" onClick={() => setFocusAvailable(true)}>
        focusを再試行
      </button>
      {focusAvailable && <p>再試行できます</p>}
    </main>
  );
}

function WaitingForHeadingPage() {
  const navigate = useNavigate();

  return (
    <main>
      <p role="status">Aの見出しを待っています</p>
      <button type="button" onClick={() => navigate("/race-b")}>
        Bへ移動
      </button>
    </main>
  );
}

function CountedFocusHeadingPage({
  focusCalls,
}: {
  readonly focusCalls: () => void;
}) {
  const originalFocus = useRef<(() => void) | null>(null);

  return (
    <main>
      <h1
        ref={(heading) => {
          if (!heading) return;
          originalFocus.current ??= heading.focus.bind(heading);
          Object.defineProperty(heading, "focus", {
            configurable: true,
            value: () => {
              focusCalls();
              originalFocus.current?.();
            },
          });
        }}
      >
        Bの見出し
      </h1>
    </main>
  );
}

function FirstHistoryPage() {
  const navigate = useNavigate();

  return (
    <main>
      <h1>履歴の最初</h1>
      <Link to="/history-second">次へ</Link>
      <button type="button" onClick={() => navigate(1)}>
        進む
      </button>
    </main>
  );
}

function SecondHistoryPage() {
  const navigate = useNavigate();

  return (
    <main>
      <h1>履歴の次</h1>
      <button type="button" onClick={() => navigate(-1)}>
        戻る
      </button>
    </main>
  );
}

function CleanupNavigationPage() {
  const navigate = useNavigate();
  const runCleanup = usePostCommitCleanup();
  const captureRouteOwnership = useCapturePostCommitRouteOwnership();

  return (
    <main>
      <h1>確定処理の前</h1>
      <button
        type="button"
        onClick={() => {
          const routeOwnership = captureRouteOwnership();
          void runCleanup({
            expectedUserId: "user-1",
            routeOwnership,
            cleanup: async () => undefined,
            onSuccess: (publicationIsCurrent) => {
              if (publicationIsCurrent())
                navigate("/after-cleanup", { replace: true });
            },
            pendingMessage: "端末データを整理しています",
            failureMessage: "端末データを整理できませんでした",
          });
        }}
      >
        確定する
      </button>
    </main>
  );
}

const runCurrentSessionOperation: PostCommitSessionOperationRunner = async (
  _expectedUserId,
  operation,
) => operation(() => true);

describe("AppLayout", () => {
  beforeEach(() => window.localStorage.clear());

  it("resets only the displayed Cycle when the Header logo opens Home", async () => {
    const currentCycleId = "40000000-0000-7000-8000-000000000001";
    const otherCycleId = "40000000-0000-7000-8000-000000000002";
    rememberSelectedCycleFrame(currentCycleId, "do");
    rememberSelectedCycleFrame(otherCycleId, "check");

    render(
      <MemoryRouter
        initialEntries={[
          `/goals/20000000-0000-7000-8000-000000000001/cycles/${currentCycleId}`,
        ]}
      >
        <RouteHeadingFocusProvider>
          <Routes>
            <Route element={<AppLayout />}>
              <Route path="/" element={<p>ホーム本文</p>} />
              <Route
                path="/goals/:goalId/cycles/:cycleId"
                element={<p>Cycle本文</p>}
              />
            </Route>
          </Routes>
        </RouteHeadingFocusProvider>
      </MemoryRouter>,
    );

    await userEvent.click(
      screen.getByRole("link", { name: "FUKAMU Cycle ホーム" }),
    );

    expect(await screen.findByText("ホーム本文")).toBeInTheDocument();
    expect(readSelectedCycleFrame(currentCycleId, "active")).toBe("plan");
    expect(readSelectedCycleFrame(otherCycleId, "active")).toBe("check");
  });

  it("opens an accessible menu with goal history and settings", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <RouteHeadingFocusProvider>
          <Routes>
            <Route element={<AppLayout />}>
              <Route index element={<p>ホーム本文</p>} />
            </Route>
          </Routes>
        </RouteHeadingFocusProvider>
      </MemoryRouter>,
    );
    expect(screen.queryByText("MENU")).not.toBeInTheDocument();
    const trigger = screen.getByRole("button", { name: "メニューを開く" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    await user.click(trigger);
    expect(trigger).toHaveAccessibleName("メニューを閉じる");
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(
      screen.getByRole("navigation", { name: "メインメニュー" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "目標の履歴" })).toHaveAttribute(
      "href",
      "/history",
    );
    expect(screen.getByRole("link", { name: "設定" })).toHaveAttribute(
      "href",
      "/settings",
    );

    await user.keyboard("{Escape}");
    expect(
      screen.queryByRole("navigation", { name: "メインメニュー" }),
    ).not.toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "メニューを開く" }),
      ).toHaveFocus(),
    );
  });

  it.each([
    {
      journey: "Goal start",
      sourcePath: "/goals/new",
      sourceHeading: "新しい目標",
      transitionPath: "/goals/goal-1",
      destinationPath: "/goals/goal-1/cycles/cycle-1",
      destinationHeading: "最初のCycle",
      action: "目標を開始",
    },
    {
      journey: "Cycle complete",
      sourcePath: "/goals/goal-1/cycles/cycle-1",
      sourceHeading: "進行中のCycle",
      transitionPath: "/goals/goal-1/review",
      destinationPath: "/goals/goal-1/review",
      destinationHeading: "CycleのReview",
      action: "Cycleを完了",
    },
    {
      journey: "Review continue",
      sourcePath: "/goals/goal-1/review",
      sourceHeading: "CycleのReview",
      transitionPath: "/goals/goal-1",
      destinationPath: "/goals/goal-1/cycles/cycle-2",
      destinationHeading: "次のCycle",
      action: "次のCycleへ",
    },
  ])(
    "$journey後に遷移先のh1へfocusする",
    async ({
      sourcePath,
      sourceHeading,
      transitionPath,
      destinationPath,
      destinationHeading,
      action,
    }) => {
      const user = userEvent.setup();
      render(
        <MemoryRouter initialEntries={[sourcePath]}>
          <RouteHeadingFocusProvider>
            <Routes>
              <Route element={<AppLayout />}>
                <Route
                  path={sourcePath}
                  element={
                    <main>
                      <h1>{sourceHeading}</h1>
                      <Link to={transitionPath}>{action}</Link>
                    </main>
                  }
                />
                {transitionPath !== destinationPath && (
                  <Route
                    path={transitionPath}
                    element={<Navigate replace to={destinationPath} />}
                  />
                )}
                <Route
                  path={destinationPath}
                  element={
                    <main>
                      <h1>{destinationHeading}</h1>
                    </main>
                  }
                />
              </Route>
            </Routes>
          </RouteHeadingFocusProvider>
        </MemoryRouter>,
      );

      expect(
        screen.getByRole("heading", { level: 1, name: sourceHeading }),
      ).not.toHaveFocus();
      await user.click(screen.getByRole("link", { name: action }));

      const destination = await screen.findByRole("heading", {
        level: 1,
        name: destinationHeading,
      });
      await waitFor(() => expect(destination).toHaveFocus());
      expect(destination).toHaveAttribute("tabindex", "-1");
    },
  );

  it("does not steal focus on initial mount, hash navigation, or same-path updates", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={["/same"]}>
        <RouteHeadingFocusProvider>
          <Routes>
            <Route element={<AppLayout />}>
              <Route path="/same" element={<SamePathPage />} />
            </Route>
          </Routes>
        </RouteHeadingFocusProvider>
      </MemoryRouter>,
    );

    const heading = screen.getByRole("heading", {
      level: 1,
      name: "同じ画面",
    });
    expect(heading).not.toHaveFocus();

    const hashLink = screen.getByRole("link", { name: "詳細へ移動" });
    await user.click(hashLink);
    expect(hashLink).toHaveFocus();
    expect(heading).not.toHaveFocus();

    const save = screen.getByRole("button", { name: "保存する" });
    await user.click(save);
    expect(screen.getByText("保存しました")).toBeInTheDocument();
    expect(save).toHaveFocus();
    expect(heading).not.toHaveFocus();
  });

  it("waits through loading and error, then focuses the final h1 only once", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={["/source"]}>
        <RouteHeadingFocusProvider>
          <Routes>
            <Route element={<AppLayout />}>
              <Route
                path="/source"
                element={
                  <main>
                    <h1>遷移元</h1>
                    <Link to="/delayed">遅延画面へ</Link>
                  </main>
                }
              />
              <Route path="/delayed" element={<DelayedHeadingPage />} />
            </Route>
          </Routes>
        </RouteHeadingFocusProvider>
      </MemoryRouter>,
    );

    await user.click(screen.getByRole("link", { name: "遅延画面へ" }));
    expect(screen.getByRole("status")).toHaveTextContent("読み込み中");
    await user.click(screen.getByRole("button", { name: "エラーへ進める" }));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "読み込みに失敗しました",
    );
    const openDialog = screen.getByRole("button", { name: "確認を開く" });
    await user.click(openDialog);
    expect(openDialog).toHaveFocus();
    expect(
      screen.getByRole("heading", { level: 1, name: "同じ画面の確認" }),
    ).not.toHaveFocus();
    await user.click(screen.getByRole("button", { name: "再試行" }));

    const destination = screen.getByRole("heading", {
      level: 1,
      name: "読み込み後の画面",
    });
    await waitFor(() => expect(destination).toHaveFocus());

    const update = screen.getByRole("button", { name: "内容を更新" });
    await user.click(update);
    expect(update).toHaveFocus();
    expect(
      screen.getByRole("heading", { level: 1, name: "読み込み後の画面" }),
    ).not.toHaveFocus();
  });

  it("skips ineligible h1 elements and focuses the first eligible heading", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={["/mixed-source"]}>
        <RouteHeadingFocusProvider>
          <Routes>
            <Route element={<AppLayout />}>
              <Route
                path="/mixed-source"
                element={
                  <main>
                    <h1>複数見出しの遷移元</h1>
                    <Link to="/mixed-headings">複数見出しへ</Link>
                  </main>
                }
              />
              <Route path="/mixed-headings" element={<MixedHeadingPage />} />
            </Route>
          </Routes>
        </RouteHeadingFocusProvider>
      </MemoryRouter>,
    );

    await user.click(screen.getByRole("link", { name: "複数見出しへ" }));

    await waitFor(() =>
      expect(
        screen.getByRole("heading", { level: 1, name: "遷移先の見出し" }),
      ).toHaveFocus(),
    );
    expect(screen.getByText("非表示の見出し")).not.toHaveFocus();
    expect(screen.getByText("操作対象外の見出し")).not.toHaveFocus();
    expect(screen.getByText("支援技術対象外の見出し")).not.toHaveFocus();
    expect(screen.getByText("Dialogの見出し")).not.toHaveFocus();
    expect(screen.getByText("ARIA Dialogの見出し")).not.toHaveFocus();
  });

  it("waits for hidden and inert ancestors to become eligible", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={["/blocked-source"]}>
        <RouteHeadingFocusProvider>
          <Routes>
            <Route element={<AppLayout />}>
              <Route
                path="/blocked-source"
                element={
                  <main>
                    <h1>属性解除の遷移元</h1>
                    <Link to="/blocked-heading">属性解除へ</Link>
                  </main>
                }
              />
              <Route path="/blocked-heading" element={<BlockedHeadingPage />} />
            </Route>
          </Routes>
        </RouteHeadingFocusProvider>
      </MemoryRouter>,
    );

    await user.click(screen.getByRole("link", { name: "属性解除へ" }));
    const releaseHidden = screen.getByRole("button", {
      name: "hiddenを解除",
    });
    await user.click(releaseHidden);
    expect(releaseHidden).toHaveFocus();
    expect(screen.getByText("解除後の見出し")).not.toHaveFocus();

    await user.click(screen.getByRole("button", { name: "inertを解除" }));
    await waitFor(() =>
      expect(screen.getByText("解除後の見出し")).toHaveFocus(),
    );
  });

  it("keeps the route request pending until focus actually succeeds", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={["/focus-source"]}>
        <RouteHeadingFocusProvider>
          <Routes>
            <Route element={<AppLayout />}>
              <Route
                path="/focus-source"
                element={
                  <main>
                    <h1>Focus再試行の遷移元</h1>
                    <Link to="/retry-focus">Focus再試行へ</Link>
                  </main>
                }
              />
              <Route
                path="/retry-focus"
                element={<RetryableFocusHeadingPage />}
              />
            </Route>
          </Routes>
        </RouteHeadingFocusProvider>
      </MemoryRouter>,
    );

    await user.click(screen.getByRole("link", { name: "Focus再試行へ" }));
    const heading = screen.getByRole("heading", {
      level: 1,
      name: "Focus再試行の見出し",
    });
    expect(heading).not.toHaveFocus();

    await user.click(screen.getByRole("button", { name: "focusを再試行" }));
    await waitFor(() => expect(heading).toHaveFocus());
  });

  it("does not let a stale heading observer focus the next pathname", async () => {
    const user = userEvent.setup();
    const focusCalls = vi.fn();
    render(
      <MemoryRouter initialEntries={["/race-source"]}>
        <RouteHeadingFocusProvider>
          <Routes>
            <Route element={<AppLayout />}>
              <Route
                path="/race-source"
                element={
                  <main>
                    <h1>Raceの遷移元</h1>
                    <Link to="/race-a">Aへ移動</Link>
                  </main>
                }
              />
              <Route path="/race-a" element={<WaitingForHeadingPage />} />
              <Route
                path="/race-b"
                element={<CountedFocusHeadingPage focusCalls={focusCalls} />}
              />
            </Route>
          </Routes>
        </RouteHeadingFocusProvider>
      </MemoryRouter>,
    );

    await user.click(screen.getByRole("link", { name: "Aへ移動" }));
    expect(screen.getByRole("status")).toHaveTextContent(
      "Aの見出しを待っています",
    );
    await user.click(screen.getByRole("button", { name: "Bへ移動" }));

    await waitFor(() =>
      expect(
        screen.getByRole("heading", { level: 1, name: "Bの見出し" }),
      ).toHaveFocus(),
    );
    expect(focusCalls).toHaveBeenCalledOnce();
  });

  it("retains a pathname focus request across post-commit cleanup", async () => {
    const user = userEvent.setup();
    render(
      <AutoSaveScopeProvider>
        <MemoryRouter initialEntries={["/before-cleanup"]}>
          <RouteHeadingFocusProvider>
            <PostCommitCleanupBoundary
              runSessionOperation={runCurrentSessionOperation}
            >
              <Routes>
                <Route element={<AppLayout />}>
                  <Route
                    path="/before-cleanup"
                    element={<CleanupNavigationPage />}
                  />
                  <Route
                    path="/after-cleanup"
                    element={
                      <main>
                        <h1>確定処理の後</h1>
                      </main>
                    }
                  />
                </Route>
              </Routes>
            </PostCommitCleanupBoundary>
          </RouteHeadingFocusProvider>
        </MemoryRouter>
      </AutoSaveScopeProvider>,
    );

    await user.click(screen.getByRole("button", { name: "確定する" }));

    await waitFor(() =>
      expect(
        screen.getByRole("heading", { level: 1, name: "確定処理の後" }),
      ).toHaveFocus(),
    );
  });

  it("focuses the destination h1 on browser back and forward navigation", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={["/history-first"]}>
        <RouteHeadingFocusProvider>
          <Routes>
            <Route element={<AppLayout />}>
              <Route path="/history-first" element={<FirstHistoryPage />} />
              <Route path="/history-second" element={<SecondHistoryPage />} />
            </Route>
          </Routes>
        </RouteHeadingFocusProvider>
      </MemoryRouter>,
    );

    await user.click(screen.getByRole("link", { name: "次へ" }));
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { level: 1, name: "履歴の次" }),
      ).toHaveFocus(),
    );

    await user.click(screen.getByRole("button", { name: "戻る" }));
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { level: 1, name: "履歴の最初" }),
      ).toHaveFocus(),
    );

    await user.click(screen.getByRole("button", { name: "進む" }));
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { level: 1, name: "履歴の次" }),
      ).toHaveFocus(),
    );
  });
});
