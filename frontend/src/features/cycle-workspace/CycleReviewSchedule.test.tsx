import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { Cycle } from "../../shared/api/schemas";
import { reviewScheduleCopy } from "../../shared/copy/ja";
import { CycleReviewSchedule } from "./CycleReviewSchedule";

const activeSchedule: Pick<
  Cycle,
  "status" | "reviewDate" | "reviewScheduleRevision"
> = {
  status: "active",
  reviewDate: null,
  reviewScheduleRevision: 0,
};

describe("CycleReviewSchedule", () => {
  it("submits an explicit canonical date with the independent revision", async () => {
    const onSubmit = vi.fn().mockResolvedValue({
      kind: "saved",
      schedule: {
        reviewDate: "2026-09-25",
        reviewScheduleRevision: 1,
      },
    });
    const onPendingChange = vi.fn();
    render(
      <CycleReviewSchedule
        cycle={activeSchedule}
        today="2026-09-15"
        terminalCommandGuidanceId="review-schedule-pending"
        onSubmit={onSubmit}
        onPendingChange={onPendingChange}
      />,
    );

    const input = screen.getByLabelText(reviewScheduleCopy.inputLabel);
    expect(input).toHaveAttribute("min", "0001-01-01");
    expect(input).toHaveAttribute("max", "9999-12-31");
    fireEvent.change(input, { target: { value: "2026-09-25" } });
    fireEvent.click(
      screen.getByRole("button", { name: reviewScheduleCopy.set }),
    );

    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith({
        action: "set",
        reviewDate: "2026-09-25",
        expectedReviewScheduleRevision: 0,
      }),
    );
    expect(onPendingChange.mock.calls).toEqual([[true], [false]]);
    expect(screen.getByText(reviewScheduleCopy.saved)).toBeVisible();
  });

  it("clears explicitly without inventing a reviewDate member", async () => {
    const onSubmit = vi.fn().mockResolvedValue({
      kind: "saved",
      schedule: { reviewDate: null, reviewScheduleRevision: 3 },
    });
    render(
      <CycleReviewSchedule
        cycle={{
          ...activeSchedule,
          reviewDate: "2026-09-25",
          reviewScheduleRevision: 2,
        }}
        today="2026-09-15"
        terminalCommandGuidanceId="review-schedule-pending"
        onSubmit={onSubmit}
        onPendingChange={vi.fn()}
      />,
    );

    expect(screen.getByText("2026-09-25")).toHaveAttribute(
      "datetime",
      "2026-09-25",
    );
    expect(screen.getByText("（予定日です）")).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", { name: reviewScheduleCopy.clear }),
    );

    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith({
        action: "clear",
        expectedReviewScheduleRevision: 2,
      }),
    );
  });

  it("keeps a dirty date for explicit retry after a conflict", async () => {
    const onSubmit = vi.fn().mockResolvedValue({
      kind: "conflict",
      message: reviewScheduleCopy.conflict,
    });
    render(
      <CycleReviewSchedule
        cycle={activeSchedule}
        today="2026-09-15"
        terminalCommandGuidanceId="review-schedule-pending"
        onSubmit={onSubmit}
        onPendingChange={vi.fn()}
      />,
    );

    const input = screen.getByLabelText(reviewScheduleCopy.inputLabel);
    fireEvent.change(input, { target: { value: "2026-09-25" } });
    fireEvent.click(
      screen.getByRole("button", { name: reviewScheduleCopy.set }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      reviewScheduleCopy.conflict,
    );
    expect(input).toHaveValue("2026-09-25");
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("renders a terminal Cycle as read-only exact-date context", () => {
    render(
      <CycleReviewSchedule
        cycle={{
          status: "completed",
          reviewDate: "2026-09-15",
          reviewScheduleRevision: 4,
        }}
        today="2026-09-15"
        terminalCommandGuidanceId="review-schedule-pending"
        onSubmit={vi.fn()}
        onPendingChange={vi.fn()}
      />,
    );

    expect(screen.getByText("2026-09-15")).toHaveAttribute(
      "datetime",
      "2026-09-15",
    );
    expect(screen.getByText("（本日です）")).toBeVisible();
    expect(screen.getByText(reviewScheduleCopy.terminal)).toBeVisible();
    expect(screen.queryByRole("form")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByLabelText(reviewScheduleCopy.inputLabel)).toBeNull();
  });
});
