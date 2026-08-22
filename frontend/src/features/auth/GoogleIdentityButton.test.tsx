import { render, screen, waitFor } from "@testing-library/react";

import "../../styles.css";
import { GoogleIdentityButton } from "./GoogleIdentityButton";

describe("GoogleIdentityButton", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    delete window.google;
  });

  it("renders Google Identity inside a size-constrained host", async () => {
    vi.stubEnv("VITE_GOOGLE_WEB_CLIENT_ID", "client-id");
    const renderButton = vi.fn((parent: HTMLElement) => {
      const wrapper = document.createElement("div");
      const logo = document.createElement("img");
      logo.alt = "Google";
      wrapper.append(logo, document.createElement("iframe"));
      parent.append(wrapper);
    });
    window.google = {
      accounts: {
        id: {
          initialize: vi.fn(),
          renderButton,
        },
      },
    };

    render(<GoogleIdentityButton onCredential={vi.fn()} />);

    const host = screen.getByLabelText("Google Account 連携");
    expect(host).toHaveClass("google-identity__button");
    expect(host.parentElement).toHaveClass("google-identity");
    await waitFor(() => expect(renderButton).toHaveBeenCalledOnce());
    expect(renderButton).toHaveBeenCalledWith(
      host,
      expect.objectContaining({ size: "large", width: 320 }),
    );
    expect(getComputedStyle(screen.getByAltText("Google"))).toMatchObject({
      width: "18px",
      height: "18px",
    });
    expect(
      screen.queryByText("Google認証を読み込み中…"),
    ).not.toBeInTheDocument();
  });
});
