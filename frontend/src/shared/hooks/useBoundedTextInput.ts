import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEvent,
  type CompositionEvent,
} from "react";

import { textLimitCopy } from "../copy/ja";
import { codePointCount, evaluateBoundedTextInput } from "../text/semantics";

type ScopedValue = {
  readonly scopeKey: string;
  readonly value: string;
};

type RenderedInput = {
  readonly scopeKey: string;
  readonly readOnly: boolean;
  readonly value: string;
};

type UseBoundedTextInputOptions = {
  readonly value: string;
  readonly maximumCodePoints: number;
  readonly scopeKey: string;
  readonly readOnly: boolean;
  readonly onAccept: (value: string) => void;
  readonly onCompositionChange?: ((composing: boolean) => void) | undefined;
};

export function useBoundedTextInput({
  value,
  maximumCodePoints,
  scopeKey,
  readOnly,
  onAccept,
  onCompositionChange,
}: UseBoundedTextInputOptions) {
  const acceptedValueRef = useRef(value);
  const composingRef = useRef(false);
  const scopeKeyRef = useRef(scopeKey);
  const onAcceptRef = useRef(onAccept);
  const onCompositionChangeRef = useRef(onCompositionChange);
  const [compositionValue, setCompositionValue] = useState<ScopedValue | null>(
    null,
  );
  const [feedback, setFeedback] = useState<ScopedValue | null>(null);
  const [renderedInput, setRenderedInput] = useState<RenderedInput>({
    scopeKey,
    readOnly,
    value,
  });

  if (
    renderedInput.scopeKey !== scopeKey ||
    renderedInput.readOnly !== readOnly ||
    renderedInput.value !== value
  ) {
    setRenderedInput({ scopeKey, readOnly, value });
    setCompositionValue(null);
    setFeedback(null);
  }

  const finishComposition = useCallback(() => {
    if (!composingRef.current) return;
    composingRef.current = false;
    onCompositionChangeRef.current?.(false);
  }, []);

  useLayoutEffect(() => {
    acceptedValueRef.current = value;
    onAcceptRef.current = onAccept;
    onCompositionChangeRef.current = onCompositionChange;
  }, [onAccept, onCompositionChange, value]);

  useLayoutEffect(() => {
    scopeKeyRef.current = scopeKey;
    finishComposition();
  }, [finishComposition, readOnly, scopeKey]);

  const acceptCandidate = useCallback(
    (candidate: string) => {
      const evaluation = evaluateBoundedTextInput(candidate, maximumCodePoints);
      if (evaluation.kind === "rejected") {
        setFeedback({
          scopeKey: scopeKeyRef.current,
          value: textLimitCopy.rejected(
            evaluation.requiredCodePoints,
            evaluation.maximumCodePoints,
            evaluation.excessCodePoints,
          ),
        });
        return;
      }

      setFeedback(null);
      if (evaluation.value === acceptedValueRef.current) return;
      acceptedValueRef.current = evaluation.value;
      onAcceptRef.current(evaluation.value);
    },
    [maximumCodePoints],
  );

  const onChange = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) => {
      const candidate = event.currentTarget.value;
      const nativeIsComposing =
        "isComposing" in event.nativeEvent &&
        event.nativeEvent.isComposing === true;
      if (composingRef.current || nativeIsComposing) {
        setCompositionValue({
          scopeKey: scopeKeyRef.current,
          value: candidate,
        });
        return;
      }
      acceptCandidate(candidate);
    },
    [acceptCandidate],
  );

  const onCompositionStart = useCallback(
    (event: CompositionEvent<HTMLTextAreaElement>) => {
      if (readOnly) return;
      composingRef.current = true;
      setCompositionValue({
        scopeKey: scopeKeyRef.current,
        value: event.currentTarget.value,
      });
      onCompositionChangeRef.current?.(true);
    },
    [readOnly],
  );

  const onCompositionEnd = useCallback(
    (event: CompositionEvent<HTMLTextAreaElement>) => {
      if (!composingRef.current) return;
      const candidate = event.currentTarget.value;
      finishComposition();
      setCompositionValue(null);
      acceptCandidate(candidate);
    },
    [acceptCandidate, finishComposition],
  );

  const displayValue =
    compositionValue?.scopeKey === scopeKey ? compositionValue.value : value;

  return {
    value: displayValue,
    count: codePointCount(displayValue),
    feedback: feedback?.scopeKey === scopeKey ? feedback.value : undefined,
    onChange,
    onCompositionStart,
    onCompositionEnd,
  } as const;
}
