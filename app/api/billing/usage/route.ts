import { getCurrentWorkspaceContext } from "@/lib/workspace-access";
import { readCommercialUsageOverview } from "@/lib/billing/commercial-overview";
import { BillingError } from "@/lib/billing/config";
import { assertBillingWorkspaceContext, billingFailure, billingJson } from "@/lib/billing/http";
import { isBillingEnabled } from "@/lib/billing/trial";

export async function GET(request?: Request) {
  let response: Response;
  try {
    if (!isBillingEnabled()) throw new BillingError("BILLING_DISABLED", 404);
    const current = await getCurrentWorkspaceContext();
    if (!current) throw new BillingError("UNAUTHORIZED", 401);
    const context = Object.freeze({ ...current });
    assertBillingWorkspaceContext(request, context.workspaceId);
    response = billingJson(await readCommercialUsageOverview(context.workspaceId, context.userId));
  } catch (error) { response = billingFailure(error); }
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
