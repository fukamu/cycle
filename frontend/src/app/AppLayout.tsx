import { useCallback, useEffect, useRef, useState } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router-dom";

import { useFirstUseGuideControls } from "../features/first-use-guide";
import { firstUseGuideCopy } from "../shared/copy/ja";
import { InteractionAvailabilityProvider } from "../shared/interaction/InteractionAvailabilityProvider";
import { forgetSelectedCycleFrameFromWorkspacePath } from "../shared/preferences/selectedFramePreference";
import { useRouteHeadingFocusTarget } from "./RouteHeadingFocus";

export function AppLayout() {
  const { pathname } = useLocation();
  const firstUseGuide = useFirstUseGuideControls();
  const [open, setOpen] = useState(false);
  const mainContent = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useRouteHeadingFocusTarget(mainContent);
  const closeMenu = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) {
      window.setTimeout(
        () => trigger.current?.focus({ preventScroll: true }),
        0,
      );
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeMenu(true);
        return;
      }
      if (event.key !== "Tab") return;

      const focusable = [
        trigger.current,
        ...Array.from(
          menu.current?.querySelectorAll<HTMLElement>(
            "a, button:not([disabled])",
          ) ?? [],
        ),
      ].filter((element): element is HTMLElement => element !== null);
      if (!focusable.length) return;

      const currentIndex = focusable.indexOf(
        document.activeElement as HTMLElement,
      );
      const nextIndex =
        currentIndex === -1
          ? event.shiftKey
            ? focusable.length - 1
            : 0
          : (currentIndex + (event.shiftKey ? -1 : 1) + focusable.length) %
            focusable.length;
      event.preventDefault();
      focusable[nextIndex]?.focus();
    };
    document.addEventListener("keydown", handleKeyDown);
    menu.current?.querySelector<HTMLElement>("a")?.focus();
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [closeMenu, open]);

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content" inert={open || undefined}>
        本文へ移動
      </a>
      <header className="app-header">
        <Link
          className="wordmark touch-target"
          to="/"
          inert={open || undefined}
          aria-label="FUKAMU Cycle ホーム"
          onClick={() => {
            forgetSelectedCycleFrameFromWorkspacePath(pathname);
            setOpen(false);
          }}
        >
          <span className="wordmark__name">FUKAMU</span>
          <span className="wordmark__suffix">Cycle</span>
        </Link>
        <button
          ref={trigger}
          className="menu-button"
          type="button"
          aria-label={open ? "メニューを閉じる" : "メニューを開く"}
          aria-expanded={open}
          aria-controls="app-menu"
          onClick={() => (open ? closeMenu(true) : setOpen(true))}
        >
          <span className="menu-button__icon" aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
        </button>
      </header>
      {open && (
        <>
          <button
            className="drawer-backdrop"
            type="button"
            aria-hidden="true"
            tabIndex={-1}
            onClick={() => closeMenu(true)}
          />
          <nav
            ref={menu}
            className="drawer"
            id="app-menu"
            aria-label="メインメニュー"
          >
            <p className="drawer__label">メニュー</p>
            <NavLink
              to="/history"
              className={({ isActive }) =>
                isActive ? "drawer__link drawer__link--current" : "drawer__link"
              }
              end={false}
              onClick={() => closeMenu(pathname === "/history")}
            >
              {({ isActive }) => (
                <>
                  <span className="drawer__link-label">目標の履歴</span>
                  {isActive && (
                    <span className="drawer__current" aria-hidden="true">
                      現在地
                    </span>
                  )}
                </>
              )}
            </NavLink>
            <NavLink
              to="/settings"
              className={({ isActive }) =>
                isActive ? "drawer__link drawer__link--current" : "drawer__link"
              }
              end
              onClick={() => closeMenu(pathname === "/settings")}
            >
              {({ isActive }) => (
                <>
                  <span className="drawer__link-label">設定</span>
                  {isActive && (
                    <span className="drawer__current" aria-hidden="true">
                      現在地
                    </span>
                  )}
                </>
              )}
            </NavLink>
            <Link
              to="/legal/privacy"
              className="drawer__link"
              onClick={() => closeMenu(false)}
            >
              <span className="drawer__link-label">
                データの取扱い・お問い合わせ
              </span>
            </Link>
            <button
              className="drawer__action"
              type="button"
              onClick={() => {
                firstUseGuide.replayCurrentGuide();
                closeMenu(true);
              }}
            >
              {firstUseGuideCopy.menuLabel}
            </button>
          </nav>
        </>
      )}
      <InteractionAvailabilityProvider available={!open}>
        <div
          ref={mainContent}
          id="main-content"
          tabIndex={-1}
          inert={open || undefined}
        >
          {!open && firstUseGuide.replayPending && !firstUseGuide.canReplay && (
            <div
              className="first-use-guide-pending"
              role="status"
              aria-live="polite"
            >
              <p>{firstUseGuideCopy.pending}</p>
              <button type="button" onClick={firstUseGuide.cancelReplay}>
                {firstUseGuideCopy.cancelReplay}
              </button>
            </div>
          )}
          <Outlet />
        </div>
      </InteractionAvailabilityProvider>
    </div>
  );
}
