import { useEffect, useState } from "react";

import { browserLocalDate, nextLocalDateRefreshDelay } from "./localDate";

export function useBrowserLocalDate(): string {
  const [today, setToday] = useState(() => browserLocalDate(new Date()));

  useEffect(() => {
    let timeout: ReturnType<typeof setTimeout> | undefined;

    const refresh = () => {
      const now = new Date();
      setToday(browserLocalDate(now));
      if (timeout !== undefined) clearTimeout(timeout);
      timeout = setTimeout(refresh, nextLocalDateRefreshDelay(now));
    };
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };

    refresh();
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      if (timeout !== undefined) clearTimeout(timeout);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, []);

  return today;
}
