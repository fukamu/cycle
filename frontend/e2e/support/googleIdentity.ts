import type { Page } from "@playwright/test";

export const googleIdentityFakeButtonName = "テスト用Google Accountで続行";

export async function installGoogleIdentityFake(
  page: Page,
  credential: string,
): Promise<void> {
  await page.addInitScript(
    ({ buttonName, fakeCredential }) => {
      let callback:
        | ((response: { readonly credential?: string }) => void)
        | undefined;

      Object.defineProperty(window, "google", {
        configurable: true,
        value: {
          accounts: {
            id: {
              initialize(options: {
                readonly callback: (response: {
                  readonly credential?: string;
                }) => void;
              }) {
                callback = options.callback;
              },
              renderButton(parent: HTMLElement) {
                const button = document.createElement("button");
                button.type = "button";
                button.textContent = buttonName;
                button.setAttribute("aria-label", buttonName);
                button.addEventListener("click", () => {
                  callback?.({ credential: fakeCredential });
                });
                parent.replaceChildren(button);
              },
            },
          },
        },
      });
    },
    { buttonName: googleIdentityFakeButtonName, fakeCredential: credential },
  );
}
