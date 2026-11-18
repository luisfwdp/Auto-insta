import { getCurrentWorkspaceContext } from "@/lib/workspace-access";
import { readCommercialUsageOverview } from "@/lib/billing/commercial-overview";
import { BillingError } from "@/lib/billing/config";
import { billingFailure, billingJson } from "@/lib/billing/http";
import { isBillingEnabled } from "@/lib/billing/trial";

export async function GET() {
  let response: Response;
  try {
    if (!isBillingEnabled()) throw new BillingError("BILLING_DISABLED", 404);
    const context = await getCurrentWorkspaceContext();
    if (!context) throw new BillingError("UNAUTHORIZED", 401);
    response = billingJson(await readCommercialUsageOverview(context.workspaceId, context.userId));
  } catch (error) { response = billingFailure(error); }
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
