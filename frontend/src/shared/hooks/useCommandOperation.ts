import { useCallback, useRef } from "react";

import { APIError } from "../api/client";
import { newUUIDv7 } from "../id/uuid";

export type CommandFingerprintField = string | number | boolean | null;

export function commandFingerprint(
  command: string,
  fields: Readonly<Record<string, CommandFingerprintField>>,
): string {
  if (command.length === 0) throw new TypeError("command must not be empty");
  const entries = Object.entries(fields).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  for (const [, value] of entries) {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new RangeError("command fingerprint numbers must be finite");
    }
  }
  return JSON.stringify([command, entries]);
}

type RetainedOperation = {
  readonly fingerprint: string;
  readonly operationId: string;
  readonly replaceOnNextInvocation: boolean;
};

function isDefinitiveFailure(error: unknown): boolean {
  return (
    error instanceof APIError &&
    error.code !== "AI_OPERATION_IN_PROGRESS" &&
    error.code !== "INVALID_ERROR_RESPONSE"
  );
}

export function useCommandOperation() {
  const retainedRef = useRef<RetainedOperation | undefined>(undefined);

  const invoke = useCallback(
    async <T>(
      fingerprint: string,
      execute: (operationId: string) => Promise<T>,
    ): Promise<T> => {
      const retained = retainedRef.current;
      const operation =
        retained === undefined ||
        retained.fingerprint !== fingerprint ||
        retained.replaceOnNextInvocation
          ? {
              fingerprint,
              operationId: newUUIDv7(),
              replaceOnNextInvocation: false,
            }
          : retained;
      retainedRef.current = operation;

      try {
        const result = await execute(operation.operationId);
        if (retainedRef.current?.operationId === operation.operationId) {
          retainedRef.current = undefined;
        }
        return result;
      } catch (error) {
        if (
          retainedRef.current?.operationId === operation.operationId &&
          isDefinitiveFailure(error)
        ) {
          retainedRef.current = {
            ...operation,
            replaceOnNextInvocation: true,
          };
        }
        throw error;
      }
    },
    [],
  );

  const abandon = useCallback(() => {
    retainedRef.current = undefined;
  }, []);

  return { abandon, invoke } as const;
}
