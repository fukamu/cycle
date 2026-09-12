import { QueryClient } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import { useLayoutEffect, useRef } from "react";

import type { Session } from "../../shared/api/schemas";
import type { SessionRecoverySubscription } from "../../shared/api/sessionRecoveryEvents";
import { createAutoSaveScopeRegistry } from "../../shared/autosave/AutoSaveScopeProvider";
import {
  activateFirstUseGuide,
  firstUseGuideStages,
  markFirstUseGuideStageShown,
  readFirstUseGuidePreferences,
  shouldShowFirstUseGuideStage,
  skipFirstUseGuide,
} from "../../shared/preferences/firstUseGuidePreference";
import {
  readSelectedCycleFrame,
  rememberSelectedCycleFrame,
} from "../../shared/preferences/selectedFramePreference";
import { useAuthenticatedRequestLeaseOwner } from "./authenticatedRequestLeaseOwner";
import { useSessionPublicationController } from "./useSessionPublicationController";

const currentSession: Session = {
  user: {
    id: "10000000-0000-7000-8000-000000000001",
    googleConnected: false,
    googleEmail: null,
  },
  csrfToken: "current-csrf",
};

const nextSession: Session = {
  user: {
    id: "10000000-0000-7000-8000-000000000002",
    googleConnected: true,
    googleEmail: "next@example.com",
  },
  csrfToken: "next-csrf",
};

describe("useSessionPublicationController selected Frame cleanup", () => {
  beforeEach(() => window.localStorage.clear());

  it("clears all Cycle preferences only after a different User is published", async () => {
    const queryClient = new QueryClient();
    const sessionQueryKey = ["session"] as const;
    queryClient.setQueryData(sessionQueryKey, currentSession);
    const cycleId = "40000000-0000-7000-8000-000000000001";
    rememberSelectedCycleFrame(cycleId, "action");

    const { result } = renderHook(() => {
      const leaseOwner = useAuthenticatedRequestLeaseOwner();
      const childrenWrapperRef = useRef<HTMLDivElement | null>(null);
      const recoverySubscriptionRef =
        useRef<SessionRecoverySubscription | null>(null);
      useLayoutEffect(() => {
        leaseOwner.activate(currentSession.user.id);
      }, [leaseOwner]);
      return useSessionPublicationController({
        queryClient,
        sessionQueryKey,
        autoSaveScopes: createAutoSaveScopeRegistry(),
        childrenWrapperRef,
        leaseOwner,
        recoverySubscriptionRef,
      });
    });

    let published = false;
    await act(async () => {
      published = await result.current.publishSession(nextSession, {
        scopesAlreadyQuiesced: false,
        remountSameIdentity: false,
      });
    });

    expect(published).toBe(true);
    expect(queryClient.getQueryData(sessionQueryKey)).toEqual(nextSession);
    expect(readSelectedCycleFrame(cycleId, "active")).toBe("plan");
  });

  it("retains preferences when the same User session is refreshed", async () => {
    const queryClient = new QueryClient();
    const sessionQueryKey = ["session"] as const;
    queryClient.setQueryData(sessionQueryKey, currentSession);
    const cycleId = "40000000-0000-7000-8000-000000000001";
    rememberSelectedCycleFrame(cycleId, "check");

    const { result } = renderHook(() => {
      const leaseOwner = useAuthenticatedRequestLeaseOwner();
      const childrenWrapperRef = useRef<HTMLDivElement | null>(null);
      const recoverySubscriptionRef =
        useRef<SessionRecoverySubscription | null>(null);
      useLayoutEffect(() => {
        leaseOwner.activate(currentSession.user.id);
      }, [leaseOwner]);
      return useSessionPublicationController({
        queryClient,
        sessionQueryKey,
        autoSaveScopes: createAutoSaveScopeRegistry(),
        childrenWrapperRef,
        leaseOwner,
        recoverySubscriptionRef,
      });
    });

    await act(async () => {
      await result.current.publishSession(
        { ...currentSession, csrfToken: "refreshed-csrf" },
        { scopesAlreadyQuiesced: false, remountSameIdentity: false },
      );
    });

    expect(readSelectedCycleFrame(cycleId, "active")).toBe("check");
  });

  it("adopts the cookie writer's persistent Guide state without retaining the old document fence", async () => {
    const queryClient = new QueryClient();
    const sessionQueryKey = ["session"] as const;
    queryClient.setQueryData(sessionQueryKey, currentSession);
    activateFirstUseGuide();
    for (const stage of firstUseGuideStages) {
      markFirstUseGuideStageShown(stage);
    }
    skipFirstUseGuide();
    window.localStorage.clear();
    window.localStorage.setItem(
      "fukamu-cycle-first-use-guide-v1:eligible",
      "true",
    );
    expect(shouldShowFirstUseGuideStage("goal")).toBe(false);

    const { result } = renderHook(() => {
      const leaseOwner = useAuthenticatedRequestLeaseOwner();
      const childrenWrapperRef = useRef<HTMLDivElement | null>(null);
      const recoverySubscriptionRef =
        useRef<SessionRecoverySubscription | null>(null);
      useLayoutEffect(() => {
        leaseOwner.activate(currentSession.user.id);
      }, [leaseOwner]);
      return useSessionPublicationController({
        queryClient,
        sessionQueryKey,
        autoSaveScopes: createAutoSaveScopeRegistry(),
        childrenWrapperRef,
        leaseOwner,
        recoverySubscriptionRef,
      });
    });

    await act(async () => {
      await result.current.publishSession(nextSession, {
        scopesAlreadyQuiesced: false,
        remountSameIdentity: false,
        guidePreferencesReconciliation: "external",
      });
    });

    expect(queryClient.getQueryData(sessionQueryKey)).toEqual(nextSession);
    expect(readFirstUseGuidePreferences()).toEqual({
      eligible: true,
      skipped: false,
      shown: {
        goal: false,
        plan: false,
        do: false,
        check: false,
        action: false,
        review: false,
      },
    });
    expect(shouldShowFirstUseGuideStage("goal")).toBe(true);
  });

  it("adopts a reconciled Guide snapshot when the authoritative advisory confirms the same User", async () => {
    const queryClient = new QueryClient();
    const sessionQueryKey = ["session"] as const;
    queryClient.setQueryData(sessionQueryKey, currentSession);
    activateFirstUseGuide();
    skipFirstUseGuide();
    window.localStorage.clear();
    window.localStorage.setItem(
      "fukamu-cycle-first-use-guide-v1:eligible",
      "true",
    );
    expect(shouldShowFirstUseGuideStage("goal")).toBe(false);

    const { result } = renderHook(() => {
      const leaseOwner = useAuthenticatedRequestLeaseOwner();
      const childrenWrapperRef = useRef<HTMLDivElement | null>(null);
      const recoverySubscriptionRef =
        useRef<SessionRecoverySubscription | null>(null);
      useLayoutEffect(() => {
        leaseOwner.activate(currentSession.user.id);
      }, [leaseOwner]);
      return useSessionPublicationController({
        queryClient,
        sessionQueryKey,
        autoSaveScopes: createAutoSaveScopeRegistry(),
        childrenWrapperRef,
        leaseOwner,
        recoverySubscriptionRef,
      });
    });

    await act(async () => {
      await result.current.publishSession(currentSession, {
        scopesAlreadyQuiesced: false,
        remountSameIdentity: true,
        guidePreferencesReconciliation: "external",
      });
    });

    expect(shouldShowFirstUseGuideStage("goal")).toBe(true);
  });
});
