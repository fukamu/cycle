import { useCallback, useEffect, useId, useState } from "react";

import { firstUseGuideCopy } from "../../shared/copy/ja";
import type { FirstUseGuideStage } from "../../shared/preferences/firstUseGuidePreference";
import { useInteractionAvailability } from "../../shared/interaction/interactionAvailabilityContext";
import {
  useFirstUseGuideRegistration,
  type FirstUseGuideDisplaySource,
} from "./FirstUseGuideProvider";

export type FirstUseGuideProps = {
  readonly stage: FirstUseGuideStage;
  readonly autoEligible: boolean;
  readonly replayEligible: boolean;
};

type VisibleGuide = {
  readonly stage: FirstUseGuideStage;
  readonly source: FirstUseGuideDisplaySource;
};

export function FirstUseGuide({
  stage,
  autoEligible,
  replayEligible,
}: FirstUseGuideProps) {
  const headingId = useId();
  const interactionAvailable = useInteractionAvailability();
  const [visibleGuide, setVisibleGuide] = useState<VisibleGuide>();
  const show = useCallback(
    (visibleStage: FirstUseGuideStage, source: FirstUseGuideDisplaySource) =>
      setVisibleGuide({ stage: visibleStage, source }),
    [],
  );
  const registration = useFirstUseGuideRegistration({
    stage,
    autoEligible,
    replayEligible: interactionAvailable && replayEligible,
    show,
  });
  const safeContext =
    registration.providerAvailable && interactionAvailable && replayEligible;
  const visible =
    safeContext &&
    (visibleGuide?.source !== "auto" || autoEligible) &&
    visibleGuide?.stage === stage;
  const staleGuide =
    visibleGuide !== undefined &&
    (!safeContext ||
      visibleGuide.stage !== stage ||
      (visibleGuide.source === "auto" && !autoEligible));

  useEffect(() => {
    if (visible && visibleGuide.source === "auto") {
      registration.confirmAutoShown(stage);
    }
  }, [registration, stage, visible, visibleGuide?.source]);

  if (staleGuide) {
    // Adjust this component's own previous-render state before committing an
    // unsafe automatic or replay panel. React immediately restarts this render.
    setVisibleGuide(undefined);
    return null;
  }

  if (!visible) return null;

  const copy = firstUseGuideCopy.stages[stage];

  const close = () => {
    if (visibleGuide.source === "replay") {
      registration.closeReplayStage(stage);
    }
    setVisibleGuide(undefined);
  };

  const skip = () => {
    registration.skipGuide();
    setVisibleGuide(undefined);
  };

  return (
    <aside className="first-use-guide" aria-labelledby={headingId}>
      <h2 id={headingId}>{firstUseGuideCopy.heading}</h2>
      <p className="first-use-guide__location">{copy.location}</p>
      <p className="first-use-guide__guide">{copy.guide}</p>
      <div className="first-use-guide__actions">
        <button
          className="button button--secondary"
          type="button"
          onClick={close}
        >
          {firstUseGuideCopy.close}
        </button>
        <button className="first-use-guide__skip" type="button" onClick={skip}>
          {firstUseGuideCopy.skip}
        </button>
      </div>
    </aside>
  );
}
