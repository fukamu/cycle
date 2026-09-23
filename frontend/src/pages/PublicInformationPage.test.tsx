import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { PublicInformationPage } from "./PublicInformationPage";

describe("PublicInformationPage", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("shows product-specific processing, deletion limits, and the configured contact", () => {
    vi.stubEnv("VITE_PRIVACY_OPERATOR_NAME", "Example Cycle Operator");
    vi.stubEnv(
      "VITE_PRIVACY_CONTACT_URL",
      "https://support.example.test/cycle",
    );
    vi.stubEnv("VITE_ACCOUNT_DELETION_BACKUP_MAX_DAYS", "45");

    render(
      <MemoryRouter initialEntries={["/legal/privacy"]}>
        <PublicInformationPage />
      </MemoryRouter>,
    );

    expect(
      screen.getByRole("heading", {
        name: "データの取扱いとお問い合わせ",
      }),
    ).toBeInTheDocument();
    expect(screen.getByText("Example Cycle Operator")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "公開問い合わせ窓口" }),
    ).toHaveAttribute("href", "https://support.example.test/cycle");
    expect(screen.getByText(/最長45日残る場合があります/u)).toBeInTheDocument();

    const processingTable = screen.getByRole("table");
    for (const rowName of [
      "匿名利用・セッション",
      "任意のGoogle連携",
      "目標・PDCA",
      "任意のAI機能",
      "ブラウザ内の一時保存",
      "運用・障害調査",
    ]) {
      expect(
        within(processingTable).getByRole("rowheader", { name: rowName }),
      ).toBeInTheDocument();
    }
    const googleRow = within(processingTable)
      .getByRole("rowheader", { name: "任意のGoogle連携" })
      .closest("tr");
    expect(googleRow).toHaveTextContent("メールアドレスとGoogleが返す検証状態");
    expect(googleRow).toHaveTextContent(
      "設定画面では検証済みの場合だけメールアドレスを表示します",
    );
    expect(screen.getByText(/Google Cloud/u)).toHaveTextContent(
      "保存時暗号化を有効にした環境で",
    );
    expect(
      screen.getByText(
        /ブラウザから公開URLへの通信にHTTPS\/TLSを使用する方針/u,
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(/実際の通信経路のTLS設定は/u)).toBeInTheDocument();
    expect(
      screen.getByText(/E2EE（エンドツーエンド暗号化）/u),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/実際の稼働設定と移行結果を外部利用開始前に確認します/u),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /運用・障害調査の観測データはアカウント削除処理の個別削除対象ではありません/u,
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(/有料プラン、決済、課金解約/u)).toBeInTheDocument();
  });

  it("fails closed without inventing operator, contact, or retention values", () => {
    vi.stubEnv("VITE_PRIVACY_OPERATOR_NAME", "");
    vi.stubEnv("VITE_PRIVACY_CONTACT_URL", "");
    vi.stubEnv("VITE_ACCOUNT_DELETION_BACKUP_MAX_DAYS", "");

    render(
      <MemoryRouter initialEntries={["/legal/privacy"]}>
        <PublicInformationPage />
      </MemoryRouter>,
    );

    expect(
      screen.getByRole("heading", { name: "公開情報の設定が完了していません" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/外部利用を開始しないでください/u),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "公開問い合わせ窓口" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(/バックアップの最大保持期間は未設定/u),
    ).toBeInTheDocument();
  });
});
