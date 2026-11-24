import { z } from "zod";

// Browser-only contract: no server configuration, provider SDK or Prisma import.
export type BillingRole = "OWNER" | "ADMIN" | "MEMBER";
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const date = z.string().datetime({ offset: true });
const planId = z.string().min(1).max(80);
const statusNames = ["NOT_STARTED", "TRIALING", "ACTIVE", "EXPIRED", "CANCELED", "PAST_DUE", "SUSPENDED", "REVIEW_REQUIRED", "LIFETIME"] as const;
export const trialStatusSchema = z.object({ status: z.enum(statusNames), hasAccess: z.boolean(), trialStartedAt: date.nullable(), trialEndsAt: date.nullable(), paidThrough: date.nullable(), planId: planId.nullable() });
export const billingStatusSchema = z.object({
  enabled: z.boolean(), status: z.enum(statusNames).optional(), hasAccess: z.boolean().optional(),
  trialStartedAt: date.nullable().optional(), trialEndsAt: date.nullable().optional(), paidThrough: date.nullable().optional(),
  planId: planId.nullable().optional(), canCancelRenewal: z.boolean().optional(), cancellationPending: z.boolean().optional(),
}).refine(value => !value.enabled || (value.status !== undefined && value.hasAccess !== undefined));
const limits = z.object({ accounts: count, members: count, dms: count, publications: count, storageBytes: count, transferBytes: count });
export const billingPlansSchema = z.object({ plans: z.array(z.object({
  id: planId, name: z.string().min(1).max(100), amountCents: count.refine(value => value > 0), currency: z.literal("BRL"),
  interval: z.literal("MONTHLY"), trialDays: z.literal(3), cardRequiredForTrial: z.literal(false), quotas: limits,
})).max(20) });
const counter = z.object({ consumed: count, reserved: count, limit: count });
export const billingUsageSchema = z.discriminatedUnion("hasAccess", [
  z.object({ hasAccess: z.literal(false), code: z.string().max(64), limits: z.null(), counters: z.null() }),
  z.object({ hasAccess: z.literal(true), kind: z.enum(["trial", "paid", "lifetime"]), periodStart: date, periodEnd: date, limits,
    metering: z.object({ storage: z.literal("NOT_REPORTED"), transfer: z.literal("NOT_METERED") }),
    usageVisibility: z.enum(["OWNER_ONLY", "AVAILABLE"]),
    counters: z.object({ dms: counter, publications: counter, storage: z.null(), transfer: z.null() }).nullable(),
  }).refine(value => value.usageVisibility !== "OWNER_ONLY" || value.counters === null),
]);
export function safeAsaasCheckoutUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2048 || /[\x00-\x20\x7f\\#]/.test(value)) return null;
  try {
    const url = new URL(value), authority = /^https:\/\/([^/?#]+)/i.exec(value)?.[1];
    if (url.protocol !== "https:" || !authority || authority.includes("@") || url.username || url.password || url.port || url.hash
      || !["https://asaas.com", "https://www.asaas.com", "https://sandbox.asaas.com"].includes(url.origin)) return null;
    return value;
  } catch { return null; }
}
export const checkoutSchema = z.object({ id: z.uuid(), status: z.enum(["CREATING", "OPEN", "UNKNOWN", "COMPLETED", "CANCELED", "EXPIRED", "REJECTED"]),
  planId, amountCents: count.refine(value => value > 0), url: z.string().nullable(),
}).refine(value => value.url === null || (value.status === "OPEN" && safeAsaasCheckoutUrl(value.url) !== null));
export const cancellationSchema = z.object({ id: z.uuid(), status: z.enum(["PENDING", "PROCESSING", "RETRY", "PROCESSED", "DEAD"]) });
export type BillingStatus = z.infer<typeof billingStatusSchema>;
export type BillingPlan = z.infer<typeof billingPlansSchema>["plans"][number];
export type BillingUsage = z.infer<typeof billingUsageSchema>;
export type Checkout = z.infer<typeof checkoutSchema>;
export type Cancellation = z.infer<typeof cancellationSchema>;
const pendingSchema = z.object({ requestId: z.uuid(), id: z.uuid().optional() }).strict();
export type PendingBillingRequest = z.infer<typeof pendingSchema>;
export const savedBillingSchema = z.object({ checkout: pendingSchema.nullable(), cancellation: pendingSchema.nullable() }).strict();
export type SavedBillingRequests = z.infer<typeof savedBillingSchema>;
export class BillingBrowserError extends Error {
  constructor(readonly code: string, readonly status = 503) { super("Billing action unavailable"); }
}
const workspacePin = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/);
export function isWorkspaceContextError(error: unknown): boolean {
  return error instanceof BillingBrowserError && ["WORKSPACE_CHANGED", "WORKSPACE_CONTEXT_REQUIRED"].includes(error.code);
}
type RequestOptions = { workspaceId: string; signal?: AbortSignal; fetcher?: typeof fetch; method?: "GET" | "POST"; body?: unknown };
export async function billingRequest<T>(path: string, schema: z.ZodType<T>, options: RequestOptions): Promise<T> {
  if (!workspacePin.safeParse(options.workspaceId).success) throw new BillingBrowserError("WORKSPACE_CONTEXT_REQUIRED", 400);
  if (!/^\/api\/billing\/(status|plans|usage|trial|checkout|cancel)(\?id=[a-fA-F0-9-]{36})?$/.test(path)) throw new BillingBrowserError("INVALID_REQUEST", 400);
  const controller = new AbortController(), abort = () => controller.abort();
  if (options.signal?.aborted) controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(abort, 35_000);
  try {
    const response = await (options.fetcher ?? fetch)(path, { method: options.method ?? "GET", credentials: "same-origin", cache: "no-store", redirect: "error",
      signal: controller.signal, headers: { "x-cria-workspace-id": options.workspaceId, ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}) },
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}) });
    const body: unknown = await response.json();
    if (!response.ok) {
      const error = z.object({ error: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/) }).safeParse(body);
      throw new BillingBrowserError(error.success ? error.data.error : "BILLING_UNAVAILABLE", response.status);
    }
    const result = z.object({ success: z.literal(true), data: schema }).safeParse(body);
    if (!result.success) throw new BillingBrowserError("INVALID_RESPONSE");
    return result.data.data;
  } finally { clearTimeout(timeout); options.signal?.removeEventListener("abort", abort); }
}
export function checkoutPending(value: Checkout) { return value.status === "CREATING" || value.status === "UNKNOWN"; }
export function checkoutClosed(value: Checkout) { return ["COMPLETED", "CANCELED", "EXPIRED", "REJECTED"].includes(value.status); }
export function cancellationPending(value: Cancellation) { return ["PENDING", "PROCESSING", "RETRY"].includes(value.status); }
type MutationOptions = { workspaceId: string; role: BillingRole; requestId: string; previous: PendingBillingRequest | null; consent: boolean;
  persist: (pending: PendingBillingRequest | null) => void; signal?: AbortSignal; fetcher?: typeof fetch };
