import type { z } from "zod";

import { parseAPIError } from "./schemas";

export class APIError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId: string;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(
    status: number,
    code: string,
    message: string,
    requestId: string,
    details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "APIError";
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    this.details = details;
  }
}

type RequestOptions = {
  readonly method?: "GET" | "POST" | "PATCH" | "DELETE";
  readonly body?: unknown;
  readonly csrfToken?: string;
  readonly idempotencyKey?: string;
  readonly signal?: AbortSignal | undefined;
};

export async function requestJSON<T>(
  path: string,
  schema: z.ZodType<T>,
  options: RequestOptions = {},
): Promise<T> {
  const headers = new Headers({ Accept: "application/json" });
  if (options.body !== undefined) {
    headers.set("Content-Type", "application/json; charset=utf-8");
  }
  if (options.csrfToken !== undefined) {
    headers.set("X-CSRF-Token", options.csrfToken);
  }
  if (options.idempotencyKey !== undefined) {
    headers.set("Idempotency-Key", options.idempotencyKey);
  }
  const init: RequestInit = {
    method: options.method ?? "GET",
    headers,
    credentials: "same-origin",
  };
  if (options.body !== undefined) {
    init.body = JSON.stringify(options.body);
  }
  if (options.signal !== undefined) {
    init.signal = options.signal;
  }
  const response = await fetch(path, init);
  const payload: unknown =
    response.status === 204
      ? undefined
      : await response.json().catch(() => undefined);
  if (!response.ok) {
    const parsed = parseAPIError(payload);
    if (parsed.success) {
      throw new APIError(
        response.status,
        parsed.data.error.code,
        parsed.data.error.message,
        parsed.data.error.requestId,
        parsed.data.error.details,
      );
    }
    throw new APIError(
      response.status,
      "INVALID_ERROR_RESPONSE",
      "サーバーから不正な応答を受信しました。",
      "unknown",
    );
  }
  return schema.parse(payload);
}
