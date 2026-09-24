import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PropsWithChildren } from "react";

import type { AuthenticatedRequestLease } from "../../shared/api/client";
import {
  AuthenticatedRequestLeaseContext,
  SessionContext,
} from "../auth/sessionContext";
import { getLaunchStatus } from "./api";
import { ProductionLaunchGate } from "./ProductionLaunchGate";

vi.mock("./api", () => ({ getLaunchStatus: vi.fn() }));

const lease: AuthenticatedRequestLease = {
  expectedUserId: "00000000-0000-7000-8000-000000000001",
  signal: new AbortController().signal,
  isCurrent: () => true,
};

function Harness({ children }: PropsWithChildren) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return (
    <QueryClientProvider client={client}>
      <SessionContext.Provider
        value={{
          user: {
            id: lease.expectedUserId,
            googleConnected: false,
            googleEmail: null,
          },
          csrfToken: "csrf-token",
        }}
      >
        <AuthenticatedRequestLeaseContext.Provider value={lease}>
          {children}
        </AuthenticatedRequestLeaseContext.Provider>
      </SessionContext.Provider>
    </QueryClientProvider>
  );
}

describe("ProductionLaunchGate", () => {
  beforeEach(() => vi.mocked(getLaunchStatus).mockReset());

  it.each([
    [false, true, true],
    [true, false, true],
    [true, true, true],
  ])(
    "renders the application for public=%s allowed=%s",
    async (publicAccessEnabled, userAllowed, canAccess) => {
      vi.mocked(getLaunchStatus).mockResolvedValue({
        publicAccessEnabled,
        userAllowed,
        canAccess,
      });
      render(
        <Harness>
          <ProductionLaunchGate>
            <p>application</p>
          </ProductionLaunchGate>
        </Harness>,
      );
      expect(await screen.findByText("application")).toBeVisible();
      expect(getLaunchStatus).toHaveBeenCalledWith(lease);
    },
  );

  it("shows the limited-release screen for an unlisted user while closed", async () => {
    vi.mocked(getLaunchStatus).mockResolvedValue({
      publicAccessEnabled: false,
      userAllowed: false,
      canAccess: false,
    });
    render(
      <Harness>
        <ProductionLaunchGate>
          <p>application</p>
        </ProductionLaunchGate>
      </Harness>,
    );
    expect(
      await screen.findByText(/現在、このサービスは限定公開中です/),
    ).toBeVisible();
    expect(screen.queryByText("application")).not.toBeInTheDocument();
  });

  it("fails closed and retries an unavailable status", async () => {
    vi.mocked(getLaunchStatus)
      .mockRejectedValueOnce(new Error("unavailable"))
      .mockResolvedValueOnce({
        publicAccessEnabled: false,
        userAllowed: true,
        canAccess: true,
      });
    render(
      <Harness>
        <ProductionLaunchGate>
          <p>application</p>
        </ProductionLaunchGate>
      </Harness>,
    );
    await userEvent.click(
      await screen.findByRole("button", { name: "再試行" }),
    );
    await waitFor(() => expect(screen.getByText("application")).toBeVisible());
    expect(getLaunchStatus).toHaveBeenCalledTimes(2);
  });
});
