export function appReferralUrl(): string | null {
  const configured = import.meta.env.VITE_APP_REFERRAL_URL?.trim();
  if (!configured) return null;

  try {
    const url = new URL(configured);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}
