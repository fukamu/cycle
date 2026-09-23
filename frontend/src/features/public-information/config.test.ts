import { readPublicInformationConfiguration } from "./config";

describe("public information configuration", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns only a complete, public-safe disclosure configuration", () => {
    vi.stubEnv("VITE_PRIVACY_OPERATOR_NAME", "Example Cycle Operator");
    vi.stubEnv(
      "VITE_PRIVACY_CONTACT_URL",
      "https://support.example.test/cycle/contact?from=privacy",
    );
    vi.stubEnv("VITE_ACCOUNT_DELETION_BACKUP_MAX_DAYS", " 30 ");

    expect(readPublicInformationConfiguration()).toEqual({
      operatorName: "Example Cycle Operator",
      contactUrl: "https://support.example.test/cycle/contact?from=privacy",
      accountDeletionBackupMaxDays: 30,
    });
  });

  it.each([
    ["missing operator", "", "https://support.example.test/", "30"],
    ["non-HTTPS contact", "Operator", "http://support.example.test/", "30"],
    [
      "credential-bearing contact",
      "Operator",
      "https://user:password@support.example.test/",
      "30",
    ],
    [
      "fragment-bearing contact",
      "Operator",
      "https://support.example.test/#private",
      "30",
    ],
    ["zero retention", "Operator", "https://support.example.test/", "0"],
    [
      "fractional retention",
      "Operator",
      "https://support.example.test/",
      "1.5",
    ],
  ])(
    "fails closed for %s",
    (_label, operatorName, contactUrl, backupMaxDays) => {
      vi.stubEnv("VITE_PRIVACY_OPERATOR_NAME", operatorName);
      vi.stubEnv("VITE_PRIVACY_CONTACT_URL", contactUrl);
      vi.stubEnv("VITE_ACCOUNT_DELETION_BACKUP_MAX_DAYS", backupMaxDays);

      expect(readPublicInformationConfiguration()).toBeUndefined();
    },
  );
});
