import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";

import { ConfirmationDialog } from "./ConfirmationDialog";

function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        削除を開く
      </button>
      {open && (
        <ConfirmationDialog
          title="削除しますか？"
          confirmLabel="削除"
          onCancel={() => setOpen(false)}
          onConfirm={() => setOpen(false)}
        >
          <p>この操作は取り消せません。</p>
        </ConfirmationDialog>
      )}
    </>
  );
}

describe("ConfirmationDialog", () => {
  it("returns focus to the trigger after canceling", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "削除を開く" });

    await user.click(trigger);
    await user.click(
      screen.getByRole("button", {
        name: "キャンセル",
      }),
    );

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
});
