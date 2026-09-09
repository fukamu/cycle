import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";

import { useBoundedTextInput } from "./useBoundedTextInput";

function StatefulEditor({
  initialValue,
  maximumCodePoints,
  scopeKey = "scope-a",
  readOnly = false,
  onAccept,
  onCompositionChange,
}: {
  readonly initialValue: string;
  readonly maximumCodePoints: number;
  readonly scopeKey?: string;
  readonly readOnly?: boolean;
  readonly onAccept: (value: string) => void;
  readonly onCompositionChange?: (composing: boolean) => void;
}) {
  const [value, setValue] = useState(initialValue);
  const input = useBoundedTextInput({
    value,
    maximumCodePoints,
    scopeKey,
    readOnly,
    onAccept: (accepted) => {
      setValue(accepted);
      onAccept(accepted);
    },
    onCompositionChange,
  });
  return (
    <>
      <textarea
        aria-label="本文"
        readOnly={readOnly}
        value={input.value}
        onChange={input.onChange}
        onCompositionStart={input.onCompositionStart}
        onCompositionEnd={input.onCompositionEnd}
      />
      <output>{input.feedback}</output>
    </>
  );
}

describe("useBoundedTextInput", () => {
  it("rejects the whole over-limit replacement and clears feedback on a valid edit", () => {
    const onAccept = vi.fn();
    const original = "😀".repeat(3);
    render(
      <StatefulEditor
        initialValue={original}
        maximumCodePoints={3}
        onAccept={onAccept}
      />,
    );
    const editor = screen.getByRole("textbox", { name: "本文" });

    fireEvent.change(editor, { target: { value: "e\u0301😀😀" } });

    expect(editor).toHaveValue(original);
    expect(onAccept).not.toHaveBeenCalled();
    expect(screen.getByText(/入力後は4文字になるため/)).toHaveTextContent(
      "上限3文字まで、入力内容をあと1文字減らしてください。",
    );

    fireEvent.change(editor, { target: { value: "a\r\n😀" } });

    expect(editor).toHaveValue("a\n😀");
    expect(onAccept).toHaveBeenCalledOnce();
    expect(onAccept).toHaveBeenLastCalledWith("a\n😀");
    expect(screen.queryByText(/反映できませんでした/)).not.toBeInTheDocument();
  });

  it("keeps IME intermediate input local and evaluates the final candidate once", () => {
    const onAccept = vi.fn();
    const onCompositionChange = vi.fn();
    render(
      <StatefulEditor
        initialValue="元"
        maximumCodePoints={3}
        onAccept={onAccept}
        onCompositionChange={onCompositionChange}
      />,
    );
    const editor = screen.getByRole("textbox", { name: "本文" });

    fireEvent.compositionStart(editor);
    fireEvent.change(editor, { target: { value: "変換途中😀😀" } });

    expect(editor).toHaveValue("変換途中😀😀");
    expect(onAccept).not.toHaveBeenCalled();
    expect(screen.queryByText(/反映できませんでした/)).not.toBeInTheDocument();

    fireEvent.compositionEnd(editor);

    expect(editor).toHaveValue("元");
    expect(onAccept).not.toHaveBeenCalled();
    expect(screen.getByText(/入力後は6文字になるため/)).toBeInTheDocument();

    fireEvent.compositionStart(editor);
    fireEvent.change(editor, { target: { value: "確定😀" } });
    fireEvent.compositionEnd(editor);
    fireEvent.change(editor, { target: { value: "確定😀" } });

    expect(editor).toHaveValue("確定😀");
    expect(onAccept).toHaveBeenCalledOnce();
    expect(onAccept).toHaveBeenCalledWith("確定😀");
    expect(onCompositionChange.mock.calls).toEqual([
      [true],
      [false],
      [true],
      [false],
    ]);
  });

  it("clears feedback when the scope changes or the editor becomes read-only", () => {
    const onAccept = vi.fn();
    const view = render(
      <StatefulEditor
        initialValue="元"
        maximumCodePoints={1}
        onAccept={onAccept}
      />,
    );
    const editor = screen.getByRole("textbox", { name: "本文" });
    fireEvent.change(editor, { target: { value: "超過" } });
    expect(screen.getByText(/反映できませんでした/)).toBeInTheDocument();

    view.rerender(
      <StatefulEditor
        initialValue="元"
        maximumCodePoints={1}
        scopeKey="scope-b"
        onAccept={onAccept}
      />,
    );
    expect(screen.queryByText(/反映できませんでした/)).not.toBeInTheDocument();

    fireEvent.change(editor, { target: { value: "超過" } });
    expect(screen.getByText(/反映できませんでした/)).toBeInTheDocument();
    view.rerender(
      <StatefulEditor
        initialValue="元"
        maximumCodePoints={1}
        scopeKey="scope-b"
        readOnly
        onAccept={onAccept}
      />,
    );
    expect(screen.queryByText(/反映できませんでした/)).not.toBeInTheDocument();
  });
});
