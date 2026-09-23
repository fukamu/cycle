import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type PropsWithChildren,
  type RefObject,
} from "react";
import { useLocation } from "react-router-dom";

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

// A custom Hook can safely share this module with the provider component.
// eslint-disable-next-line react-refresh/only-export-components
export function useRouteHeadingFocusTarget(
  rootRef: RefObject<HTMLElement | null>,
) {
  const { pathname } = useLocation();
  const routeHeadingFocus = useContext(RouteHeadingFocusContext);
  const currentPathname = useRef(pathname);
  const previousPathname = useRef(pathname);

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

    const destination = rootRef.current;
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
  }, [pathname, rootRef, routeHeadingFocus]);
}
