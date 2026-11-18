import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { isInstanceOperator } from "@/lib/env";
import { getCurrentWorkspaceContext } from "@/lib/workspace-access";
import { emailSettings, sendEmailBatch, textToHtml } from "@/lib/email/send";

// Instance-wide announcement to every account holder. Only instance operators
// (OPERATOR_EMAILS) may use it; workspace owners and admins may not.
const broadcastSchema = z.object({
  subject: z.string().trim().min(3).max(150),
  message: z.string().trim().min(10).max(5000),
  confirm: z.literal("SEND"),
});
const MIN_INTERVAL_MS = 10 * 60_000;
const BROADCAST_EVENT = "Operator broadcast email sent";

async function authorizeOperator() {
  const context = await getCurrentWorkspaceContext();
  if (!context) return { error: NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 }) };
  const user = await prisma.user.findUnique({ where: { id: context.userId }, select: { email: true } });
  if (!isInstanceOperator(user?.email)) {
    return { error: NextResponse.json({ success: false, error: "Forbidden" }, { status: 403 }) };
  }
  return { context };
}

const recipientsWhere = { email: { not: null }, emailVerified: { not: null } };

/** Preview: how many people a broadcast would reach and whether email is set up. */
export async function GET() {
  const { context, error } = await authorizeOperator();
  if (!context) return error;
  const [recipients, last] = await Promise.all([
    prisma.user.count({ where: recipientsWhere }),
    prisma.operationalEvent.findFirst({
      where: { message: BROADCAST_EVENT },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    }),
  ]);
  const settings = emailSettings();
  return NextResponse.json({
    success: true,
    data: { recipients, configured: Boolean(settings.apiKey && settings.from), lastSentAt: last?.createdAt ?? null },
  });
}

export async function POST(request: NextRequest) {
  const { context, error } = await authorizeOperator();
  if (!context) return error;
  const parsed = broadcastSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: "Invalid broadcast" }, { status: 400 });
  }
  const last = await prisma.operationalEvent.findFirst({
    where: { message: BROADCAST_EVENT },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  if (last && Date.now() - last.createdAt.getTime() < MIN_INTERVAL_MS) {
    return NextResponse.json({ success: false, error: "A broadcast was sent less than 10 minutes ago" }, { status: 429 });
  }

  const users = await prisma.user.findMany({ where: recipientsWhere, select: { email: true } });
  const html = textToHtml(parsed.data.message);
  const result = await sendEmailBatch(
    users.flatMap((user) => (user.email ? [{ to: user.email, subject: parsed.data.subject, text: parsed.data.message, html }] : []))
  );
  // Audit trail without recipient addresses or the message body.
  await prisma.operationalEvent.create({
    data: {
      source: "SYSTEM",
      level: result.failed > 0 ? "WARNING" : "INFO",
      message: BROADCAST_EVENT,
      payload: { requestedByUserId: context.userId, subjectLength: parsed.data.subject.length, sent: result.sent, failed: result.failed, errors: result.errors },
    },
  });
  return NextResponse.json({ success: result.failed === 0, data: result }, { status: result.sent === 0 && result.failed > 0 ? 502 : 200 });
}
