import { useEffect, useRef, useState } from "react";
import { Link, Outlet } from "react-router-dom";

export function AppLayout() {
  const [open, setOpen] = useState(false);
  const menu = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: KeyboardEvent) =>
      event.key === "Escape" && setOpen(false);
    document.addEventListener("keydown", close);
    menu.current?.querySelector<HTMLElement>("a")?.focus();
    return () => document.removeEventListener("keydown", close);
  }, [open]);
  return (
    <div className="app-shell">
      <header className="app-header">
        <Link className="wordmark" to="/" aria-label="FUKAMU Cycle ホーム">
          FUKAMU Cycle
        </Link>
        <button
          className="icon-button"
          type="button"
          aria-label={open ? "メニューを閉じる" : "メニューを開く"}
          aria-expanded={open}
          aria-controls="app-menu"
          onClick={() => setOpen((value) => !value)}
        >
          <span aria-hidden="true">☰</span>
        </button>
      </header>
      {open && (
        <>
          <button
            className="drawer-backdrop"
            type="button"
            aria-label="メニューを閉じる"
            onClick={() => setOpen(false)}
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
      <Outlet />
    </div>
  );
}
