import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { AppLayout } from "./AppLayout";

describe("AppLayout", () => {
  it("opens an accessible menu with goal history and settings", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <Routes>
          <Route element={<AppLayout />}>
            <Route index element={<p>ホーム本文</p>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.queryByText("MENU")).not.toBeInTheDocument();
    const trigger = screen.getByRole("button", { name: "メニューを開く" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    await user.click(trigger);
    expect(trigger).toHaveAccessibleName("メニューを閉じる");
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(
      screen.getByRole("navigation", { name: "メインメニュー" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "目標の履歴" })).toHaveAttribute(
      "href",
      "/history",
    );
    expect(screen.getByRole("link", { name: "設定" })).toHaveAttribute(
      "href",
      "/settings",
    );

    await user.keyboard("{Escape}");
    expect(
      screen.queryByRole("navigation", { name: "メインメニュー" }),
    ).not.toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "メニューを開く" }),
      ).toHaveFocus(),
    );
  });
});
