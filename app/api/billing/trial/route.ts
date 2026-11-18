import { NextRequest, NextResponse } from "next/server";
import { isTrustedBrowserOrigin } from "@/lib/api/origin";
import { getCurrentWorkspaceContext, canManageBilling } from "@/lib/workspace-access";
import { isBillingEnabled, startCardFreeTrial } from "@/lib/billing/trial";

export async function POST(request: NextRequest) {
  if (!request.headers.get("origin") || !isTrustedBrowserOrigin(request)) return NextResponse.json({ success: false, error: "Forbidden" }, { status: 403 });
  const context = await getCurrentWorkspaceContext();
  if (!context) return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  if (!canManageBilling(context.role)) return NextResponse.json({ success: false, error: "Only the workspace owner can start a trial" }, { status: 403 });
  if (!isBillingEnabled()) return NextResponse.json({ success: false, error: "Billing is not enabled" }, { status: 404 });
  const data = await startCardFreeTrial(context.workspaceId);
  return NextResponse.json({ success: true, data }, { headers: { "Cache-Control": "no-store" } });
}
