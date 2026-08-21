// The fragment is removed before React mounts so invite tokens do not remain in
// browser history or reach third-party requests. It is retained only in memory.
let initialInviteToken = consumeInviteTokenFragment();

export function getInitialBetaInviteToken(): string {
  return initialInviteToken;
}

export function clearInitialBetaInviteToken(): void {
  initialInviteToken = "";
}

function consumeInviteTokenFragment(): string {
  if (typeof window === "undefined" || !window.location.hash.startsWith("#")) {
    return "";
  }
  const parameters = new URLSearchParams(window.location.hash.slice(1));
  const token = parameters.get("beta-invite");
  if (token === null) return "";

  parameters.delete("beta-invite");
  const remaining = parameters.toString();
  window.history.replaceState(
    window.history.state,
    "",
    `${window.location.pathname}${window.location.search}${remaining === "" ? "" : `#${remaining}`}`,
  );
  return token;
}
