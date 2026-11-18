import { NextResponse } from "next/server";
import { getCurrentWorkspaceContext } from "@/lib/workspace-access";
import { getWorkspaceBillingStatus, isBillingEnabled } from "@/lib/billing/trial";

export async function GET() {
  const context = await getCurrentWorkspaceContext();
  if (!context) return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  if (!isBillingEnabled()) return NextResponse.json({ success: true, data: { enabled: false } }, { headers: { "Cache-Control": "no-store" } });
  const data = await getWorkspaceBillingStatus(context.workspaceId);
  return NextResponse.json({ success: true, data: { enabled: true, ...data } }, { headers: { "Cache-Control": "no-store" } });
}
