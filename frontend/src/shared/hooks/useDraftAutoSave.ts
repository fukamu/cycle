import { useCallback, useEffect, useRef, useState } from "react";
import { useForm, useWatch } from "react-hook-form";

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
  const { initialBody, initialRevision, save, subjectKey, userId } = input;
  const { control, reset, setValue } = useForm<{ body: string }>({
    defaultValues: { body: initialBody },
  });
  const body = useWatch({ control, name: "body" });
  const [revision, setRevision] = useState(initialRevision);
  const [state, setState] = useState<SimpleSaveState>("saved");
  const [retryNonce, setRetryNonce] = useState(0);
  const bodyRef = useRef(body);
  const revisionRef = useRef(revision);
  const savedBody = useRef(initialBody);
  const inFlight = useRef(false);
  const paused = useRef(false);

  useEffect(() => {
    void getBrowserDraft(userId, subjectKey).then((draft) => {
      if (
        draft &&
        draft.baseRevision === revisionRef.current &&
        draft.body !== savedBody.current
      ) {
        bodyRef.current = draft.body;
        setValue("body", draft.body);
        setState("dirty");
      }
    });
  }, [setValue, subjectKey, userId]);

  const setBody = useCallback(
    (value: string) => {
      bodyRef.current = value;
      setValue("body", value);
      setState(value === savedBody.current ? "saved" : "dirty");
      if (value === savedBody.current)
        void deleteBrowserDraft(userId, subjectKey);
      else
        void putBrowserDraft({
          userId,
          subjectKey,
          body: value,
          baseRevision: revisionRef.current,
          updatedAt: new Date().toISOString(),
        });
    },
    [setValue, subjectKey, userId],
  );

  useEffect(() => {
    if (state !== "dirty" || inFlight.current) return;
    const timer = window.setTimeout(async () => {
      if (paused.current) return;
      const snapshot = bodyRef.current;
      const base = revisionRef.current;
      inFlight.current = true;
      setState("saving");
      let drainQueue = false;
      try {
        const result = await save(snapshot, base);
        revisionRef.current = result.revision;
        setRevision(result.revision);
        savedBody.current = result.body;
        if (bodyRef.current === snapshot) {
          bodyRef.current = result.body;
          reset({ body: result.body });
          setState("saved");
          await deleteBrowserDraft(userId, subjectKey);
        } else {
          await putBrowserDraft({
            userId,
            subjectKey,
            body: bodyRef.current,
            baseRevision: result.revision,
            updatedAt: new Date().toISOString(),
          });
          drainQueue = true;
        }
      } catch {
        setState("failed");
      } finally {
        inFlight.current = false;
        if (drainQueue) {
          setState("dirty");
          setRetryNonce((value) => value + 1);
        }
      }
    }, 800);
    return () => window.clearTimeout(timer);
  }, [reset, retryNonce, save, state, subjectKey, userId]);

  const synchronize = useCallback(
    (nextBody: string, nextRevision: number) => {
      bodyRef.current = nextBody;
      revisionRef.current = nextRevision;
      savedBody.current = nextBody;
      reset({ body: nextBody });
      setRevision(nextRevision);
      setState("saved");
      void deleteBrowserDraft(userId, subjectKey);
    },
    [reset, subjectKey, userId],
  );

  const pause = useCallback(() => {
    paused.current = true;
  }, []);

  const resume = useCallback(() => {
    paused.current = false;
    if (bodyRef.current !== savedBody.current) {
      setState("dirty");
      setRetryNonce((value) => value + 1);
    }
  }, []);

  const discard = useCallback(async () => {
    paused.current = true;
    await deleteBrowserDraft(userId, subjectKey);
  }, [subjectKey, userId]);

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
    pause,
    resume,
    discard,
  };
}
