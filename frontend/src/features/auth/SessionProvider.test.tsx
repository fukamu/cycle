import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { SessionProvider } from "./SessionProvider";

const requestID = "00000000-0000-7000-8000-000000000001";
const session = {
  user: {
    id: "00000000-0000-7000-8000-000000000002",
    googleConnected: false,
    googleEmail: null,
  },
  csrfToken: "csrf-token",
};

describe("SessionProvider Closed Beta admission", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows the invite gate before Turnstile and continues after redeem", async () => {
    const requests: string[] = [];
    let admitted = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = typeof input === "string" ? input : input.toString();
        requests.push(path);
        if (path === "/api/__beta/admission/redeem") {
          admitted = true;
          return new Response(null, { status: 204 });
        }
        if (path === "/api/v1/session" && !admitted) {
          return errorResponse(403, "BETA_ADMISSION_REQUIRED");
        }
        if (path === "/api/v1/session") {
          return Response.json(session);
        }
        throw new Error(`unexpected request: ${path}`);
      }),
    );

    renderProvider();

    expect(
      await screen.findByRole("heading", {
        name: "招待された方のみご利用いただけます",
      }),
    ).toBeInTheDocument();
    expect(requests).toEqual(["/api/v1/session"]);

    const user = userEvent.setup();
    await user.type(
      screen.getByLabelText("招待Token"),
      `fukamu_cycle_beta_${"a".repeat(43)}`,
    );
    await user.click(screen.getByRole("button", { name: "利用を開始する" }));

    expect(await screen.findByText("application ready")).toBeInTheDocument();
    expect(requests).toEqual([
      "/api/v1/session",
      "/api/__beta/admission/redeem",
      "/api/v1/session",
    ]);
  });

  it("keeps the gate open when the invite token is invalid", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = typeof input === "string" ? input : input.toString();
        if (path === "/api/v1/session") {
          return errorResponse(403, "BETA_ADMISSION_REQUIRED");
        }
        return errorResponse(403, "BETA_INVITE_INVALID");
      }),
    );

    renderProvider();
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("招待Token"), "invalid");
    await user.click(screen.getByRole("button", { name: "利用を開始する" }));

    expect(
      await screen.findByRole("alert", {
        name: "",
      }),
    ).toHaveTextContent("招待Tokenを確認できませんでした");
    expect(screen.queryByText("application ready")).not.toBeInTheDocument();
  });
});

function renderProvider() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <SessionProvider>
        <p>application ready</p>
      </SessionProvider>
    </QueryClientProvider>,
  );
}

function errorResponse(status: number, code: string): Response {
  return Response.json(
    { error: { code, message: "error", requestId: requestID } },
    { status },
  );
}
