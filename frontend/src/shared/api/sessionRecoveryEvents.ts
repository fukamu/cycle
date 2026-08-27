export type SessionRecoveryReason =
  | "SESSION_MISSING"
  | "SESSION_EXPIRED"
  | "CSRF_INVALID"
  | "SESSION_IDENTITY_DRIFT"
  | "SESSION_IDENTITY_UNVERIFIED";

export type SessionRecoveryEvent = {
  readonly reason: SessionRecoveryReason;
  readonly isCurrent: () => boolean;
};

type SessionRecoveryListener = (event: SessionRecoveryEvent) => void;
type SessionRecoveryRegistration = {
  readonly listener: SessionRecoveryListener;
  active: boolean;
  generation: number;
};
type SessionRecoveryPublisher = (reason: SessionRecoveryReason) => void;

export type SessionRecoverySubscription = {
  readonly advanceGeneration: () => void;
  readonly unsubscribe: () => void;
};

export type SessionRecoveryEventBus = {
  readonly subscribe: (
    listener: SessionRecoveryListener,
  ) => SessionRecoverySubscription;
  readonly capturePublisher: () => SessionRecoveryPublisher;
};

/**
 * A notification-only technical bus between the transport and application
 * composition. It deliberately retains neither errors nor session state.
 */
export function createSessionRecoveryEventBus(): SessionRecoveryEventBus {
  const registrations = new Set<SessionRecoveryRegistration>();

  return {
    subscribe: (listener) => {
      const registration: SessionRecoveryRegistration = {
        listener,
        active: true,
        generation: 0,
      };
      registrations.add(registration);
      return {
        advanceGeneration: () => {
          registration.generation += 1;
        },
        unsubscribe: () => {
          registration.active = false;
          registrations.delete(registration);
        },
      };
    },
    capturePublisher: () => {
      const captured = [...registrations].map((registration) => ({
        registration,
        generation: registration.generation,
      }));
      return (reason) => {
        for (const entry of captured) {
          const isCurrent = () =>
            entry.registration.active &&
            entry.registration.generation === entry.generation;
          if (!isCurrent()) continue;
          try {
            entry.registration.listener({ reason, isCurrent });
          } catch {
            // Surface a fixed technical failure without leaking observer data.
            queueMicrotask(() => {
              throw new Error("session recovery observer failed");
            });
          }
        }
      };
    },
  };
}

export const sessionRecoveryEvents = createSessionRecoveryEventBus();
