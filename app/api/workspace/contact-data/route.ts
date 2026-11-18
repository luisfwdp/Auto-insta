import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { canManageWorkspace, getCurrentWorkspaceContext } from "@/lib/workspace-access";
import { eraseContactData, exportContactData, resolveContactIds } from "@/lib/privacy/contact-data";

// LGPD art. 18 requests about one contact. The workspace always comes from the
// session; the client only names the contact inside that workspace.
const contactSchema = z
  .object({
    commenterId: z.string().trim().min(1).max(64).regex(/^[0-9]+$/).optional(),
    username: z.string().trim().min(1).max(64).regex(/^@?[A-Za-z0-9._]+$/).optional(),
  })
  .refine((value) => Boolean(value.commenterId) !== Boolean(value.username), {
    message: "Provide exactly one of commenterId or username",
  });
const eraseSchema = z.intersection(contactSchema, z.object({ confirm: z.literal("ERASE") }));

async function authorize() {
  const context = await getCurrentWorkspaceContext();
  if (!context) {
    return { error: NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 }) };
  }
  if (!canManageWorkspace(context.role)) {
    return { error: NextResponse.json({ success: false, error: "Only owners and admins can handle contact data requests" }, { status: 403 }) };
  }
  return { context };
}

/** Access and portability: everything stored about one contact, as JSON. */
export async function GET(request: NextRequest) {
  const { context, error } = await authorize();
  if (!context) return error;
  const params = request.nextUrl.searchParams;
  const parsed = contactSchema.safeParse({
    commenterId: params.get("commenterId") ?? undefined,
    username: params.get("username") ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: "Invalid contact" }, { status: 400 });
  }
  const contactIds = await resolveContactIds(context.workspaceId, parsed.data);
  const data = await exportContactData(context.workspaceId, contactIds);
  return NextResponse.json({ success: true, data }, { headers: { "Cache-Control": "no-store" } });
}

/** Deletion/anonymization of one contact's data in this workspace. */
export async function DELETE(request: NextRequest) {
  const { context, error } = await authorize();
  if (!context) return error;
  const body = await request.json().catch(() => null);
  const parsed = eraseSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: "Invalid erasure request" }, { status: 400 });
  }
  const contactIds = await resolveContactIds(context.workspaceId, parsed.data);
  if (!contactIds.length) {
    return NextResponse.json({ success: true, data: { interactions: 0, linkClicks: 0, webhookEvents: 0 } });
  }
  const data = await eraseContactData(context.workspaceId, contactIds, context.userId);
  return NextResponse.json({ success: true, data });
}
