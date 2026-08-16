import { defineConfig, devices } from "@playwright/test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const go = process.env.PDCAI_GO_BINARY ?? "go";
const serverCommand = process.env.PDCAI_SERVER_BINARY
  ? `"${process.env.PDCAI_SERVER_BINARY}"`
  : `"${go}" run ./cmd/migrate && "${go}" run ./cmd/server`;
const databaseURL =
  process.env.TEST_DATABASE_URL ??
  "postgres://pdcai:pdcai@127.0.0.1:55432/pdcai_test?sslmode=disable";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "http://127.0.0.1:8080",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: serverCommand,
    cwd: `${root}/backend`,
    url: "http://127.0.0.1:8080/readyz",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      ...process.env,
      APP_ENV: "test",
      PUBLIC_ORIGIN: "http://127.0.0.1:8080",
      HTTP_ADDRESS: "127.0.0.1:8080",
      STATIC_DIR: `${root}/frontend/dist`,
      DATABASE_URL: databaseURL,
      MIGRATIONS_DIR: "migrations",
      SESSION_TOKEN_PEPPER: "e2e-session-token-pepper-123456",
      CSRF_TOKEN_PEPPER: "e2e-csrf-token-pepper-123456789",
      BOOTSTRAP_ID_PEPPER: "e2e-bootstrap-pepper-1234567890",
      RATE_LIMIT_HMAC_SECRET: "e2e-rate-limit-secret-123456789",
      RECAPTCHA_ENABLED: "false",
    },
  },
});
