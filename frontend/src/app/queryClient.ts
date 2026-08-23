import { QueryClient } from "@tanstack/react-query";

import { APIError, SessionIdentityError } from "../shared/api/client";

export function shouldRetryQuery(
  failureCount: number,
  error: unknown,
): boolean {
  if (error instanceof SessionIdentityError) return false;
  if (
    error instanceof APIError &&
    ((error.status === 401 &&
      (error.code === "SESSION_MISSING" || error.code === "SESSION_EXPIRED")) ||
      (error.status === 403 && error.code === "CSRF_INVALID"))
  ) {
    return false;
  }
  return failureCount < 2;
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: shouldRetryQuery,
      refetchOnWindowFocus: false,
    },
    mutations: {
      retry: false,
    },
  },
});
