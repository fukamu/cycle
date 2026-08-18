import { useCallback, useEffect, useRef, useState } from "react";

import {
  deleteBrowserDraft,
  getBrowserDraft,
  putBrowserDraft,
} from "../drafts/browserDraftCache";

export type SimpleSaveState = "dirty" | "saving" | "saved" | "failed";

type Input = {
  readonly userId: string;
  readonly subjectKey: string;
  readonly initialBody: string;
  readonly initialRevision: number;
  readonly save: (
    body: string,
    revision: number,
  ) => Promise<{ readonly body: string; readonly revision: number }>;
};

export function useDraftAutoSave(input: Input) {
  const [body, setBodyState] = useState(input.initialBody);
  const [revision, setRevision] = useState(input.initialRevision);
  const [state, setState] = useState<SimpleSaveState>("saved");
  const [retryNonce, setRetryNonce] = useState(0);
  const bodyRef = useRef(body);
  const revisionRef = useRef(revision);
  const savedBody = useRef(input.initialBody);
  const inFlight = useRef(false);

  useEffect(() => {
    void getBrowserDraft(input.userId, input.subjectKey).then((draft) => {
      if (
        draft &&
        draft.baseRevision === revisionRef.current &&
        draft.body !== savedBody.current
      ) {
        bodyRef.current = draft.body;
        setBodyState(draft.body);
        setState("dirty");
      }
    });
  }, [input.subjectKey, input.userId]);

  const setBody = useCallback(
    (value: string) => {
      bodyRef.current = value;
      setBodyState(value);
      setState(value === savedBody.current ? "saved" : "dirty");
      if (value === savedBody.current)
        void deleteBrowserDraft(input.userId, input.subjectKey);
      else
        void putBrowserDraft({
          userId: input.userId,
          subjectKey: input.subjectKey,
          body: value,
          baseRevision: revisionRef.current,
          updatedAt: new Date().toISOString(),
        });
    },
    [input.subjectKey, input.userId],
  );

  useEffect(() => {
    if (state !== "dirty" || inFlight.current) return;
    const timer = window.setTimeout(async () => {
      const snapshot = bodyRef.current;
      const base = revisionRef.current;
      inFlight.current = true;
      setState("saving");
      try {
        const result = await input.save(snapshot, base);
        revisionRef.current = result.revision;
        setRevision(result.revision);
        savedBody.current = result.body;
        if (bodyRef.current === snapshot) {
          bodyRef.current = result.body;
          setBodyState(result.body);
          setState("saved");
          await deleteBrowserDraft(input.userId, input.subjectKey);
        } else {
          await putBrowserDraft({
            userId: input.userId,
            subjectKey: input.subjectKey,
            body: bodyRef.current,
            baseRevision: result.revision,
            updatedAt: new Date().toISOString(),
          });
          setState("dirty");
        }
      } catch {
        setState("failed");
      } finally {
        inFlight.current = false;
      }
    }, 800);
    return () => window.clearTimeout(timer);
  }, [input, retryNonce, state]);

  const synchronize = useCallback(
    (nextBody: string, nextRevision: number) => {
      bodyRef.current = nextBody;
      revisionRef.current = nextRevision;
      savedBody.current = nextBody;
      setBodyState(nextBody);
      setRevision(nextRevision);
      setState("saved");
      void deleteBrowserDraft(input.userId, input.subjectKey);
    },
    [input.subjectKey, input.userId],
  );

  return {
    body,
    setBody,
    revision,
    state,
    retry: () => {
      setState("dirty");
      setRetryNonce((value) => value + 1);
    },
    synchronize,
  };
}
