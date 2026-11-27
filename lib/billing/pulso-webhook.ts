import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { BillingError } from "./config";
import { PULSO_APP } from "./pulso-checkout";

const events = { "payment.confirmed": "PAYMENT_CONFIRMED", "payment.received": "PAYMENT_RECEIVED", "payment.refunded": "PAYMENT_REFUNDED" } as const;
const eventSchema = z.object({
  id: z.uuid(), app: z.literal(PULSO_APP), orderId: z.uuid(), event: z.enum(Object.keys(events) as [keyof typeof events, ...Array<keyof typeof events>]),
  paymentId: z.string().max(128).regex(/^pay_[A-Za-z0-9_]+$/),
});

export function parsePulsoNotification(headers: Headers, body: string, secret: string, now = Date.now()) {
  const timestamp = headers.get("x-pulso-timestamp");
  const signature = headers.get("x-pulso-signature");
  if (!timestamp || !/^\d{10}$/.test(timestamp) || Math.abs(Math.floor(now / 1000) - Number(timestamp)) > 300
    || !signature || !/^sha256=[a-f0-9]{64}$/.test(signature)) throw new BillingError("INVALID_PULSO_SIGNATURE", 401);
  const expected = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest();
  if (!timingSafeEqual(expected, Buffer.from(signature.slice(7), "hex"))) throw new BillingError("INVALID_PULSO_SIGNATURE", 401);

  try {
    const value = eventSchema.parse(JSON.parse(body));
    if (value.id !== headers.get("idempotency-key")) throw new Error();
    return { id: `pulso:${value.id}`, orderId: value.orderId, event: events[value.event], paymentId: value.paymentId };
  } catch { throw new BillingError("INVALID_BILLING_EVENT", 400); }
}
