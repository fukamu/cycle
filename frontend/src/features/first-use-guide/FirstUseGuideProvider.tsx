/* eslint-disable react-refresh/only-export-components -- The constrained guide module owns its private registration hook beside the Provider. */
import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PropsWithChildren,
} from "react";

import {
  markFirstUseGuideStageShownInDocument,
  persistFirstUseGuideSkipped,
  persistFirstUseGuideStageShown,
  shouldShowFirstUseGuideStage,
  skipFirstUseGuideInDocument,
  type FirstUseGuideStage,
} from "../../shared/preferences/firstUseGuidePreference";

export type FirstUseGuidePersistence = {
  readonly persistStageShown: (
    stage: FirstUseGuideStage,
    ownership: FirstUseGuidePersistenceOwnership,
  ) => void;
  readonly persistSkipped: (
    ownership: FirstUseGuidePersistenceOwnership,
  ) => void;
};

export type FirstUseGuidePersistenceOwnership = {
  readonly isCurrent: () => boolean;
};

const synchronousPersistence: FirstUseGuidePersistence = {
  persistStageShown: (stage) => persistFirstUseGuideStageShown(stage),
  persistSkipped: () => persistFirstUseGuideSkipped(),
};

export type FirstUseGuideControls = {
  readonly canReplay: boolean;
  readonly replayPending: boolean;
  readonly replayCurrentGuide: () => void;
  readonly cancelReplay: () => void;
};

export type FirstUseGuideDisplaySource = "auto" | "replay";

type GuideRegistration = {
  readonly token: symbol;
  readonly stage: FirstUseGuideStage;
  readonly show: (
    stage: FirstUseGuideStage,
    source: FirstUseGuideDisplaySource,
  ) => void;
};

type RegisterGuideOptions = {
  readonly stage: FirstUseGuideStage;
  readonly autoEligible: boolean;
  readonly show: GuideRegistration["show"];
};

type FirstUseGuideContextValue = FirstUseGuideControls & {
  readonly registerGuide: (options: RegisterGuideOptions) => () => void;
  readonly confirmAutoShown: (stage: FirstUseGuideStage) => void;
  readonly closeReplayStage: (stage: FirstUseGuideStage) => void;
  readonly endReplay: () => void;
  readonly skipGuide: () => void;
};

const FirstUseGuideContext = createContext<
  FirstUseGuideContextValue | undefined
>(undefined);

const unavailableControls: FirstUseGuideControls = {
  canReplay: false,
  replayPending: false,
  replayCurrentGuide: () => undefined,
  cancelReplay: () => undefined,
};

const unavailableRegistration = {
  providerAvailable: false,
  confirmAutoShown: () => undefined,
  closeReplayStage: () => undefined,
  endReplay: () => undefined,
  skipGuide: () => undefined,
} as const;

export function FirstUseGuideProvider({
  children,
  persistence = synchronousPersistence,
}: PropsWithChildren<{
  readonly persistence?: FirstUseGuidePersistence;
}>) {
  const registrationRef = useRef<GuideRegistration | undefined>(undefined);
  const replayArmedRef = useRef(false);
  const replayClosedStagesRef = useRef(new Set<FirstUseGuideStage>());
  const autoShownStagesRef = useRef(new Set<FirstUseGuideStage>());
  const autoSkippedRef = useRef(false);
  const [canReplay, setCanReplay] = useState(false);
  const [replayPending, setReplayPending] = useState(false);

  const registerGuide = useCallback((options: RegisterGuideOptions) => {
    const registration: GuideRegistration = {
      token: Symbol("first-use-guide"),
      stage: options.stage,
      show: options.show,
    };
    registrationRef.current = registration;
    setCanReplay(true);
    setReplayPending(false);

    if (replayArmedRef.current) {
      if (!replayClosedStagesRef.current.has(options.stage)) {
        options.show(options.stage, "replay");
      }
    } else if (
      options.autoEligible &&
      !autoSkippedRef.current &&
      !autoShownStagesRef.current.has(options.stage) &&
      shouldShowFirstUseGuideStage(options.stage)
    ) {
      options.show(options.stage, "auto");
    }

    return () => {
      if (registrationRef.current?.token !== registration.token) return;
      registrationRef.current = undefined;
      setCanReplay(false);
      if (replayArmedRef.current) setReplayPending(true);
    };
  }, []);

  const confirmAutoShown = useCallback(
    (stage: FirstUseGuideStage) => {
      if (autoShownStagesRef.current.has(stage)) return;
      const registration = registrationRef.current;
      if (registration?.stage !== stage) return;
      autoShownStagesRef.current.add(stage);
      markFirstUseGuideStageShownInDocument(stage);
      persistence.persistStageShown(stage, {
        isCurrent: () => registrationRef.current?.token === registration.token,
      });
    },
    [persistence],
  );

  const closeReplayStage = useCallback((stage: FirstUseGuideStage) => {
    if (replayArmedRef.current) {
      replayClosedStagesRef.current.add(stage);
    }
  }, []);

  const endReplay = useCallback(() => {
    replayArmedRef.current = false;
    replayClosedStagesRef.current.clear();
    setReplayPending(false);
  }, []);

  const replayCurrentGuide = useCallback(() => {
    replayArmedRef.current = true;
    replayClosedStagesRef.current.clear();
    const registration = registrationRef.current;
    if (registration) {
      setReplayPending(false);
      registration.show(registration.stage, "replay");
      return;
    }
    setReplayPending(true);
  }, []);

  const cancelReplay = endReplay;

  const skipGuide = useCallback(() => {
    const registration = registrationRef.current;
    if (skipFirstUseGuideInDocument()) {
      if (registration !== undefined) {
        persistence.persistSkipped({
          isCurrent: () =>
            registrationRef.current?.token === registration.token,
        });
      }
    }
    autoSkippedRef.current = true;
    replayArmedRef.current = false;
    replayClosedStagesRef.current.clear();
    setReplayPending(false);
  }, [persistence]);

  const value = useMemo<FirstUseGuideContextValue>(
    () => ({
      canReplay,
      replayPending,
      replayCurrentGuide,
      cancelReplay,
      registerGuide,
      confirmAutoShown,
      closeReplayStage,
      endReplay,
      skipGuide,
    }),
    [
      canReplay,
      cancelReplay,
      closeReplayStage,
      confirmAutoShown,
      endReplay,
      registerGuide,
      replayCurrentGuide,
      replayPending,
      skipGuide,
    ],
  );

  return (
    <FirstUseGuideContext.Provider value={value}>
      {children}
    </FirstUseGuideContext.Provider>
  );
}

export function useFirstUseGuideControls(): FirstUseGuideControls {
  const context = useContext(FirstUseGuideContext);
  return context ?? unavailableControls;
}

export function useFirstUseGuideRegistration({
  stage,
  autoEligible,
  replayEligible,
  show,
}: RegisterGuideOptions & { readonly replayEligible: boolean }) {
  const context = useContext(FirstUseGuideContext);
  const registerGuide = context?.registerGuide;

  useLayoutEffect(() => {
    if (!registerGuide || !replayEligible) return;
    return registerGuide({ stage, autoEligible, show });
  }, [autoEligible, registerGuide, replayEligible, show, stage]);

  if (!context) return unavailableRegistration;
  return {
    providerAvailable: true,
    confirmAutoShown: context.confirmAutoShown,
    closeReplayStage: context.closeReplayStage,
    endReplay: context.endReplay,
    skipGuide: context.skipGuide,
  } as const;
}
