import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { AppReferralPromotion } from "./AppReferralPromotion";

const originalShare = Object.getOwnPropertyDescriptor(navigator, "share");
const originalClipboard = Object.getOwnPropertyDescriptor(
  navigator,
  "clipboard",
);

function setNavigatorProperty(name: "share" | "clipboard", value: unknown) {
  Object.defineProperty(navigator, name, { configurable: true, value });
}

afterEach(() => {
  vi.unstubAllEnvs();
  if (originalShare) Object.defineProperty(navigator, "share", originalShare);
  else Reflect.deleteProperty(navigator, "share");
  if (originalClipboard)
    Object.defineProperty(navigator, "clipboard", originalClipboard);
  else Reflect.deleteProperty(navigator, "clipboard");
});

describe("AppReferralPromotion", () => {
  it("is detached when the referral URL is not configured", () => {
    vi.stubEnv("VITE_APP_REFERRAL_URL", "");
    render(<AppReferralPromotion />);
    expect(
      screen.queryByRole("heading", { name: "PDCAIを友人・同僚に紹介" }),
    ).not.toBeInTheDocument();
  });

  it("shares only the configured app introduction", async () => {
    vi.stubEnv("VITE_APP_REFERRAL_URL", "https://pdcai.example/");
    const share = vi.fn().mockResolvedValue(undefined);
    setNavigatorProperty("share", share);
    const user = userEvent.setup();
    render(<AppReferralPromotion />);

    await user.click(
      screen.getByRole("button", { name: "PDCAIの紹介リンクを共有" }),
    );

    await screen.findByRole("status");
    expect(share).toHaveBeenCalledWith({
      title: "PDCAI",
      text: "目標ごとに小さなPDCAサイクルを回し、学びながら前へ進めるアプリ「PDCAI」を紹介します。",
      url: "https://pdcai.example/",
    });
    expect(screen.getByRole("status")).toHaveTextContent(
      "紹介ありがとうございます。",
    );
  });

  it("copies the introduction when native sharing is unavailable", async () => {
    vi.stubEnv("VITE_APP_REFERRAL_URL", "https://pdcai.example/");
    const user = userEvent.setup();
    setNavigatorProperty("share", undefined);
    const writeText = vi.fn().mockResolvedValue(undefined);
    setNavigatorProperty("clipboard", { writeText });
    render(<AppReferralPromotion />);

    await user.click(
      screen.getByRole("button", { name: "PDCAIの紹介リンクを共有" }),
    );

    await screen.findByRole("status");
    expect(writeText).toHaveBeenCalledWith(
      "目標ごとに小さなPDCAサイクルを回し、学びながら前へ進めるアプリ「PDCAI」を紹介します。\nhttps://pdcai.example/",
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "紹介文とリンクをコピーしました。",
    );
  });
});
