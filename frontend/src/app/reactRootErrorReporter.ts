import type { RootOptions } from "react-dom/client";

import {
  toErrorPresentation,
  type ErrorPresentation,
} from "../shared/api/errorPresentation";

export type ReactRootErrorReport = Readonly<{
  event: "react-root-error";
  phase: "caught" | "uncaught" | "recoverable";
  code: ErrorPresentation["code"];
  requestId?: string;
}>;

export type ReactRootErrorReporter = (report: ReactRootErrorReport) => void;

type ReactRootErrorOptions = {
  readonly onCaughtError: NonNullable<RootOptions["onCaughtError"]>;
  readonly onUncaughtError: NonNullable<RootOptions["onUncaughtError"]>;
  readonly onRecoverableError: NonNullable<RootOptions["onRecoverableError"]>;
};

function sanitizedReport(
  phase: ReactRootErrorReport["phase"],
  error: unknown,
): ReactRootErrorReport {
  const presentation = toErrorPresentation(error);
  const base = {
    event: "react-root-error",
    phase,
    code: presentation.code,
  } as const;
  return presentation.requestId === undefined
    ? base
    : { ...base, requestId: presentation.requestId };
}

export function createReactRootErrorOptions(
  report: ReactRootErrorReporter,
): ReactRootErrorOptions {
  return {
    onCaughtError(error) {
      report(sanitizedReport("caught", error));
    },
    onUncaughtError(error) {
      report(sanitizedReport("uncaught", error));
    },
    onRecoverableError(error) {
      report(sanitizedReport("recoverable", error));
    },
  };
}

function reportReactRootError(report: ReactRootErrorReport): void {
  console.error(report);
}

export const reactRootErrorOptions =
  createReactRootErrorOptions(reportReactRootError);
