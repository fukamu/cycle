/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_ACCOUNT_DELETION_BACKUP_MAX_DAYS?: string;
  readonly VITE_APP_REFERRAL_URL?: string;
  readonly VITE_GOOGLE_WEB_CLIENT_ID?: string;
  readonly VITE_PRIVACY_CONTACT_URL?: string;
  readonly VITE_PRIVACY_OPERATOR_NAME?: string;
  readonly VITE_TURNSTILE_SITE_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
