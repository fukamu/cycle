import { useEffect, useState } from "react";
import { Link, Outlet } from "react-router-dom";

export function AppLayout() {
  const [menuOpen, setMenuOpen] = useState(false);
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
        <Link className="wordmark" to="/" aria-label="PDCAI ホーム">
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
      <Outlet />
    </div>
  );
}
