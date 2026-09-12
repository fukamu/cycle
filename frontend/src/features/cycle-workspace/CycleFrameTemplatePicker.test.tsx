import { fireEvent, render, screen, within } from "@testing-library/react";

import { cycleFrameTemplateCopy } from "../../shared/copy/ja";
import { CycleFrameTemplatePicker } from "./CycleFrameTemplatePicker";

describe("CycleFrameTemplatePicker", () => {
  it("keeps optional templates collapsed until explicit expansion, then shows every Plan preview before insertion", () => {
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
    const toggle = within(picker).getByRole("button", {
      name: cycleFrameTemplateCopy.toggle,
    });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(
      within(picker).queryByRole("heading", {
        name: cycleFrameTemplateCopy.templates.plan[0].name,
      }),
    ).not.toBeInTheDocument();

    fireEvent.click(toggle);

    expect(toggle).toHaveAttribute("aria-expanded", "true");
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

  it("shows previews and an accessible disabled reason after expansion", () => {
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

    const toggle = screen.getByRole("button", {
      name: cycleFrameTemplateCopy.toggle,
    });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();

    fireEvent.click(toggle);

    expect(toggle).toHaveAttribute("aria-expanded", "true");
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
