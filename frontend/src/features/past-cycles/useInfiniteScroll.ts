import { useEffect, useRef } from "react";

export function useInfiniteScroll(onVisible: () => void, enabled: boolean) {
  const target = useRef<HTMLDivElement | null>(null);
  const callback = useRef(onVisible);

  useEffect(() => {
    callback.current = onVisible;
  }, [onVisible]);

  useEffect(() => {
    if (!enabled || target.current === null) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) callback.current();
      },
      { rootMargin: "200px" },
    );
    observer.observe(target.current);
    return () => observer.disconnect();
  }, [enabled]);
  return target;
}
