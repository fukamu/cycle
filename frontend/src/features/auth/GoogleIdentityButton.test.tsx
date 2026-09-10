import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import "../../styles.css";

const googleIdentityScriptSelector =
  'script[data-fukamu-cycle-google-identity="true"]';

describe("GoogleIdentityButton", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    delete window.google;
    document
      .querySelectorAll(googleIdentityScriptSelector)
      .forEach((script) => script.remove());
  });

  it("renders Google Identity inside a size-constrained host", async () => {
    vi.stubEnv("VITE_GOOGLE_WEB_CLIENT_ID", "client-id");
    const renderButton = vi.fn((parent: HTMLElement) => {
      const iframe = document.createElement("iframe");
      iframe.title = "Google Identity";
      iframe.style.width = "320px";
      iframe.style.height = "44px";
      parent.append(iframe);
    });
    window.google = {
      accounts: {
        id: {
          initialize: vi.fn(),
          renderButton,
        },
      },
    };
    const { GoogleIdentityButton } = await import("./GoogleIdentityButton");

    render(<GoogleIdentityButton onCredential={vi.fn()} />);

    const host = screen.getByLabelText("Google Account 連携");
    expect(host).toHaveClass("google-identity__button");
    expect(host.parentElement).toHaveClass("google-identity");
    await waitFor(() => expect(renderButton).toHaveBeenCalledOnce());
    expect(renderButton).toHaveBeenCalledWith(
      host,
      expect.objectContaining({ size: "large", width: "320" }),
    );
    expect(
      getComputedStyle(screen.getByTitle("Google Identity")),
    ).toMatchObject({
      width: "320px",
      height: "44px",
    });
    await waitFor(() =>
      expect(
        screen.queryByText("Google認証を読み込み中…"),
      ).not.toBeInTheDocument(),
    );
  });

  it("keeps the configuration-unavailable presentation without loading a script", async () => {
    vi.stubEnv("VITE_GOOGLE_WEB_CLIENT_ID", "");
    const { GoogleIdentityButton } = await import("./GoogleIdentityButton");

    render(<GoogleIdentityButton onCredential={vi.fn()} />);

    expect(
      screen.getByText("Google連携は運用設定後に利用できます。"),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Google認証を再読み込み" }),
    ).not.toBeInTheDocument();
    expect(document.querySelector(googleIdentityScriptSelector)).toBeNull();
  });

  it("removes its failed script and loads one new script after explicit retry", async () => {
    vi.stubEnv("VITE_GOOGLE_WEB_CLIENT_ID", "client-id");
    const renderButton = vi.fn();
    const { GoogleIdentityButton } = await import("./GoogleIdentityButton");
    const view = render(<GoogleIdentityButton onCredential={vi.fn()} />);

    const failedScript = document.querySelector<HTMLScriptElement>(
      googleIdentityScriptSelector,
    );
    expect(failedScript?.src).toBe("https://accounts.google.com/gsi/client");
    expect(
      document.querySelectorAll(googleIdentityScriptSelector),
    ).toHaveLength(1);

    failedScript?.dispatchEvent(new Event("error"));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Google認証を読み込めませんでした。通信状態を確認して、もう一度読み込んでください。",
    );
    expect(failedScript?.isConnected).toBe(false);
    expect(
      document.querySelectorAll(googleIdentityScriptSelector),
    ).toHaveLength(0);

    view.rerender(<GoogleIdentityButton onCredential={vi.fn()} />);
    expect(
      document.querySelectorAll(googleIdentityScriptSelector),
    ).toHaveLength(0);

    await userEvent.click(
      screen.getByRole("button", { name: "Google認証を再読み込み" }),
    );

    const retryScript = document.querySelector<HTMLScriptElement>(
      googleIdentityScriptSelector,
    );
    expect(retryScript).not.toBe(failedScript);
    expect(
      document.querySelectorAll(googleIdentityScriptSelector),
    ).toHaveLength(1);
    window.google = {
      accounts: {
        id: {
          initialize: vi.fn(),
          renderButton,
        },
      },
    };
    retryScript?.dispatchEvent(new Event("load"));

    await waitFor(() => expect(renderButton).toHaveBeenCalledOnce());
    expect(
      screen.queryByRole("button", { name: "Google認証を再読み込み" }),
    ).not.toBeInTheDocument();
  });

  it("keeps retry single-flight across concurrent consumers", async () => {
    vi.stubEnv("VITE_GOOGLE_WEB_CLIENT_ID", "client-id");
    const renderButton = vi.fn();
    const { GoogleIdentityButton } = await import("./GoogleIdentityButton");
    render(
      <>
        <GoogleIdentityButton onCredential={vi.fn()} />
        <GoogleIdentityButton onCredential={vi.fn()} />
      </>,
    );

    expect(
      document.querySelectorAll(googleIdentityScriptSelector),
    ).toHaveLength(1);
    document
      .querySelector<HTMLScriptElement>(googleIdentityScriptSelector)
      ?.dispatchEvent(new Event("error"));
    const retries = await screen.findAllByRole("button", {
      name: "Google認証を再読み込み",
    });
    expect(retries).toHaveLength(2);

    fireEvent.click(retries[0]!);
    fireEvent.click(retries[1]!);

    expect(
      document.querySelectorAll(googleIdentityScriptSelector),
    ).toHaveLength(1);
    window.google = {
      accounts: {
        id: {
          initialize: vi.fn(),
          renderButton,
        },
      },
    };
    document
      .querySelector<HTMLScriptElement>(googleIdentityScriptSelector)
      ?.dispatchEvent(new Event("load"));

    await waitFor(() => expect(renderButton).toHaveBeenCalledTimes(2));
  });

  it("does not remove a script owned outside the failed attempt", async () => {
    vi.stubEnv("VITE_GOOGLE_WEB_CLIENT_ID", "client-id");
    const externalScript = document.createElement("script");
    externalScript.src = "https://accounts.google.com/gsi/client";
    document.head.append(externalScript);
    const { GoogleIdentityButton } = await import("./GoogleIdentityButton");
    render(<GoogleIdentityButton onCredential={vi.fn()} />);

    document
      .querySelector<HTMLScriptElement>(googleIdentityScriptSelector)
      ?.dispatchEvent(new Event("error"));

    await screen.findByRole("alert");
    expect(externalScript.isConnected).toBe(true);
    externalScript.remove();
  });
});
