import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { TRACKED_LINK_ORDER } from "@/lib/tracking/link-order";
import { decryptLeadContact } from "@/lib/tracking/lead-capture";
import { canManageWorkspace, getCurrentWorkspaceContext } from "@/lib/workspace-access";

type RouteContext = { params: Promise<{ id: string }> };
const linkUpdate = z.object({ linkId: z.string().cuid(), requireLead: z.boolean() }).strict();
const leadId = z.string().uuid();
const PAGE_SIZE = 50;

function json(data: unknown, status = 200) {
  return NextResponse.json(data, { status, headers: { "Cache-Control": "private, no-store" } });
}

async function getScope({ params }: RouteContext) {
  const workspace = await getCurrentWorkspaceContext();
  if (!workspace) return { error: json({ error: "UNAUTHENTICATED" }, 401) };
  if (!canManageWorkspace(workspace.role)) return { error: json({ error: "FORBIDDEN" }, 403) };
  const { id } = await params;
  const automation = await prisma.automation.findFirst({
    where: { id, workspaceId: workspace.workspaceId },
    select: { id: true },
  });
  if (!automation) return { error: json({ error: "CAMPAIGN_NOT_FOUND" }, 404) };
  return { scope: { automationId: automation.id, workspaceId: workspace.workspaceId } };
}

export async function GET(request: NextRequest, route: RouteContext) {
  try {
    const { scope, error } = await getScope(route);
    if (error) return error;
    const cursor = request.nextUrl.searchParams.get("cursor");
    if (cursor && !leadId.safeParse(cursor).success) return json({ error: "INVALID_CURSOR" }, 400);
    const after = cursor ? await prisma.campaignLead.findFirst({
      where: { ...scope, id: cursor },
      select: { id: true, createdAt: true },
    }) : null;
    if (cursor && !after) return json({ error: "INVALID_CURSOR" }, 400);

    const [links, rows] = await Promise.all([
      prisma.trackedLink.findMany({
        where: scope,
        select: { id: true, label: true, requireLead: true, position: true },
        orderBy: TRACKED_LINK_ORDER,
      }),
      prisma.campaignLead.findMany({
        where: {
          ...scope,
          ...(after && {
            OR: [
              { createdAt: { lt: after.createdAt } },
              { createdAt: after.createdAt, id: { lt: after.id } },
            ],
          }),
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: PAGE_SIZE + 1,
        select: { id: true, sourceLinkId: true, createdAt: true, contactCiphertext: true },
      }),
    ]);
    const leads = rows.slice(0, PAGE_SIZE).map(({ contactCiphertext, ...row }) => ({
      ...row, ...decryptLeadContact(contactCiphertext),
    }));
    return json({ links, leads, nextCursor: rows.length > PAGE_SIZE ? leads.at(-1)?.id : null });
  } catch {
    return json({ error: "LEADS_UNAVAILABLE" }, 503);
  }
}

export async function PATCH(request: NextRequest, route: RouteContext) {
  try {
    const { scope, error } = await getScope(route);
    if (error) return error;
    const change = linkUpdate.safeParse(await request.json().catch(() => null));
    if (!change.success) return json({ error: "INVALID_LEAD_SETTINGS" }, 400);
    const { count } = await prisma.trackedLink.updateMany({
      where: { ...scope, id: change.data.linkId },
      data: { requireLead: change.data.requireLead },
    });
    return count ? json({ requireLead: change.data.requireLead }) : json({ error: "LINK_NOT_FOUND" }, 404);
  } catch {
    return json({ error: "LEADS_UNAVAILABLE" }, 503);
  }
}

export async function DELETE(request: NextRequest, route: RouteContext) {
  try {
    const { scope, error } = await getScope(route);
    if (error) return error;
    const id = leadId.safeParse(request.nextUrl.searchParams.get("id"));
    if (!id.success) return json({ error: "INVALID_LEAD_ID" }, 400);
    const { count } = await prisma.campaignLead.deleteMany({ where: { ...scope, id: id.data } });
    return count ? json({ deleted: true }) : json({ error: "LEAD_NOT_FOUND" }, 404);
  } catch {
    return json({ error: "LEADS_UNAVAILABLE" }, 503);
  }
}
