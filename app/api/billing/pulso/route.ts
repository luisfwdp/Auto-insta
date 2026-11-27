import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { BillingError, getBillingProviderScope } from "@/lib/billing/config";
import { ingestBillingEvent } from "@/lib/billing/inbox";
import { createPulsoClient } from "@/lib/billing/pulso-checkout";
import { parsePulsoNotification } from "@/lib/billing/pulso-webhook";
import { readWebhookBody } from "@/lib/billing/webhook-body";

const headers = { "Cache-Control": "no-store" };

export async function POST(request: Request) {
  try {
    const secret = process.env.PULSO_WEBHOOK_SECRET;
    if (process.env.PULSO_CHECKOUT_ENABLED !== "true" || !secret || secret.length < 32 || secret === process.env.PULSO_APP_TOKEN) {
      throw new BillingError("BILLING_CONFIGURATION", 503);
    }
    const event = parsePulsoNotification(request.headers, await readWebhookBody(request, 16 * 1024), secret);
    const scope = getBillingProviderScope();
    const checkout = await prisma.billingCheckout.findFirst({ where: { id: event.orderId, ...scope }, select: {
      id: true, status: true, providerCheckoutId: true, amountCents: true, firstChargeDate: true,
    } });
    if (!checkout) throw new BillingError("NOT_FOUND", 404);

    let checkoutId = checkout.providerCheckoutId;
    if (!checkoutId) {
      const client = createPulsoClient(scope.environment);
      const recovered = await client?.findCheckout({ reference: checkout.id, amountCents: checkout.amountCents, firstChargeDate: checkout.firstChargeDate });
      if (!recovered) throw new BillingError("BILLING_CONFIGURATION", 503);
      const bound = await prisma.billingCheckout.updateMany({ where: {
        id: checkout.id, ...scope, status: { in: ["CREATING", "UNKNOWN"] },
        OR: [{ providerCheckoutId: null }, { providerCheckoutId: recovered.id }],
      }, data: { providerCheckoutId: recovered.id } });
      if (bound.count !== 1) throw new BillingError("CHECKOUT_CONFLICT");
      checkoutId = recovered.id;
    }

    await ingestBillingEvent({ id: event.id, event: event.event, payment: { id: event.paymentId, checkoutSession: checkoutId } });
    return NextResponse.json({ received: true }, { headers });
  } catch (error) {
    const known = error instanceof BillingError;
    return NextResponse.json({ error: known ? error.code : "BILLING_INBOX_UNAVAILABLE" },
      { status: known ? error.httpStatus : 503, headers });
  }
}
