// TEMPORARY CLOSED BETA: delete this feature when admission is retired.
import { z } from "zod";

import { requestJSON } from "../../shared/api/client";

export async function redeemBetaInvite(token: string): Promise<void> {
  await requestJSON("/api/__beta/admission/redeem", z.undefined(), {
    method: "POST",
    body: { token },
  });
}
