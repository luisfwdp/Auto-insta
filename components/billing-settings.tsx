"use client";

import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/lib/i18n/provider";
import { Button, Card } from "@/components/ui/primitives";
import {
  billingRequest, billingStatusSchema, trialStatusSchema, billingPlansSchema, billingUsageSchema, checkoutSchema, cancellationSchema,
  savedBillingSchema, createBrowserCheckout, createBrowserCancellation, pollBillingOperation, checkoutPending, checkoutClosed,
  cancellationPending, safeAsaasCheckoutUrl, BillingBrowserError,
  type BillingRole, type BillingStatus, type BillingPlan, type BillingUsage, type Checkout, type Cancellation,
  type SavedBillingRequests, type PendingBillingRequest,
} from "@/lib/billing/browser-contract";

const emptyRequests = (): SavedBillingRequests => ({ checkout: null, cancellation: null });
const statusLabels = {
  NOT_STARTED: "Trial not started", TRIALING: "Trial active", ACTIVE: "Subscription active", EXPIRED: "Access expired",
  CANCELED: "Renewal canceled", PAST_DUE: "Payment past due", SUSPENDED: "Access suspended", REVIEW_REQUIRED: "Billing needs review",
} as const;

export function BillingSettings(props: { role: BillingRole; workspaceId: string }) {
  // Discard stale data immediately when the server selects another workspace.
  return <BillingWorkspace key={props.workspaceId} {...props} />;
}

