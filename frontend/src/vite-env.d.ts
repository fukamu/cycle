/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_APP_REFERRAL_URL?: string;
  readonly VITE_GOOGLE_WEB_CLIENT_ID?: string;
  readonly VITE_TURNSTILE_SITE_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
