import { NextResponse } from "next/server";
import { getCurrentWorkspaceContext } from "@/lib/workspace-access";
import { getWorkspaceBillingStatus, isBillingEnabled } from "@/lib/billing/trial";
import { BillingError, hasBillingProviderScope } from "@/lib/billing/config";
import { readBillingOverview } from "@/lib/billing/overview";
import { assertBillingWorkspaceContext, billingFailure } from "@/lib/billing/http";

export async function GET(request?: Request) {
  const current = await getCurrentWorkspaceContext();
  const headers = { "Cache-Control": "no-store" };
  if (!current) return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401, headers });
  const context = Object.freeze({ ...current });
  try {
    assertBillingWorkspaceContext(request, context.workspaceId);
    const enabled = isBillingEnabled(), configured = hasBillingProviderScope();
    if (!enabled && !configured) return NextResponse.json({ success: true, data: { enabled: false } }, { headers });
    const data = configured ? await readBillingOverview(context.workspaceId) : await getWorkspaceBillingStatus(context.workspaceId);
    const invalidPaidScope = !configured && data.hasAccess && data.status !== "TRIALING";
    return NextResponse.json({ success: true, data: { enabled, ...data, ...(invalidPaidScope ? { hasAccess: false, status: "REVIEW_REQUIRED" } : {}) } }, { headers });
  } catch (error) {
    if (error instanceof BillingError) return billingFailure(error);
    return NextResponse.json({ success: false, error: "BILLING_UNAVAILABLE" }, { status: 503, headers });
  }
}
