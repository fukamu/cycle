export type AppReferralShareResult = "shared" | "copied" | "canceled";

const referralMessage =
  "目標ごとに小さなPDCAサイクルを回し、学びながら前へ進めるアプリ「FUKAMU Cycle」を紹介します。";

function canceled(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

export async function shareAppReferral(
  url: string,
): Promise<AppReferralShareResult> {
  if (navigator.share) {
    try {
      await navigator.share({
        title: "FUKAMU Cycle",
        text: referralMessage,
        url,
      });
      return "shared";
    } catch (error) {
      if (canceled(error)) return "canceled";
    }
  }

  if (!navigator.clipboard?.writeText) {
    throw new Error("sharing is unavailable");
  }
  await navigator.clipboard.writeText(`${referralMessage}\n${url}`);
  return "copied";
}
