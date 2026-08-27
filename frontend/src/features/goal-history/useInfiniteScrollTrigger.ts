import { useCallback, useEffect, useRef } from "react";

type InfiniteScrollTriggerOptions = {
  readonly fetchNextPage: (options: {
    readonly cancelRefetch: false;
  }) => Promise<unknown>;
  readonly hasNextPage: boolean | undefined;
  readonly isFetchNextPageError: boolean;
  readonly isFetchingNextPage: boolean;
};

export function useInfiniteScrollTrigger({
  fetchNextPage,
  hasNextPage,
  isFetchNextPageError,
  isFetchingNextPage,
}: InfiniteScrollTriggerOptions) {
  const sentinel = useRef<HTMLDivElement>(null);
  const requestInFlight = useRef(false);

  const requestNextPage = useCallback(() => {
    if (requestInFlight.current) return;
    requestInFlight.current = true;
    void fetchNextPage({ cancelRefetch: false })
      .catch(() => undefined)
      .finally(() => {
        requestInFlight.current = false;
      });
  }, [fetchNextPage]);

  useEffect(() => {
    const element = sentinel.current;
    if (!element) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (
          !entry?.isIntersecting ||
          !hasNextPage ||
          isFetchingNextPage ||
          isFetchNextPageError ||
          requestInFlight.current
        )
          return;
        requestNextPage();
      },
      { rootMargin: "240px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [hasNextPage, isFetchNextPageError, isFetchingNextPage, requestNextPage]);

  return { sentinel, requestNextPage };
}
