import { useCallback, useEffect, useRef, useState } from "react";
import { Link, Outlet } from "react-router-dom";

type PlanNavigationHandler = () => void;

export type AppOutletContext = {
  readonly planNavigationRequested: boolean;
  readonly onPlanNavigationHandled: () => void;
  readonly registerPlanNavigationHandler: (
    handler: PlanNavigationHandler,
  ) => () => void;
};

export function AppLayout() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [planNavigationRequested, setPlanNavigationRequested] = useState(false);
  const planNavigationHandler = useRef<PlanNavigationHandler | null>(null);
  const onPlanNavigationHandled = useCallback(
    () => setPlanNavigationRequested(false),
    [],
  );
  const registerPlanNavigationHandler = useCallback(
    (handler: PlanNavigationHandler) => {
      planNavigationHandler.current = handler;
      return () => {
        if (planNavigationHandler.current === handler) {
          planNavigationHandler.current = null;
        }
      };
    },
    [],
  );
  useEffect(() => {
    if (!menuOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [menuOpen]);

  return (
    <div className="app-shell">
      <header className="app-header">
        <Link
          className="wordmark"
          to="/"
          aria-label="PDCAI 現在のサイクルのPへ"
          onClick={() => {
            setMenuOpen(false);
            if (planNavigationHandler.current === null) {
              setPlanNavigationRequested(true);
            } else {
              planNavigationHandler.current();
              setPlanNavigationRequested(false);
            }
          }}
        >
          PDCAI
        </Link>
        <button
          className="icon-button"
          type="button"
          aria-label="メニューを開く"
          aria-expanded={menuOpen}
          aria-controls="app-menu"
          onClick={() => setMenuOpen((current) => !current)}
        >
          <span aria-hidden="true">☰</span>
        </button>
      </header>
      {menuOpen && (
        <>
          <button
            className="drawer-backdrop"
            type="button"
            aria-label="メニューを閉じる"
            onClick={() => setMenuOpen(false)}
          />
          <nav className="drawer" id="app-menu" aria-label="メインメニュー">
            <p className="drawer__label">メニュー</p>
            <Link to="/cycles" onClick={() => setMenuOpen(false)}>
              過去のサイクル
            </Link>
            <Link to="/settings" onClick={() => setMenuOpen(false)}>
              設定
            </Link>
          </nav>
        </>
      )}
      <Outlet
        context={{
          planNavigationRequested,
          onPlanNavigationHandled,
          registerPlanNavigationHandler,
        }}
      />
    </div>
  );
}
