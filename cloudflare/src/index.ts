import { Container, getContainer } from "@cloudflare/containers";
import { env } from "cloudflare:workers";

import { handleBetaAdmission } from "./beta-admission/beta-admission";

const backendInstanceID = "staging-singleton";

function required(name: string, value: string | undefined): string {
  if (value === undefined || value.trim() === "") {
    throw new Error(`Missing required Worker secret: ${name}`);
  }
  return value;
}

export class Backend extends Container {
  defaultPort = 8080;
  sleepAfter = "10m";
  envVars = {
    APP_ENV: "production",
    HTTP_ADDRESS: ":8080",
    PUBLIC_ORIGIN: required("PUBLIC_ORIGIN", env.PUBLIC_ORIGIN),
    OTEL_EXPORTER_OTLP_ENDPOINT: required(
      "OTEL_EXPORTER_OTLP_ENDPOINT",
      env.OTEL_EXPORTER_OTLP_ENDPOINT,
    ),
    OTEL_EXPORTER_OTLP_HEADERS: required(
      "OTEL_EXPORTER_OTLP_HEADERS",
      env.OTEL_EXPORTER_OTLP_HEADERS,
    ),
    DATABASE_URL: required("DATABASE_URL", env.DATABASE_URL),
    DB_MAX_OPEN_CONNS: required("DB_MAX_OPEN_CONNS", env.DB_MAX_OPEN_CONNS),
    DB_MAX_IDLE_CONNS: required("DB_MAX_IDLE_CONNS", env.DB_MAX_IDLE_CONNS),
    DB_CONN_MAX_LIFETIME_MINUTES: required(
      "DB_CONN_MAX_LIFETIME_MINUTES",
      env.DB_CONN_MAX_LIFETIME_MINUTES,
    ),
    SESSION_TOKEN_PEPPER: required(
      "SESSION_TOKEN_PEPPER",
      env.SESSION_TOKEN_PEPPER,
    ),
    CSRF_TOKEN_PEPPER: required("CSRF_TOKEN_PEPPER", env.CSRF_TOKEN_PEPPER),
    BOOTSTRAP_ID_PEPPER: required(
      "BOOTSTRAP_ID_PEPPER",
      env.BOOTSTRAP_ID_PEPPER,
    ),
    RATE_LIMIT_HMAC_SECRET: required(
      "RATE_LIMIT_HMAC_SECRET",
      env.RATE_LIMIT_HMAC_SECRET,
    ),
    CURSOR_SIGNING_SECRET: required(
      "CURSOR_SIGNING_SECRET",
      env.CURSOR_SIGNING_SECRET,
    ),
    SESSION_IDLE_DAYS: required("SESSION_IDLE_DAYS", env.SESSION_IDLE_DAYS),
    SESSION_ABSOLUTE_DAYS: required(
      "SESSION_ABSOLUTE_DAYS",
      env.SESSION_ABSOLUTE_DAYS,
    ),
    SESSION_ACTIVITY_TOUCH_MINUTES: required(
      "SESSION_ACTIVITY_TOUCH_MINUTES",
      env.SESSION_ACTIVITY_TOUCH_MINUTES,
    ),
    ANONYMOUS_BOOTSTRAP_TTL_MINUTES: required(
      "ANONYMOUS_BOOTSTRAP_TTL_MINUTES",
      env.ANONYMOUS_BOOTSTRAP_TTL_MINUTES,
    ),
    MAX_PROGRESSING_GOALS: required(
      "MAX_PROGRESSING_GOALS",
      env.MAX_PROGRESSING_GOALS,
    ),
    OPENAI_API_KEY: required("OPENAI_API_KEY", env.OPENAI_API_KEY),
    AI_PROVIDER: "openai",
    AI_MODEL: required("AI_MODEL", env.AI_MODEL),
    AI_REASONING_EFFORT: required(
      "AI_REASONING_EFFORT",
      env.AI_REASONING_EFFORT,
    ),
    AI_MAX_INPUT_TOKENS: required(
      "AI_MAX_INPUT_TOKENS",
      env.AI_MAX_INPUT_TOKENS,
    ),
    AI_GOAL_REFINE_MAX_OUTPUT_TOKENS: required(
      "AI_GOAL_REFINE_MAX_OUTPUT_TOKENS",
      env.AI_GOAL_REFINE_MAX_OUTPUT_TOKENS,
    ),
    AI_ACTION_MAX_OUTPUT_TOKENS: required(
      "AI_ACTION_MAX_OUTPUT_TOKENS",
      env.AI_ACTION_MAX_OUTPUT_TOKENS,
    ),
    AI_MAX_CONTEXT_CYCLES: required(
      "AI_MAX_CONTEXT_CYCLES",
      env.AI_MAX_CONTEXT_CYCLES,
    ),
    AI_TIMEOUT_SECONDS: required("AI_TIMEOUT_SECONDS", env.AI_TIMEOUT_SECONDS),
    AI_MAX_PROVIDER_ATTEMPTS: required(
      "AI_MAX_PROVIDER_ATTEMPTS",
      env.AI_MAX_PROVIDER_ATTEMPTS,
    ),
    AI_MAX_RETRY_BACKOFF_SECONDS: required(
      "AI_MAX_RETRY_BACKOFF_SECONDS",
      env.AI_MAX_RETRY_BACKOFF_SECONDS,
    ),
    AI_FINALIZATION_GRACE_SECONDS: required(
      "AI_FINALIZATION_GRACE_SECONDS",
      env.AI_FINALIZATION_GRACE_SECONDS,
    ),
    AI_LEASE_SECONDS: required("AI_LEASE_SECONDS", env.AI_LEASE_SECONDS),
    AI_MAX_GENERATIONS_PER_USER_24H: required(
      "AI_MAX_GENERATIONS_PER_USER_24H",
      env.AI_MAX_GENERATIONS_PER_USER_24H,
    ),
    AI_GOAL_REFINE_PROMPT_VERSION: required(
      "AI_GOAL_REFINE_PROMPT_VERSION",
      env.AI_GOAL_REFINE_PROMPT_VERSION,
    ),
    AI_GENERATE_PROMPT_VERSION: required(
      "AI_GENERATE_PROMPT_VERSION",
      env.AI_GENERATE_PROMPT_VERSION,
    ),
    AI_REFINE_PROMPT_VERSION: required(
      "AI_REFINE_PROMPT_VERSION",
      env.AI_REFINE_PROMPT_VERSION,
    ),
    AI_TOKENIZER_ENCODING: required(
      "AI_TOKENIZER_ENCODING",
      env.AI_TOKENIZER_ENCODING,
    ),
    AI_MONTHLY_BUDGET_USD: required(
      "AI_MONTHLY_BUDGET_USD",
      env.AI_MONTHLY_BUDGET_USD,
    ),
    AI_WARNING_THRESHOLDS: required(
      "AI_WARNING_THRESHOLDS",
      env.AI_WARNING_THRESHOLDS,
    ),
    AI_PRICING_MODEL: required("AI_PRICING_MODEL", env.AI_PRICING_MODEL),
    AI_PRICE_INPUT_USD_PER_MILLION: required(
      "AI_PRICE_INPUT_USD_PER_MILLION",
      env.AI_PRICE_INPUT_USD_PER_MILLION,
    ),
    AI_PRICE_OUTPUT_USD_PER_MILLION: required(
      "AI_PRICE_OUTPUT_USD_PER_MILLION",
      env.AI_PRICE_OUTPUT_USD_PER_MILLION,
    ),
    GOOGLE_WEB_CLIENT_ID: required(
      "GOOGLE_WEB_CLIENT_ID",
      env.GOOGLE_WEB_CLIENT_ID,
    ),
    TURNSTILE_ENABLED: "true",
    TURNSTILE_SECRET_KEY: required(
      "TURNSTILE_SECRET_KEY",
      env.TURNSTILE_SECRET_KEY,
    ),
    TURNSTILE_EXPECTED_ACTION: "anonymous_bootstrap",
    RATE_ANONYMOUS_CREATE_PER_IP_HOUR: required(
      "RATE_ANONYMOUS_CREATE_PER_IP_HOUR",
      env.RATE_ANONYMOUS_CREATE_PER_IP_HOUR,
    ),
    RATE_ANONYMOUS_CREATE_PER_IP_24H: required(
      "RATE_ANONYMOUS_CREATE_PER_IP_24H",
      env.RATE_ANONYMOUS_CREATE_PER_IP_24H,
    ),
    RATE_AI_PER_USER_MINUTE: required(
      "RATE_AI_PER_USER_MINUTE",
      env.RATE_AI_PER_USER_MINUTE,
    ),
    RATE_AI_PER_SESSION_MINUTE: required(
      "RATE_AI_PER_SESSION_MINUTE",
      env.RATE_AI_PER_SESSION_MINUTE,
    ),
    RATE_AI_PER_IP_MINUTE: required(
      "RATE_AI_PER_IP_MINUTE",
      env.RATE_AI_PER_IP_MINUTE,
    ),
  };
}

function isBackendRequest(url: URL): boolean {
  return (
    url.pathname === "/healthz" ||
    url.pathname === "/readyz" ||
    url.pathname.startsWith("/api/")
  );
}

export default {
  async fetch(request, bindings): Promise<Response> {
    if (!isBackendRequest(new URL(request.url))) {
      return bindings.ASSETS.fetch(request);
    }

    const admissionResponse = await handleBetaAdmission(request, bindings);
    if (admissionResponse !== null) return admissionResponse;

    const headers = new Headers(request.headers);
    const connectingIP = request.headers.get("CF-Connecting-IP");
    if (connectingIP === null) headers.delete("X-Forwarded-For");
    else headers.set("X-Forwarded-For", connectingIP);
    headers.set("X-Forwarded-Proto", "https");
    const forwarded = new Request(request, { headers });
    return getContainer(bindings.BACKEND, backendInstanceID).fetch(forwarded);
  },
} satisfies ExportedHandler<Env>;
