"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import AccountSelect, { type AccountOption } from "./account-select";
import { useI18n } from "@/lib/i18n/provider";
import { Badge, Button, Card, EmptyState, Skeleton } from "./ui/primitives";
import { Input, Select } from "./ui/fields";
import { Dialog } from "./ui/dialog";
import { Toast } from "./ui/toast";
import styles from "./campaigns.module.css";

type Campaign = {
  id: string; name: string; keywords: string[]; dmMessage: string; isActive: boolean;
  instagramAccountId: string; instagramAccount: { username: string };
  matchAnyPost: boolean; pendingNextReel: boolean; postUrl: string | null; reportUrl: string | null; reportShareEnabled: boolean;
  analytics: { sent: number; clicks: number; ctr: number; failed: number; skipped: number };
};

export default function CriapingCampaigns() {
  const { t, locale } = useI18n();
  const [accounts, setAccounts] = useState<AccountOption[] | null>(null);
  const [account, setAccount] = useState("all");
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [loading, setLoading] = useState(true), [error, setError] = useState(false);
  const [search, setSearch] = useState(""), [status, setStatus] = useState("all");
  const [reload, setReload] = useState(0), [pending, setPending] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Campaign | null>(null);
  const [feedback, setFeedback] = useState<"success" | "error" | null>(null);
  const mutationLock = useRef(false);
  const generation = useRef(0);

  useEffect(() => {
    if (accounts) return;
    const abort = new AbortController();
    fetch("/api/dashboard/stats", { signal: abort.signal, cache: "no-store" })
      .then(async (res) => { const body = await res.json(); if (!res.ok || !body.success) throw Error(); return body.data.instagramAccounts as AccountOption[]; })
      .then((list) => {
        if (abort.signal.aborted) return;
        const requested = new URLSearchParams(window.location.search).get("instagramAccountId");
        setAccount(list.some((a) => a.id === requested) ? requested! : "all");
        setAccounts(list);
      }).catch(() => { if (!abort.signal.aborted) { setError(true); setLoading(false); } });
    return () => abort.abort();
  }, [accounts, reload]);

  useEffect(() => {
    if (!accounts) return;
    const abort = new AbortController();
    const timer = window.setTimeout(async () => {
      setLoading(true); setError(false);
      try {
        const query = account === "all" ? "" : `?${new URLSearchParams({ instagramAccountId: account })}`;
        const res = await fetch(`/api/automations${query}`, { signal: abort.signal, cache: "no-store" });
        const body = await res.json();
        if (!res.ok || !body.success || !Array.isArray(body.data)) throw Error();
        if (!abort.signal.aborted) setCampaigns(body.data);
      } catch { if (!abort.signal.aborted) setError(true); }
      finally { if (!abort.signal.aborted) setLoading(false); }
    }, 0);
    return () => { abort.abort(); window.clearTimeout(timer); };
  }, [account, accounts, reload]);

  async function mutate(campaign: Campaign, action: "toggle" | "duplicate" | "delete") {
    if (mutationLock.current) return;
    mutationLock.current = true; setPending(campaign.id); setFeedback(null);
    const currentGeneration = generation.current;
    try {
      const res = await fetch(`/api/automations${action === "duplicate" ? "/duplicate" : ""}?${new URLSearchParams({ id: campaign.id })}`, {
        method: action === "delete" ? "DELETE" : action === "duplicate" ? "POST" : "PATCH",
        ...(action === "toggle" ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ isActive: !campaign.isActive }) } : {}),
      });
      const body = await res.json();
      if (!res.ok || !body.success) throw Error();
      setDeleting(null); setFeedback("success");
      if (generation.current === currentGeneration) {
        if (action === "delete") setCampaigns((list) => list.filter((c) => c.id !== campaign.id));
        else if (action === "toggle") setCampaigns((list) => list.map((c) => c.id === campaign.id ? { ...c, isActive: !campaign.isActive } : c));
        else { setLoading(true); setReload((n) => n + 1); }
      }
    } catch { setFeedback("error"); }
    finally { mutationLock.current = false; setPending(null); }
  }

  const query = search.trim().toLocaleLowerCase(locale);
  const filtered = campaigns.filter((c) => (account === "all" || c.instagramAccountId === account) && (status === "all" || c.isActive === (status === "active")) && [c.name, c.dmMessage, ...c.keywords].some((value) => value.toLocaleLowerCase(locale).includes(query)));
  const createHref = account === "all" ? "/campaigns/new" : `/campaigns/new?${new URLSearchParams({ instagramAccountId: account })}`;
  return <div className={styles.page}>
    <header className={styles.header}><div><h1>{t("Campaigns")}</h1><p>{t("Manage real campaigns for your connected accounts.")}</p></div><div className={styles.actions}><Link className={styles.link} href="/campaigns/import">{t("Import")}</Link><Link className={styles.primaryLink} href={createHref}>{t("New Campaign")}</Link></div></header>
    <Card><div className={styles.filters}>
      {accounts && <AccountSelect newDesign accounts={accounts} value={account} onChange={(id) => { generation.current++; setAccount(id); setLoading(true); setDeleting(null); window.history.replaceState(null, "", id === "all" ? "/campaigns" : `/campaigns?${new URLSearchParams({ instagramAccountId: id })}`); }} />}
      <Input type="search" label={t("Search campaigns")} value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t("Search campaigns by name, keyword, or message…")} />
      <Select label={t("Status")} value={status} onChange={(e) => setStatus(e.target.value)}><option value="all">{t("All")}</option><option value="active">{t("Active")}</option><option value="paused">{t("Paused")}</option></Select>
    </div></Card>
    {loading ? <Skeleton label={t("Loading campaigns")} /> : error ? <EmptyState title={t("Campaigns unavailable")} description={t("We could not load your campaigns. No estimated data is shown.")} action={<Button onClick={() => { setError(false); setLoading(true); setReload((n) => n + 1); }}>{t("Try again")}</Button>} /> : accounts?.length === 0 ? <EmptyState title={t("Connect Instagram")} description={t("Connect an Instagram professional account to launch campaigns.")} action={<a className={styles.primaryLink} href="/api/instagram/connect">{t("Connect Instagram")}</a>} /> : !filtered.length ? <EmptyState title={campaigns.length ? t("No campaigns match your search.") : t("No campaigns yet")} action={<Link className={styles.primaryLink} href={createHref}>{t("Create Campaign")}</Link>} /> : <>
      <p role="status">{t("{count} campaigns", { count: filtered.length })}</p>
      <div className={styles.list}>{filtered.map((c) => <Card key={c.id} aria-labelledby={`campaign-${c.id}`}>
        <div className={styles.header}><div><h2 id={`campaign-${c.id}`}><Link href={`/campaigns/${encodeURIComponent(c.id)}`}>{c.name}</Link></h2><p>@{c.instagramAccount.username}</p></div><Badge tone={c.isActive ? "success" : "neutral"}>{c.isActive ? t("Active") : t("Paused")}</Badge></div>
        <p>{c.matchAnyPost ? t("any post or reel") : c.pendingNextReel ? t("next post or reel") : t("a specific post or reel")}</p><p className={styles.wrap}>{c.keywords.join(", ") || t("any word")}</p><p className={styles.message}>{c.dmMessage}</p>
        <dl className={styles.metrics}>{[[t("sent"), c.analytics.sent], [t("clicks"), c.analytics.clicks], [t("% CTR"), c.analytics.ctr], [t("failed"), c.analytics.failed], [t("skipped"), c.analytics.skipped]].map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{Number(value).toLocaleString(locale)}</dd></div>)}</dl>
        <div className={styles.actions}><Link className={styles.link} href={`/campaigns/${encodeURIComponent(c.id)}/edit`}>{t("Edit campaign")}</Link><Link className={styles.link} href={`/campaigns/${encodeURIComponent(c.id)}`}>{t("View report")}</Link>{c.reportUrl && c.reportShareEnabled && <a className={styles.link} href={c.reportUrl} target="_blank" rel="noreferrer">{t("Public report")}</a>}{c.postUrl && <a className={styles.link} href={c.postUrl} target="_blank" rel="noreferrer">{t("Open on Instagram")}</a>}
          <Button variant="secondary" disabled={pending !== null} onClick={() => void mutate(c, "toggle")}>{c.isActive ? t("Pause") : t("Activate")}</Button><Button variant="secondary" disabled={pending !== null} onClick={() => void mutate(c, "duplicate")}>{t("Duplicate")}</Button><Button variant="danger" disabled={pending !== null} onClick={() => setDeleting(c)}>{t("Delete")}</Button>
        </div>
      </Card>)}</div>
    </>}
    <Dialog open={!!deleting} onClose={() => { if (!pending) setDeleting(null); }} title={t("Delete this campaign? This cannot be undone.")} description={deleting?.name} closeLabel={t("Cancel")}>{feedback === "error" && <p role="alert">{t("Campaign action failed. Nothing was confirmed. Please try again.")}</p>}<Button variant="danger" loading={pending !== null} onClick={() => deleting && void mutate(deleting, "delete")}>{t("Confirm deletion")}</Button></Dialog>
    <Toast message={feedback ? t(feedback === "success" ? "Campaign updated." : "Campaign action failed. Nothing was confirmed. Please try again.") : ""} tone={feedback ?? "success"} dismissLabel={t("Dismiss notification")} onDismiss={() => setFeedback(null)} />
  </div>;
}
