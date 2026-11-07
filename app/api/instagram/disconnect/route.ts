import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import {
  canManageWorkspace,
  getCurrentWorkspaceContext,
} from "@/lib/workspace-access";

export async function POST(request: NextRequest) {
  const context = await getCurrentWorkspaceContext();
  if (!context) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  if (!canManageWorkspace(context.role)) {
    return NextResponse.json(
      { success: false, error: "Only owners and admins can disconnect accounts" },
      { status: 403 }
    );
  }

  const body = await request.json().catch(() => ({}));
  const instagramAccountId =
    typeof body.instagramAccountId === "string" ? body.instagramAccountId : null;

  // Disconnecting cascades to the account's campaigns, logs and links. An
  // empty body used to disconnect every account in the workspace; require
  // the one account the user chose.
  if (!instagramAccountId) {
    return NextResponse.json(
      { success: false, error: "instagramAccountId is required" },
      { status: 400 }
    );
  }

  await prisma.instagramAccount.deleteMany({
    where: { workspaceId: context.workspaceId, id: instagramAccountId },
  });

  return NextResponse.json({ success: true });
}