function mutationIntent(input: MutationOptions) {
  if (input.role !== "OWNER") throw new BillingBrowserError("FORBIDDEN", 403);
  if (!workspacePin.safeParse(input.workspaceId).success) throw new BillingBrowserError("WORKSPACE_CONTEXT_REQUIRED", 400);
  if (!input.consent || !z.uuid().safeParse(input.requestId).success || input.previous) throw new BillingBrowserError("REQUEST_BLOCKED", 409);
  input.persist({ requestId: input.requestId }); // Durable browser intent BEFORE the only POST.
}
export async function createBrowserCheckout(input: MutationOptions & { plan: BillingPlan }) {
  mutationIntent(input);
  try {
    const value = await billingRequest("/api/billing/checkout", checkoutSchema, { ...input, method: "POST",
      body: { requestId: input.requestId, planId: input.plan.id, expectedAmountCents: input.plan.amountCents, acceptImmediateCharge: true } });
    input.persist(checkoutClosed(value) ? null : { requestId: input.requestId, id: value.id }); return value;
  } catch (error) {
    // Only explicit backend no-effect outcomes permit a NEW user action. Never
    // clear ambiguous POST/network results. CHECKOUT_IN_PROGRESS is a known
    // no-effect conflict, not an unknown charge created by this request.
    if (error instanceof BillingBrowserError && ["FORBIDDEN", "UNAUTHORIZED", "INVALID_REQUEST", "OFFER_CHANGED", "TRIAL_NOT_STARTED",
      "ALREADY_PAID", "LIFETIME_ACCESS_ACTIVE", "SUBSCRIPTION_EXISTS", "FINANCIAL_SYNC_BUSY", "RATE_LIMITED", "PROVIDER_REJECTED", "BILLING_SUSPENDED", "BILLING_DISABLED", "BILLING_SALES_DISABLED",
      "CHECKOUT_IN_PROGRESS", "BILLING_CONFIGURATION", "WORKSPACE_CONTEXT_REQUIRED", "WORKSPACE_CHANGED"].includes(error.code)) input.persist(null);
    throw error;
  }
}
export async function createBrowserCancellation(input: MutationOptions) {
  mutationIntent(input);
  try { return await postCancellation(input); }
  catch (error) {
    if (error instanceof BillingBrowserError && ["FORBIDDEN", "UNAUTHORIZED", "INVALID_REQUEST", "NOT_SUBSCRIBED", "BILLING_DISABLED", "BILLING_CONFIGURATION",
      "WORKSPACE_CONTEXT_REQUIRED", "WORKSPACE_CHANGED"].includes(error.code)) input.persist(null);
    throw error;
  }
}
async function postCancellation(input: Pick<MutationOptions, "workspaceId" | "requestId" | "persist" | "signal" | "fetcher">) {
  const value = await billingRequest("/api/billing/cancel", cancellationSchema, { ...input, method: "POST", body: { requestId: input.requestId } });
  input.persist(value.status === "PROCESSED" ? null : { requestId: input.requestId, id: value.id }); return value;
}
/** Explicit user action only. Reuse the original durable request identity; an
 * error on this retry cannot disprove the outcome of the earlier attempt. */
