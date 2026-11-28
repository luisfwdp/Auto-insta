import { z } from "zod";
import { BILLING_PLAN_IDS } from "./catalog";

const checkoutInput = z.object({
  reference: z.uuid(),
  name: z.string().trim().min(1).max(100),
  amountCents: z.number().int().positive().max(1_000_000_000),
  planId: z.enum(BILLING_PLAN_IDS).optional(),
  firstChargeDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
    const parsed = new Date(`${value}T00:00:00Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }),
}).strict();

export type HostedCheckoutInput = z.infer<typeof checkoutInput>;
// Official OpenAPI: /reference/listar-cobrancas, /recuperar-uma-unica-cobranca,
// /recuperar-uma-unica-assinatura (docs.asaas.com). Unknown fields are stripped.
const resourceId = (prefix: string) => z.string().max(128).regex(new RegExp(`^${prefix}_[A-Za-z0-9_]+$`));
const paymentId = resourceId("pay"), subscriptionId = resourceId("sub"), customerId = resourceId("cus");
const checkoutSession = z.uuid();
const moneyInCents = z.number().finite().nonnegative().refine(value =>
  Number.isSafeInteger(Math.round(value * 100)) && Number(value.toFixed(2)) === value,
).transform(value => Math.round(value * 100));
const paymentResponse = z.object({
  id: paymentId, subscription: subscriptionId.nullish().transform(value => value ?? null),
  checkoutSession: checkoutSession.nullish().transform(value => value ?? null), customer: customerId,
  status: z.enum(["PENDING", "RECEIVED", "CONFIRMED", "OVERDUE", "REFUNDED", "RECEIVED_IN_CASH",
    "REFUND_REQUESTED", "REFUND_IN_PROGRESS", "CHARGEBACK_REQUESTED", "CHARGEBACK_DISPUTE",
    "AWAITING_CHARGEBACK_REVERSAL", "DUNNING_REQUESTED", "DUNNING_RECEIVED", "AWAITING_RISK_ANALYSIS"]),
  value: moneyInCents, dueDate: z.iso.date(), deleted: z.boolean(),
}).transform(({ value, ...rest }) => ({ ...rest, valueCents: value }));
const subscriptionResponse = z.object({
  id: subscriptionId, customer: customerId, status: z.enum(["ACTIVE", "EXPIRED", "INACTIVE"]),
  value: moneyInCents, cycle: z.enum(["WEEKLY", "BIWEEKLY", "MONTHLY", "BIMONTHLY", "QUARTERLY", "SEMIANNUALLY", "YEARLY"]),
  deleted: z.boolean(), checkoutSession: checkoutSession.nullish().transform(value => value ?? null),
}).transform(({ value, ...rest }) => ({ ...rest, valueCents: value }));
const pagination = z.object({ offset: z.number().int().min(0).max(2_147_483_647).default(0), limit: z.number().int().min(1).max(20).default(10) }).strict();
const paymentPageResponse = z.object({
  hasMore: z.boolean(), totalCount: z.number().int().nonnegative().max(2_147_483_647),
  offset: z.number().int().nonnegative().max(2_147_483_647), limit: z.number().int().min(1).max(20),
  data: z.array(paymentResponse).max(20),
});
// Ownership lookup only: the account is shared with other products, whose valid
// resources may carry states/values our financial schema rejects. Only link IDs are
// parsed (still strictly). Our own resources are re-read with the strict schemas
// before any financial decision.
const paymentLinksResponse = z.object({
  id: paymentId, subscription: subscriptionId.nullish().transform(value => value ?? null),
  checkoutSession: checkoutSession.nullish().transform(value => value ?? null),
});
const subscriptionLinksResponse = z.object({ id: subscriptionId, checkoutSession: checkoutSession.nullish().transform(value => value ?? null) });
export type AsaasPaymentLinksDTO = z.infer<typeof paymentLinksResponse>;
export type AsaasSubscriptionLinksDTO = z.infer<typeof subscriptionLinksResponse>;
export type AsaasPaymentDTO = z.infer<typeof paymentResponse>;
export type AsaasSubscriptionDTO = z.infer<typeof subscriptionResponse>;
export type AsaasPaymentPageDTO = z.infer<typeof paymentPageResponse>;
const cancellationResponse = z.object({ id: subscriptionId, deleted: z.literal(true) });
export type AsaasSubscriptionCancellationDTO = z.infer<typeof cancellationResponse>;

export async function readBoundedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error();
  const decoder = new TextDecoder();
  let text = "", bytes = 0;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    bytes += chunk.value.byteLength;
    if (bytes > 64 * 1024) { await reader.cancel(); throw new Error(); }
    text += decoder.decode(chunk.value, { stream: true });
  }
  return JSON.parse(text + decoder.decode());
}

export class AsaasError extends Error {
  constructor(readonly code: "CONFIGURATION" | "INVALID_REQUEST" | "REJECTED" | "UNKNOWN_OUTCOME" | "UNAVAILABLE" | "INVALID_RESPONSE", readonly httpStatus?: number) {
    super(code === "UNKNOWN_OUTCOME" ? "Payment provider outcome needs reconciliation" : "Payment provider request unavailable");
    this.name = "AsaasError";
  }
}

/** Checkout-only configuration; workers doing GET/DELETE need no callback URL.
 * Call this before persisting a new intent so bad configuration is not recorded
 * as an uncertain provider mutation. This helper never needs the API key.
 */
export function getAsaasCheckoutOrigin(env: Readonly<Record<string, string | undefined>> = process.env) {
  const mode = env.ASAAS_ENVIRONMENT;
  if (mode !== "sandbox" && mode !== "production") throw new AsaasError("CONFIGURATION");
  try {
    const configured = new URL(env.NEXTAUTH_URL ?? env.AUTH_URL ?? "");
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(configured.hostname);
    if (configured.username || configured.password || (mode === "production" && local) || (configured.protocol !== "https:" && !(mode === "sandbox" && local && configured.protocol === "http:"))) throw new Error();
    return configured.origin;
  } catch { throw new AsaasError("CONFIGURATION"); }
}

// Preserve Asaas's returned path/query verbatim and accept only exact environment origins.
export function checkedAsaasCheckoutLink(link: string, mode: "sandbox" | "production") {
  const payerOrigins = mode === "production" ? ["https://asaas.com", "https://www.asaas.com"] : ["https://sandbox.asaas.com"];
  if (link.length > 2048 || [...link].some(char => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127)
    || link.includes("\\") || link.includes("#")) throw new Error();
  const parsed = new URL(link);
  const authority = /^https:\/\/([^/?#]+)/i.exec(link)?.[1];
  if (parsed.protocol !== "https:" || !authority || authority.includes("@") || parsed.username || parsed.password
    || parsed.hash || parsed.port || !payerOrigins.includes(parsed.origin)) throw new Error();
  return link;
}

/** Fixed hosts only. Secrets remain in a closure and cannot enter JSON DTOs. */
export function createAsaasClient(env: Readonly<Record<string, string | undefined>> = process.env, fetcher: typeof fetch = fetch,
  transport?: {
    request: (path: string, options: RequestInit) => Promise<Response>;
    createHostedCheckout: (input: HostedCheckoutInput) => Promise<{ id: string; url: string }>;
  }) {
  const configuredMode = env.ASAAS_ENVIRONMENT;
  const key = env.ASAAS_API_KEY;
  if ((configuredMode !== "sandbox" && configuredMode !== "production") || (!transport && (!key || key.length < 32 || /[\r\n]/.test(key)))) throw new AsaasError("CONFIGURATION");
  const mode = configuredMode;
  const api = mode === "production" ? "https://api.asaas.com/v3" : "https://api-sandbox.asaas.com/v3";
  const payerOrigin = mode === "production" ? "https://asaas.com" : "https://sandbox.asaas.com";
  const request = transport?.request ?? ((path: string, options: RequestInit) => fetcher(`${api}${path}`, {
    ...options, headers: { access_token: key!, Accept: "application/json", "User-Agent": "CRIA-PING/1.0" },
  }));

  async function createHostedCheckout(input: HostedCheckoutInput) {
    const parsed = checkoutInput.safeParse(input);
    if (!parsed.success) throw new AsaasError("INVALID_REQUEST");
    if (transport) return transport.createHostedCheckout(parsed.data);
    // Configuration errors occur before fetch, outside UNKNOWN_OUTCOME handling.
    // Use the factory's environment mode consistently with its fixed API host.
    const origin = getAsaasCheckoutOrigin({ ASAAS_ENVIRONMENT: mode, NEXTAUTH_URL: env.NEXTAUTH_URL, AUTH_URL: env.AUTH_URL });
    const value = parsed.data;
    const callback = (result: string) => `${origin}/settings/billing?checkout=${encodeURIComponent(value.reference)}&result=${result}`;
    let response: Response;
    try {
      response = await fetcher(`${api}/checkouts`, {
        method: "POST", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(10_000),
        headers: { access_token: key!, "Content-Type": "application/json", "User-Agent": "CRIA-PING/1.0" },
        body: JSON.stringify({ billingTypes: ["CREDIT_CARD"], chargeTypes: ["RECURRENT"], minutesToExpire: 60,
          externalReference: value.reference,
          callback: { successUrl: callback("success"), cancelUrl: callback("canceled"), expiredUrl: callback("expired") },
          items: [{ name: value.name, quantity: 1, value: value.amountCents / 100 }],
          subscription: { cycle: "MONTHLY", nextDueDate: value.firstChargeDate },
        }),
      });
    } catch { throw new AsaasError("UNKNOWN_OUTCOME"); }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new AsaasError(response.status >= 500 || response.status === 408 || response.status === 409 ? "UNKNOWN_OUTCOME" : "REJECTED", response.status);
    }
    try {
      const body = await readBoundedJson(response);
      const result = z.object({ id: z.uuid(), link: z.string().min(1).max(2048).optional() }).safeParse(body);
      if (!result.success) throw new Error();
      // An invalid present link is an uncertain POST outcome, not a reason to
      // reconstruct/retry. The documented id-only canonical URL is a fallback
      // exclusively for responses that omit link. Neither URL grants paid access.
      const url = result.data.link === undefined ? `${payerOrigin}/checkoutSession/show?id=${encodeURIComponent(result.data.id)}` : checkedAsaasCheckoutLink(result.data.link, mode);
      return { id: result.data.id, url };
    } catch { throw new AsaasError("UNKNOWN_OUTCOME"); }
  }
  // GET failures never imply an uncertain financial mutation. No implicit retries.
  async function read<T>(path: string, schema: z.ZodType<T>): Promise<T> {
    const signal = AbortSignal.timeout(10_000);
    let response: Response;
    try {
      response = await request(path, {
        method: "GET", redirect: "error", cache: "no-store", signal,
      });
    } catch { throw new AsaasError("UNAVAILABLE"); }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new AsaasError(response.status >= 500 || response.status === 429 ? "UNAVAILABLE" : "REJECTED", response.status);
    }
    try {
      const parsed = schema.safeParse(await readBoundedJson(response));
      if (!parsed.success) throw new Error();
      return parsed.data;
    } catch { throw new AsaasError(signal.aborted ? "UNAVAILABLE" : "INVALID_RESPONSE"); }
  }

  async function getPayment(id: string): Promise<AsaasPaymentDTO> {
    if (!paymentId.safeParse(id).success) throw new AsaasError("INVALID_REQUEST");
    const payment = await read(`/payments/${encodeURIComponent(id)}`, paymentResponse);
    if (payment.id !== id) throw new AsaasError("INVALID_RESPONSE");
    return payment;
  }
  async function getSubscription(id: string): Promise<AsaasSubscriptionDTO> {
    if (!subscriptionId.safeParse(id).success) throw new AsaasError("INVALID_REQUEST");
    const subscription = await read(`/subscriptions/${encodeURIComponent(id)}`, subscriptionResponse);
    if (subscription.id !== id) throw new AsaasError("INVALID_RESPONSE");
    return subscription;
  }
  /** Links only; never use the result as financial state. */
  async function getPaymentLinks(id: string): Promise<AsaasPaymentLinksDTO> {
    if (!paymentId.safeParse(id).success) throw new AsaasError("INVALID_REQUEST");
    const payment = await read(`/payments/${encodeURIComponent(id)}`, paymentLinksResponse);
    if (payment.id !== id) throw new AsaasError("INVALID_RESPONSE");
    return payment;
  }
  /** Links only; never use the result as financial state. */
  async function getSubscriptionLinks(id: string): Promise<AsaasSubscriptionLinksDTO> {
    if (!subscriptionId.safeParse(id).success) throw new AsaasError("INVALID_REQUEST");
    const subscription = await read(`/subscriptions/${encodeURIComponent(id)}`, subscriptionLinksResponse);
    if (subscription.id !== id) throw new AsaasError("INVALID_RESPONSE");
    return subscription;
  }
  // Exactly one bounded page. Callers must inspect hasMore; no result is silently truncated.
  async function listPaymentsByCheckout(id: string, options: { offset?: number; limit?: number } = {}): Promise<AsaasPaymentPageDTO> {
    const page = pagination.safeParse(options);
    if (!checkoutSession.safeParse(id).success || !page.success) throw new AsaasError("INVALID_REQUEST");
    const query = new URLSearchParams({ checkoutSession: id, offset: String(page.data.offset), limit: String(page.data.limit) });
    const result = await read(`/payments?${query}`, paymentPageResponse);
    if (result.offset !== page.data.offset || result.limit !== page.data.limit || result.data.length > page.data.limit
      || result.data.some(payment => payment.checkoutSession !== id)) throw new AsaasError("INVALID_RESPONSE");
    return result;
  }

  // Official GET /v3/payments?subscription=... (reference/listar-cobrancas).
  // Renewals may have no checkoutSession; require the subscription link instead.
  async function listPaymentsBySubscription(id: string, options: { offset?: number; limit?: number } = {}): Promise<AsaasPaymentPageDTO> {
    const page = pagination.safeParse(options);
    if (!subscriptionId.safeParse(id).success || !page.success) throw new AsaasError("INVALID_REQUEST");
    const query = new URLSearchParams({ subscription: id, offset: String(page.data.offset), limit: String(page.data.limit) });
    const result = await read(`/payments?${query}`, paymentPageResponse);
    if (result.offset !== page.data.offset || result.limit !== page.data.limit || result.data.length > page.data.limit
      || result.data.some(payment => payment.subscription !== id)) throw new AsaasError("INVALID_RESPONSE");
    return result;
  }

  // Official DELETE /v3/subscriptions/{id} (reference/remover-assinatura).
  // Ends renewal and removes pending/overdue invoices; settled invoices remain.
  // The caller must authorize the persisted binding and preserve paid periods.
  async function cancelSubscription(id: string): Promise<AsaasSubscriptionCancellationDTO> {
    if (!subscriptionId.safeParse(id).success) throw new AsaasError("INVALID_REQUEST");
    let response: Response;
    try {
      response = await request(`/subscriptions/${encodeURIComponent(id)}`, {
        method: "DELETE", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(10_000),
      });
    } catch { throw new AsaasError("UNKNOWN_OUTCOME"); }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new AsaasError(response.status >= 500 || response.status === 408 || response.status === 409 ? "UNKNOWN_OUTCOME" : "REJECTED", response.status);
    }
    try {
      const result = cancellationResponse.safeParse(await readBoundedJson(response));
      if (!result.success || result.data.id !== id) throw new Error();
      return result.data;
    } catch { throw new AsaasError("UNKNOWN_OUTCOME"); }
  }
  return { createHostedCheckout, getPayment, getSubscription, getPaymentLinks, getSubscriptionLinks, listPaymentsByCheckout, listPaymentsBySubscription, cancelSubscription };
}