function BillingWorkspace({ role, workspaceId }: { role: BillingRole; workspaceId: string }) {
  const { t, locale } = useI18n();
  const [status, setStatus] = useState<BillingStatus | null>(null), [plans, setPlans] = useState<BillingPlan[]>([]);
  const [usage, setUsage] = useState<BillingUsage | null>(null), [requests, setRequests] = useState(emptyRequests);
  const [checkout, setCheckout] = useState<Checkout | null>(null), [cancellation, setCancellation] = useState<Cancellation | null>(null);
  const [consent, setConsent] = useState<string | null>(null), [cancelConsent, setCancelConsent] = useState(false);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState(false), [forbidden, setForbidden] = useState(false), [storageReady, setStorageReady] = useState(false);
  const state = useRef(emptyRequests()), active = useRef<AbortController | null>(null), locked = useRef(false);
  const owner = role === "OWNER" && !forbidden, storageKey = `criaping:billing:${workspaceId}`;
  const alive = () => active.current !== null && !active.current.signal.aborted;
  const currency = (amount: number) => new Intl.NumberFormat(locale, { style: "currency", currency: "BRL" }).format(amount / 100);
  const when = (value: string) => new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));

  function persist(kind: "checkout" | "cancellation", value: PendingBillingRequest | null) {
    const next = { ...state.current, [kind]: value };
    // If browser storage is unavailable, do not send a financial mutation.
    sessionStorage.setItem(storageKey, JSON.stringify(next)); state.current = next;
    if (alive()) setRequests(next);
  }
  async function refresh(signal = active.current?.signal) {
    const result = await billingRequest("/api/billing/status", billingStatusSchema, { signal });
    if (!signal?.aborted) setStatus(result);
    if (result.enabled) {
      const values = await Promise.allSettled([
        billingRequest("/api/billing/plans", billingPlansSchema, { signal }),
        billingRequest("/api/billing/usage", billingUsageSchema, { signal }),
      ]);
      if (!signal?.aborted) {
        setPlans(values[0].status === "fulfilled" ? values[0].value.plans : []);
        setUsage(values[1].status === "fulfilled" ? values[1].value : null);
      }
    } else if (!signal?.aborted) { setPlans([]); setUsage(null); }
    return result;
  }
  async function track(kind: "checkout" | "cancellation", reference: PendingBillingRequest, signal = active.current?.signal) {
    if (!reference.id) return;
    if (kind === "checkout") await pollBillingOperation("checkout", reference.id, checkoutSchema, value => {
      if (signal?.aborted) return; setCheckout(value); persist("checkout", checkoutClosed(value) ? null : reference);
    }, { signal });
    else await pollBillingOperation("cancel", reference.id, cancellationSchema, value => {
      if (signal?.aborted) return; setCancellation(value); persist("cancellation", value.status === "PROCESSED" ? null : reference);
    }, { signal });
    await refresh(signal);
  }
  async function run(operation: () => Promise<unknown>) {
    if (locked.current) return;
    locked.current = true; setBusy(true); setError(false);
    try { await operation(); }
    catch (failure) { if (alive()) { setError(true); if (failure instanceof BillingBrowserError && failure.status === 403 && failure.code !== "BILLING_SUSPENDED") setForbidden(true); } }
    finally { locked.current = false; if (alive()) setBusy(false); }
  }
  useEffect(() => {
    const controller = new AbortController(); active.current = controller;
    void (async () => {
      try {
        const overview = await refresh(controller.signal);
        const raw = sessionStorage.getItem(storageKey), saved = raw ? savedBillingSchema.safeParse(JSON.parse(raw)) : null;
        if (controller.signal.aborted) return;
        if (raw && !saved?.success) throw new Error("Invalid saved billing request");
        setStorageReady(true);
        if (saved?.success) { state.current = saved.data; setRequests(saved.data); }
        if (role === "OWNER" && saved?.success) {
          if (overview.enabled && saved.data.checkout?.id) await track("checkout", saved.data.checkout, controller.signal);
          if (saved.data.cancellation?.id) await track("cancellation", saved.data.cancellation, controller.signal);
        }
      } catch { if (!controller.signal.aborted) setError(true); }
      finally { if (!controller.signal.aborted) setLoading(false); }
    })();
    return () => controller.abort();
    // One bootstrap per workspace/role. Polling is bounded and never driven by
    // response state, which would restart its attempt budget on every update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, role]);

  const checkoutLink = checkout?.status === "OPEN" ? safeAsaasCheckoutUrl(checkout.url) : null;
  const alreadyPaid = status?.hasAccess === true && status.status !== "TRIALING";
  const buyEligible = status?.status !== undefined && ["TRIALING", "EXPIRED", "CANCELED"].includes(status.status) && !status.canCancelRenewal;
  const canBuy = owner && storageReady && buyEligible && status?.enabled === true && !alreadyPaid && !requests.checkout && !busy && !loading;
  const trialAvailable = owner && status?.enabled === true && status.status === "NOT_STARTED";
  return <Card aria-busy={busy || loading} className="space-y-6 border border-[#494949] bg-[#1A1A1A] p-5 text-[#F5F5F5]">
    <div><h2 className="text-xl font-semibold">{t("Billing and subscription")}</h2><p className="mt-1 text-sm text-[#B5B5B5]">{t("Manage your trial, subscription and renewal.")}</p></div>
    {loading ? <p role="status" aria-busy="true">{t("Loading billing details")}</p> : null}
    {error ? <p role="alert" className="text-sm text-red-300">{t(status ? "Billing action could not be completed. Refresh before trying again." : "Billing details are unavailable. Try again.")}</p> : null}
    {!owner ? <p className="text-sm text-[#B5B5B5]">{t("Only the workspace owner can start a trial or change billing.")}</p> : null}
    {status?.enabled === false ? <p>{t("Billing is not enabled for this workspace.")}</p> : null}
    {status?.status ? <div className="space-y-1 text-sm">
      <p>{t("Subscription status")}: <strong>{t(statusLabels[status.status])}</strong></p>
      <p>{t(status.hasAccess ? "Recorded access is active." : "Recorded access is inactive.")}</p>
      {status.trialEndsAt ? <p>{t("Trial ends on {date}", { date: when(status.trialEndsAt) })}</p> : null}
      {status.paidThrough ? <p>{t("Paid period through {date}", { date: when(status.paidThrough) })}</p> : null}
    </div> : null}
    {trialAvailable ? <div className="space-y-2"><p>{t("3 days free. No card required.")}</p><Button disabled={busy || loading} onClick={() => void run(async () => {
      await billingRequest("/api/billing/trial", trialStatusSchema, { method: "POST", signal: active.current?.signal }); await refresh();
    })}>{t("Start your 3-day trial")}</Button></div> : null}

    {status?.enabled ? <section className="space-y-3" aria-label={t("Usage this period")}>
      <h3 className="font-semibold">{t("Usage this period")}</h3>
      {usage?.hasAccess && usage.counters ? <>
        <p className="text-xs text-[#B5B5B5]">{t("Period: {start} – {end}", { start: when(usage.periodStart), end: when(usage.periodEnd) })}</p>
        {(["dms", "publications"] as const).map(kind => <p key={kind} className="text-sm">{t(kind === "dms" ? "DM usage" : "Publication usage")}: {t("Used: {used}; reserved: {reserved}; limit: {limit}", {
          used: usage.counters![kind].consumed.toLocaleString(locale), reserved: usage.counters![kind].reserved.toLocaleString(locale), limit: usage.counters![kind].limit.toLocaleString(locale),
        })}</p>)}
      </> : <p className="text-sm text-[#B5B5B5]">{t(usage?.hasAccess && usage.usageVisibility === "OWNER_ONLY" ? "Usage is visible only to the trial owner." : "Usage is unavailable for the current access status.")}</p>}
      <p className="text-xs text-[#B5B5B5]">{t("Storage usage is not reported.")} {t("Data transfer is not metered.")}</p>
    </section> : null}

    {status?.enabled && requests.checkout ? <div className="space-y-3 rounded-lg border border-[#494949] p-4" role="status">
      <p>{t(!requests.checkout.id ? "An earlier request has an unknown outcome. No new charge request will be sent." : checkout && !checkoutPending(checkout) ? "Payment confirmation is pending. Access changes only after confirmation." : "Checkout creation is pending. Do not create another checkout.")}</p>
      {owner && checkoutLink ? <a className="inline-block rounded bg-[#C7FF2F] px-4 py-2 font-semibold text-[#0B0B0B]" href={checkoutLink} target="_blank" rel="noopener noreferrer">{t("Continue at Asaas")}</a> : null}
      {owner && checkout?.status === "OPEN" && !checkoutLink ? <p role="alert">{t("Invalid or unavailable checkout link.")}</p> : null}
      {owner && requests.checkout.id ? <Button variant="secondary" disabled={busy || loading} onClick={() => void run(() => track("checkout", requests.checkout!))}>{t(checkoutLink ? "Review payment status" : "Resume checkout lookup")}</Button> : <p className="text-sm">{t("Checkout requires operational review. Do not start another purchase.")}</p>}
    </div> : null}

    {status?.enabled && !requests.checkout && !alreadyPaid ? <section className="space-y-3">
      {!plans.length && !loading ? <p>{t("New subscriptions are temporarily unavailable.")}</p> : null}
      <div className="grid gap-4 lg:grid-cols-3">{plans.map(plan => <div key={plan.id} className="space-y-3 rounded-lg border border-[#494949] bg-[#0B0B0B] p-4">
        <h3 className="font-semibold">{plan.name}</h3><p className="text-lg text-[#C7FF2F]">{t("{price} per month", { price: currency(plan.amountCents) })}</p>
        <ul className="space-y-1 text-sm text-[#B5B5B5]"><li>{t("Instagram accounts: {count}", { count: plan.quotas.accounts })}</li><li>{t("Team members: {count}", { count: plan.quotas.members })}</li><li>{t("DMs per period: {count}", { count: plan.quotas.dms.toLocaleString(locale) })}</li><li>{t("Publications per period: {count}", { count: plan.quotas.publications.toLocaleString(locale) })}</li><li>{t("Storage included: {size}", { size: `${plan.quotas.storageBytes / 1_000_000_000} GB` })}</li></ul>
        {owner ? <><label className="flex items-start gap-2 text-xs"><input type="checkbox" checked={consent === `${plan.id}:${plan.amountCents}`} disabled={!canBuy} onChange={event => setConsent(event.target.checked ? `${plan.id}:${plan.amountCents}` : null)} /><span>{t("I authorize a subscription charge now for {price} per month. This is optional during my free trial.", { price: currency(plan.amountCents) })}</span></label>
          <Button disabled={!canBuy || consent !== `${plan.id}:${plan.amountCents}`} onClick={() => void run(async () => {
            const value = await createBrowserCheckout({ role, plan, consent: consent === `${plan.id}:${plan.amountCents}`, requestId: crypto.randomUUID(), previous: state.current.checkout,
              persist: pending => persist("checkout", pending), signal: active.current?.signal });
            if (!alive()) return; setCheckout(value); setConsent(null);
            if (checkoutPending(value)) await track("checkout", state.current.checkout!); else await refresh();
          })}>{t("Create secure Asaas checkout")}</Button></> : null}
      </div>)}</div>
    </section> : null}

    {owner && (status?.canCancelRenewal || requests.cancellation) ? <section className="space-y-3 border-t border-[#494949] pt-4">
      <h3 className="font-semibold">{t("Cancel automatic renewal")}</h3><p className="text-sm text-[#B5B5B5]">{t("Your recorded paid period remains unchanged; this request stops renewal.")}</p>
      {requests.cancellation || status?.cancellationPending ? <>
        <p role="status">{t(cancellation?.status === "DEAD" || (requests.cancellation && !requests.cancellation.id) ? "Cancellation requires operational review." : "Renewal cancellation is being processed.")}</p>
        {requests.cancellation?.id ? <Button variant="secondary" disabled={busy || loading} onClick={() => void run(() => track("cancellation", requests.cancellation!))}>{t("Resume cancellation lookup")}</Button> : null}
      </> : <><label className="flex gap-2 text-sm"><input type="checkbox" checked={cancelConsent} onChange={event => setCancelConsent(event.target.checked)} disabled={busy || loading} />{t("I want to stop automatic renewal after the current paid period.")}</label>
        <Button variant="danger" disabled={busy || loading || !storageReady || !cancelConsent} onClick={() => void run(async () => {
          const value = await createBrowserCancellation({ role, consent: cancelConsent, requestId: crypto.randomUUID(), previous: state.current.cancellation,
            persist: pending => persist("cancellation", pending), signal: active.current?.signal });
          if (!alive()) return; setCancellation(value); setCancelConsent(false);
          if (cancellationPending(value)) await track("cancellation", state.current.cancellation!); else await refresh();
        })}>{t("Confirm renewal cancellation")}</Button></>}
    </section> : null}
    {cancellation?.status === "PROCESSED" ? <p role="status">{t("Cancellation request completed.")}</p> : null}
    <Button variant="secondary" disabled={busy || loading} onClick={() => void run(() => refresh())}>{t("Refresh billing status")}</Button>
  </Card>;
}

export function TrialOnboarding({ role, onSuccessHref = "/settings" }: { role: BillingRole; onSuccessHref?: string }) {
  const { t } = useI18n(); const [status, setStatus] = useState<BillingStatus | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState(false);
  const lock = useRef(false);
  useEffect(() => { const controller = new AbortController(); void billingRequest("/api/billing/status", billingStatusSchema, { signal: controller.signal })
    .then(value => { if (!controller.signal.aborted) setStatus(value); }).catch(() => { if (!controller.signal.aborted) setError(true); });
    return () => controller.abort(); }, []);
  const href = /^\/(?!\/)[^\\\x00-\x20]*$/.test(onSuccessHref) ? onSuccessHref : "/settings";
  return <Card aria-busy={busy || (!status && !error)} className="space-y-3 border border-[#494949] bg-[#1A1A1A] p-5 text-[#F5F5F5]">
    <h2 className="text-xl font-semibold">{t("3 days free. No card required.")}</h2>
    {!status && !error ? <p role="status">{t("Loading billing details")}</p> : null}
    {error ? <p role="alert">{t("Trial could not be started. No card was requested.")}</p> : null}
    {status?.hasAccess ? <><p>{t("Your trial is ready. Connect Instagram to continue.")}</p><a className="inline-block rounded bg-[#C7FF2F] px-4 py-2 font-semibold text-[#0B0B0B]" href={href}>{t("Connect Instagram")}</a></> : status?.enabled && status.status === "NOT_STARTED" && role === "OWNER" ? <Button disabled={busy} onClick={() => {
      if (lock.current) return; lock.current = true; setBusy(true); setError(false);
      void (async () => { try {
        await billingRequest("/api/billing/trial", trialStatusSchema, { method: "POST" });
        setStatus(await billingRequest("/api/billing/status", billingStatusSchema));
      } catch { setError(true); } finally { lock.current = false; setBusy(false); } })();
    }}>{t("Start your 3-day trial")}</Button> : status?.enabled === false ? <p>{t("Billing is not enabled for this workspace.")}</p> : status ? <><p>{t(role !== "OWNER" ? "Only the workspace owner can start a trial or change billing." : "Your trial has ended. Choose a subscription to continue.")}</p><a href="/billing" className="text-[#C7FF2F] underline">{t("See subscription plans")}</a></> : null}
  </Card>;
}
