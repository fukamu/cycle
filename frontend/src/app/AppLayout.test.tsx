import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect, useState, type ReactNode } from "react";
import {
  MemoryRouter,
  Route,
  Routes,
  useOutletContext,
} from "react-router-dom";

import { AppLayout, type AppOutletContext } from "./AppLayout";

describe("AppLayout", () => {
  it("requests plan navigation when clicked from another screen", async () => {
    const user = userEvent.setup();
    renderLayout("/settings", <HomeProbe />);

    await clickWordmark(user);

    expect(screen.getByText("Pへの移動要求あり")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "移動完了" }));
    expect(screen.getByText("移動要求なし")).toBeInTheDocument();
  });

  it("calls the registered editor handler when clicked from home", async () => {
    const user = userEvent.setup();
    renderLayout("/", <RegisteredHomeProbe />);

    await clickWordmark(user);

    expect(screen.getByText("登録済みのP移動を実行")).toBeInTheDocument();
  });
});

async function clickWordmark(user: ReturnType<typeof userEvent.setup>) {
  await user.click(
    screen.getByRole("link", {
      name: "PDCAI 現在のサイクルのPへ",
    }),
  );
}

function renderLayout(initialEntry: string, homeElement: ReactNode) {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route element={<AppLayout />}>
          <Route index element={homeElement} />
          <Route path="settings" element={<p>設定</p>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

function RegisteredHomeProbe() {
  const { registerPlanNavigationHandler } =
    useOutletContext<AppOutletContext>();
  const [handled, setHandled] = useState(false);
  useEffect(
    () => registerPlanNavigationHandler(() => setHandled(true)),
    [registerPlanNavigationHandler],
  );
  return <p>{handled ? "登録済みのP移動を実行" : "待機中"}</p>;
}

function HomeProbe() {
  const { planNavigationRequested, onPlanNavigationHandled } =
    useOutletContext<AppOutletContext>();
  return planNavigationRequested ? (
    <div>
      <p>Pへの移動要求あり</p>
      <button type="button" onClick={onPlanNavigationHandled}>
        移動完了
      </button>
    </div>
  ) : (
    <p>移動要求なし</p>
  );
}
