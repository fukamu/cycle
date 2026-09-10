import { fireEvent, render, screen, within } from "@testing-library/react";

import { cycleFrameTemplateCopy } from "../../shared/copy/ja";
import { CycleFrameTemplatePicker } from "./CycleFrameTemplatePicker";

describe("CycleFrameTemplatePicker", () => {
  it("shows every Plan name, purpose, and exact preview before explicit insertion", () => {
    const onInsert = vi.fn();
    render(
      <CycleFrameTemplatePicker
        frame="plan"
        disabledReason={undefined}
        canUndo={false}
        onInsert={onInsert}
        onUndo={() => undefined}
      />,
    );

    const picker = screen.getByRole("region", {
      name: cycleFrameTemplateCopy.heading,
    });
    for (const template of cycleFrameTemplateCopy.templates.plan) {
      expect(
        within(picker).getByRole("heading", { name: template.name }),
      ).toBeVisible();
      const purpose = within(picker).getByText(template.purpose);
      const preview = within(picker).getByText(
        (_content, element) => element?.textContent === template.content,
      );
      const insert = within(picker).getByRole("button", {
        name: cycleFrameTemplateCopy.insert(template.name),
      });
      expect(purpose).toBeVisible();
      expect(preview).toBeVisible();
      expect(insert.getAttribute("aria-describedby")?.split(/\s+/)).toEqual(
        expect.arrayContaining([purpose.id, preview.id]),
      );
      expect(insert).toHaveAttribute("aria-disabled", "false");
    }

    const selected = cycleFrameTemplateCopy.templates.plan[0];
    fireEvent.click(
      within(picker).getByRole("button", {
        name: cycleFrameTemplateCopy.insert(selected.name),
      }),
    );
    expect(onInsert).toHaveBeenCalledOnce();
    expect(onInsert).toHaveBeenCalledWith(selected);
  });

  it("keeps previews available while insertion is disabled with an accessible reason", () => {
    const onInsert = vi.fn();
    const reason = cycleFrameTemplateCopy.disabled.hasContent("D");
    render(
      <CycleFrameTemplatePicker
        frame="do"
        disabledReason={reason}
        canUndo
        onInsert={onInsert}
        onUndo={() => undefined}
      />,
    );

    const status = screen.getByRole("status");
    expect(status).toHaveTextContent(reason);
    for (const template of cycleFrameTemplateCopy.templates.do) {
      expect(
        screen.getByText(
          (_content, element) => element?.textContent === template.content,
        ),
      ).toBeVisible();
      const insert = screen.getByRole("button", {
        name: cycleFrameTemplateCopy.insert(template.name),
      });
      expect(insert).toHaveAttribute("aria-disabled", "true");
      expect(insert.getAttribute("aria-describedby")?.split(/\s+/)).toContain(
        status.id,
      );
      fireEvent.click(insert);
    }
    expect(onInsert).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: cycleFrameTemplateCopy.undo }),
    ).toBeVisible();
  });
});
