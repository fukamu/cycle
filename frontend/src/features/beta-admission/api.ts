// TEMPORARY CLOSED BETA: delete this feature when admission is retired.
import { z } from "zod";

import { requestBetaAdmissionJSON } from "../../shared/api/client";

export async function redeemBetaInvite(token: string): Promise<void> {
  await requestBetaAdmissionJSON(z.undefined(), {
    method: "POST",
    body: { token },
  });
}
