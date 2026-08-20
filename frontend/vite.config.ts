import react from "@vitejs/plugin-react";
import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";

import {
  parseDeploymentEnvironment,
  searchIndexingPlugin,
} from "./vite/searchIndexing";

export default defineConfig(({ mode }) => {
  const environment = loadEnv(mode, process.cwd(), "VITE_");
  const deploymentEnvironment = parseDeploymentEnvironment(
    environment.VITE_DEPLOYMENT_ENV,
  );

  return {
    plugins: [react(), searchIndexingPlugin(deploymentEnvironment)],
    server: {
      proxy: {
        "/api": "http://localhost:8080",
      },
    },
    test: {
      include: ["src/**/*.{test,spec}.{ts,tsx}", "vite/**/*.{test,spec}.ts"],
      environment: "jsdom",
      setupFiles: "./src/test/setup.ts",
      css: true,
      globals: true,
    },
  };
});
