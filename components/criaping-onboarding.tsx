"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import AccountSelect, { type AccountOption } from "./account-select";
import { Badge, Button, Card, EmptyState, Skeleton } from "./ui/primitives";
import { useI18n } from "@/lib/i18n/provider";
import styles from "./campaigns.module.css";

type Account = AccountOption & {
  provider?: "META" | "ZERNIO";
  tokenExpiresAt: string | null;
  webhookSubscribed: boolean;
};

export default function CriapingOnboarding({ metaConfigured }: { metaConfigured: boolean }) {
  const { t, locale } = useI18n();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [selected, setSelected] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<number | null>(null);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    let active = true;
    const timer = window.setTimeout(() => abort.abort(), 20000);
    fetch("/api/dashboard/stats", { cache: "no-store", signal: abort.signal })
      .then(async (response) => {
        if (!response.ok) { if (active) setError(response.status); return; }
        const payload = await response.json();
        if (!payload.success || !Array.isArray(payload.data?.instagramAccounts)) throw Error();
        if (active) {
          const list: Account[] = payload.data.instagramAccounts;
          setAccounts(list); setSelected(list[0]?.id ?? "");
        }
      }).catch(() => { if (active) setError(0); })
      .finally(() => { window.clearTimeout(timer); if (active) setLoading(false); });
    return () => { active = false; abort.abort(); window.clearTimeout(timer); };
  }, [reload]);
  const account = accounts.find((item) => item.id === selected);
  return <div className={styles.page}>
    <header><h1>{t("Welcome to CRIA PING")}</h1><p>{t("Your first campaign starts here.")}</p></header>
    <Link className={styles.link} href="/dashboard">{t("Back to dashboard")}</Link>
    {loading ? <Skeleton label={t("Loading campaign settings")} /> : error !== null ?
      <EmptyState title={t(error === 403 ? "Not permitted" : "Dashboard unavailable")}
        description={t("We could not load your real data. Nothing estimated was shown.")}
        action={error === 401 ? <Link className={styles.primaryLink} href="/login">{t("Back to sign in")}</Link> :
          <Button onClick={() => { setError(null); setLoading(true); setReload((value) => value + 1); }}>{t("Try again")}</Button>} /> :
      <Card><h2>{t("Instagram Connection")}</h2>
        {!accounts.length ? <EmptyState title={t("Not connected")} description={t("Connect an Instagram professional account to launch campaigns.")} /> : <>
          <AccountSelect newDesign includeAll={false} accounts={accounts} value={selected} onChange={setSelected} />
          {account && <dl className={styles.summary}>
            <dt>{t("Accounts")}</dt><dd className={styles.wrap}>{account.name || account.username} · @{account.username}</dd>
            <dt>{t("Instagram ID")}</dt><dd className={styles.wrap}>{account.instagramId}</dd>
            <dt>{t("Status")}</dt><dd><Badge>{t("Account saved in this workspace")}</Badge></dd>
            <dt>{t("Webhook")}</dt><dd>{t(account.webhookSubscribed ? "Webhook ready" : "Webhook pending")}</dd>
            {account.provider !== "ZERNIO" && <><dt>{t("Token expires")}</dt><dd>{account.tokenExpiresAt ? new Date(account.tokenExpiresAt).toLocaleDateString(locale) : t("not available")}</dd></>}
          </dl>}
          <p className={styles.muted}>{t("A saved account does not confirm that delivery is available.")}</p>
        </>}
      </Card>}
    <Card><h2>{t("Connect Instagram")}</h2>
      {!metaConfigured && <p role="status">{t("Instagram app not configured")} — {t("Ask the workspace administrator to finish Meta setup.")}</p>}
      <p>{t("Connect an Instagram professional account to launch campaigns.")}</p>
      <div className={styles.actions}>{metaConfigured && <a className={styles.primaryLink} href="/api/instagram/connect">{t("Connect Instagram")}</a>}
        <Link className={styles.link} href="/settings">{t("Settings")}</Link></div>
    </Card>
    <Card><h2>{t("Create Campaign")}</h2><p>{t("Message preview only. Nothing is sent.")}</p>
      {account && error === null && !loading ? <Link className={styles.primaryLink} href={`/campaigns/new?${new URLSearchParams({ instagramAccountId: account.id })}`}>{t("Create Campaign")}</Link> :
        <p className={styles.muted}>{t("Connect an Instagram professional account to launch campaigns.")}</p>}
    </Card>
  </div>;
}
