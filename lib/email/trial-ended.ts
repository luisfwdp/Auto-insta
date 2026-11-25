import { prisma } from "@/lib/db/client";
import { isBillingEnabled } from "@/lib/billing/trial";
import { evaluateLifetimeAccess } from "@/lib/billing/lifetime";
import { emailSettings, sendEmail, textToHtml } from "./send";

/**
 * When a card-free trial ends without a paid plan, sends stop being admitted
 * (COMMERCIAL_ACCESS_DENIED). This tells the workspace owner once, so campaigns
 * do not go quiet without the owner knowing why.
 *
 * The marker is an OperationalEvent. The lookback is shorter than the minimum
 * operational-event retention (7 days), so retention can never delete a marker
 * while its trial is still inside the window and cause a second email.
 */
export const TRIAL_ENDED_NOTICE_MESSAGE = "Trial ended notice sent";
export const TRIAL_ENDED_LOOKBACK_MS = 3 * 24 * 60 * 60 * 1000;
const MAX_NOTICES_PER_RUN = 50;

export function trialEndedMessage(to: string, appUrl: string, contact: string | null) {
  const lines = [
    "Olá!",
    "O seu teste grátis do PING CHAT terminou.",
    "Sem um plano ativo, as suas campanhas param de enviar respostas e mensagens. As campanhas e as configurações continuam salvas.",
    `Para voltar a enviar, escolha um plano em ${appUrl}/billing.`,
    contact
      ? `Se precisar de ajuda, responda a este e-mail ou escreva para ${contact}.`
      : "Se precisar de ajuda, responda a este e-mail.",
    "Equipe PING CHAT",
  ];
  const text = lines.join("\n\n");
  return { to, subject: "Seu teste grátis do PING CHAT terminou", text, html: textToHtml(text) };
}

export type TrialNoticeResult = { candidates: number; sent: number; failed: number };

export async function sendTrialEndedNotices(now = new Date()): Promise<TrialNoticeResult | null> {
  if (!isBillingEnabled()) return null;
  const settings = emailSettings();
  const appUrl = (process.env.NEXTAUTH_URL ?? process.env.AUTH_URL ?? "").replace(/\/$/, "");
  if (!settings.apiKey || !settings.from || !appUrl) return null;

  const ended = await prisma.workspaceBilling.findMany({
    where: {
      status: "TRIALING",
      trialEndsAt: { lte: now, gt: new Date(now.getTime() - TRIAL_ENDED_LOOKBACK_MS) },
      paidThrough: null,
    },
    select: { workspaceId: true, status: true, lifetimeAccess: true,
      workspace: { select: { id: true, ownerId: true, owner: { select: { email: true } } } } },
    orderBy: { trialEndsAt: "asc" },
    take: MAX_NOTICES_PER_RUN,
  });

  const result: TrialNoticeResult = { candidates: ended.length, sent: 0, failed: 0 };
  for (const billing of ended) {
    // A licensed workspace keeps an expired TRIALING record but still has
    // access, so telling its owner that campaigns stopped would be false.
    if (evaluateLifetimeAccess(billing.workspace, billing, now)) continue;
    const email = billing.workspace.owner.email;
    if (!email) continue;
    const already = await prisma.operationalEvent.findFirst({
      where: { workspaceId: billing.workspaceId, message: TRIAL_ENDED_NOTICE_MESSAGE },
      select: { id: true },
    });
    if (already) continue;
    const delivery = await sendEmail(trialEndedMessage(email, appUrl, settings.replyTo));
    if (!delivery.ok) {
      // No marker, so the next run tries again. The address is never logged.
      result.failed += 1;
      continue;
    }
    await prisma.operationalEvent.create({
      data: { workspaceId: billing.workspaceId, source: "SYSTEM", level: "INFO", message: TRIAL_ENDED_NOTICE_MESSAGE },
    });
    result.sent += 1;
  }
  return result;
}
