import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PropsWithChildren,
} from "react";
import { Link, Outlet, useLocation } from "react-router-dom";

type RouteHeadingFocusRequest = Readonly<{
  getPendingGeneration: (pathname: string) => number | undefined;
  complete: (pathname: string, generation: number) => void;
}>;

type PendingRouteHeadingFocus = Readonly<{
  pathname: string;
  generation: number;
}>;

const RouteHeadingFocusContext = createContext<
  RouteHeadingFocusRequest | undefined
>(undefined);

export function RouteHeadingFocusProvider({ children }: PropsWithChildren) {
  const { pathname } = useLocation();
  const previousPathname = useRef(pathname);
  const nextGeneration = useRef(0);
  const pendingRequest = useRef<PendingRouteHeadingFocus | undefined>(
    undefined,
  );

  useLayoutEffect(() => {
    if (previousPathname.current === pathname) return;
    previousPathname.current = pathname;
    nextGeneration.current += 1;
    pendingRequest.current = {
      pathname,
      generation: nextGeneration.current,
    };
  }, [pathname]);

  const getPendingGeneration = useCallback((candidate: string) => {
    const pending = pendingRequest.current;
    return pending?.pathname === candidate ? pending.generation : undefined;
  }, []);
  const complete = useCallback((candidate: string, generation: number) => {
    const pending = pendingRequest.current;
    if (pending?.pathname === candidate && pending.generation === generation)
      pendingRequest.current = undefined;
  }, []);
  const request = useMemo(
    () => ({ getPendingGeneration, complete }),
    [complete, getPendingGeneration],
  );

  return (
    <RouteHeadingFocusContext.Provider value={request}>
      {children}
    </RouteHeadingFocusContext.Provider>
  );
}

export function AppLayout() {
  const { pathname } = useLocation();
  const routeHeadingFocus = useContext(RouteHeadingFocusContext);
  const [open, setOpen] = useState(false);
  const mainContent = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLElement>(null);
  const currentPathname = useRef(pathname);
  const previousPathname = useRef(pathname);
  const trigger = useRef<HTMLButtonElement>(null);
  const closeMenu = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) window.setTimeout(() => trigger.current?.focus(), 0);
  }, []);

  useLayoutEffect(() => {
    currentPathname.current = pathname;
  }, [pathname]);

  useEffect(() => {
    const pendingGeneration = routeHeadingFocus
      ? routeHeadingFocus.getPendingGeneration(pathname)
      : previousPathname.current !== pathname
        ? 0
        : undefined;
    previousPathname.current = pathname;
    if (pendingGeneration === undefined) return;

    const destination = mainContent.current;
    if (!destination) return;
    const requestIsCurrent = () =>
      currentPathname.current === pathname &&
      (!routeHeadingFocus ||
        routeHeadingFocus.getPendingGeneration(pathname) === pendingGeneration);

    const focusHeading = () => {
      if (!requestIsCurrent()) return false;
      const heading = Array.from(
        destination.querySelectorAll<HTMLHeadingElement>("h1"),
      ).find(
        (candidate) =>
          !candidate.closest(
            "[hidden], [inert], [aria-hidden='true'], dialog, [role='dialog'], [role='alertdialog']",
          ),
      );
      if (!heading) return false;
      if (!requestIsCurrent()) return false;

      heading.tabIndex = -1;
      heading.focus();
      if (document.activeElement !== heading) return false;
      routeHeadingFocus?.complete(pathname, pendingGeneration);
      return true;
    };

    if (focusHeading()) return;

    const observer = new MutationObserver(() => {
      if (!requestIsCurrent()) {
        observer.disconnect();
        return;
      }
      if (focusHeading()) observer.disconnect();
    });
    const attributeFilter = ["aria-hidden", "hidden", "inert", "open", "role"];
    observer.observe(destination, {
      attributeFilter,
      attributes: true,
      childList: true,
      subtree: true,
    });
    let ancestor = destination.parentElement;
    while (ancestor) {
      observer.observe(ancestor, { attributeFilter, attributes: true });
      ancestor = ancestor.parentElement;
    }
    return () => observer.disconnect();
  }, [pathname, routeHeadingFocus]);

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
      <div ref={mainContent} id="main-content" tabIndex={-1}>
        <Outlet />
      </div>
    </div>
  );
}