export async function resumeBrowserCancellation(input: Omit<MutationOptions, "requestId" | "previous" | "consent"> & { pending: PendingBillingRequest }) {
  if (input.role !== "OWNER") throw new BillingBrowserError("FORBIDDEN", 403);
  if (!workspacePin.safeParse(input.workspaceId).success) throw new BillingBrowserError("WORKSPACE_CONTEXT_REQUIRED", 400);
  const pending = pendingSchema.safeParse(input.pending);
  if (!pending.success || pending.data.id) throw new BillingBrowserError("REQUEST_BLOCKED", 409);
  input.persist(pending.data);
  return postCancellation({ ...input, requestId: pending.data.requestId });
}
export async function pollBillingOperation<T extends Checkout | Cancellation>(kind: "checkout" | "cancel", id: string, schema: z.ZodType<T>,
  onValue: (value: T) => void, options: RequestOptions & { attempts?: number; wait?: (signal?: AbortSignal) => Promise<void> }) {
  if (!z.uuid().safeParse(id).success) throw new BillingBrowserError("INVALID_REQUEST", 400);
  const attempts = options.attempts ?? 4;
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 4) throw new BillingBrowserError("INVALID_REQUEST", 400);
  for (let index = 0; index < attempts; index++) {
    const value = await billingRequest(`/api/billing/${kind}?id=${id}`, schema, { ...options, method: "GET", body: undefined }); onValue(value);
    const pending = kind === "checkout" ? checkoutPending(value as Checkout) : cancellationPending(value as Cancellation);
    if (!pending || index === attempts - 1) return value;
    if (options.wait) await options.wait(options.signal);
    else await new Promise<void>((resolve, reject) => {
      const stop = () => { clearTimeout(timer); reject(new BillingBrowserError("ABORTED")); };
      const timer = setTimeout(() => { options.signal?.removeEventListener("abort", stop); resolve(); }, 3_000);
      if (options.signal?.aborted) stop(); else options.signal?.addEventListener("abort", stop, { once: true });
    });
  }
}
