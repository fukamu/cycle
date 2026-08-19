import { render, screen } from "@testing-library/react";
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
    await user.click(screen.getByRole("button", { name: "メニューを開く" }));
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
  });
});
