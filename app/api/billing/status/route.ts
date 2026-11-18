import { NextResponse } from "next/server";
import { getCurrentWorkspaceContext } from "@/lib/workspace-access";
import { getWorkspaceBillingStatus, isBillingEnabled } from "@/lib/billing/trial";
import { hasBillingProviderScope } from "@/lib/billing/config";
import { readBillingOverview } from "@/lib/billing/overview";

export async function GET() {
  const context = await getCurrentWorkspaceContext();
  const headers = { "Cache-Control": "no-store" };
  if (!context) return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401, headers });
  const enabled = isBillingEnabled(), configured = hasBillingProviderScope();
  if (!enabled && !configured) return NextResponse.json({ success: true, data: { enabled: false } }, { headers });
  try {
    const data = configured ? await readBillingOverview(context.workspaceId) : await getWorkspaceBillingStatus(context.workspaceId);
    const invalidPaidScope = !configured && data.hasAccess && data.status !== "TRIALING";
    return NextResponse.json({ success: true, data: { enabled, ...data, ...(invalidPaidScope ? { hasAccess: false, status: "REVIEW_REQUIRED" } : {}) } }, { headers });
  } catch {
    return NextResponse.json({ success: false, error: "BILLING_UNAVAILABLE" }, { status: 503, headers });
  }
}
