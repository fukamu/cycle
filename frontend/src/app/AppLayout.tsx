import { useCallback, useEffect, useRef, useState } from "react";
import { Link, Outlet } from "react-router-dom";

export function AppLayout() {
  const [open, setOpen] = useState(false);
  const menu = useRef<HTMLElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const closeMenu = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) window.setTimeout(() => trigger.current?.focus(), 0);
  }, []);

  useEffect(() => {
    if (!open) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeMenu(true);
    };
    document.addEventListener("keydown", close);
    menu.current?.querySelector<HTMLElement>("a")?.focus();
    return () => document.removeEventListener("keydown", close);
  }, [closeMenu, open]);

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        本文へ移動
      </a>
      <header className="app-header">
        <Link
          className="wordmark"
          to="/"
          aria-label="FUKAMU Cycle ホーム"
          onClick={() => setOpen(false)}
        >
          <span className="wordmark__name">FUKAMU</span>
          <span className="wordmark__suffix">Cycle</span>
        </Link>
        <button
          ref={trigger}
          className="icon-button"
          type="button"
          aria-label={open ? "メニューを閉じる" : "メニューを開く"}
          aria-expanded={open}
          aria-controls="app-menu"
          onClick={() => (open ? closeMenu(true) : setOpen(true))}
        >
          <span aria-hidden="true">MENU</span>
        </button>
      </header>
      {open && (
        <>
          <button
            className="drawer-backdrop"
            type="button"
            aria-label="メニューを閉じる"
            onClick={() => closeMenu(true)}
          />
          <nav
            ref={menu}
            className="drawer"
            id="app-menu"
            aria-label="メインメニュー"
          >
            <p className="drawer__label">メニュー</p>
            <Link to="/history" onClick={() => setOpen(false)}>
              目標の履歴
            </Link>
            <Link to="/settings" onClick={() => setOpen(false)}>
              設定
            </Link>
          </nav>
        </>
      )}
      <div id="main-content" tabIndex={-1}>
        <Outlet />
      </div>
    </div>
  );
}
