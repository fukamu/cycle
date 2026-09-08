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
  it("describes simple content by default", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole("button", { name: "削除を開く" }));
    const dialog = screen.getByRole("dialog");
    const description =
      screen.getByText("この操作は取り消せません。").parentElement;

    expect(dialog).toHaveAttribute("aria-describedby", description?.id);
  });

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

  it("can leave structured content out of a flattened accessible description", () => {
    render(
      <ConfirmationDialog
        title="構造を確認"
        confirmLabel="確定"
        describeContent={false}
        onCancel={() => undefined}
        onConfirm={() => undefined}
      >
        <section>
          <h3>項目</h3>
          <button type="button">編集</button>
        </section>
      </ConfirmationDialog>,
    );

    const dialog = screen.getByRole("dialog", { name: "構造を確認" });
    expect(dialog).not.toHaveAttribute("aria-describedby");
    expect(screen.getByRole("heading", { name: "項目" })).toBeVisible();
    expect(screen.getByRole("button", { name: "編集" })).toBeVisible();
  });
});
