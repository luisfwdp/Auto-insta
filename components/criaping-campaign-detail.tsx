"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { useI18n } from "@/lib/i18n/provider";
import { Badge, Button, Card, EmptyState, Skeleton } from "./ui/primitives";
import styles from "./campaigns.module.css";

interface Campaign {
  id: string; name: string; isActive: boolean;
  instagramAccount: { username: string };
  matchAnyPost: boolean; pendingNextReel: boolean; postUrl: string | null;
  matchAnyWord: boolean; keywords: string[]; dmMessage: string;
  openingDmEnabled: boolean; openingDmMessage: string | null; openingDmButtonLabel: string | null;
  requireFollow: boolean; followPromptMessage: string | null; followPromptButtonLabel: string | null;
  followUpEnabled: boolean; followUpMessage: string | null;
  publicReplyEnabled: boolean; publicReplyMessage: string | null; publicReplyMessages: string[];
  linkButtonLabel: string | null;
  trackedLinks: { id: string; destinationUrl: string; label: string | null }[];
  analytics: { sent: number; clicks: number; ctr: number; failed: number; skipped: number };
}

export default function CriapingCampaignDetail() {
  const { id } = useParams<{ id: string }>();
  const { t, locale } = useI18n();
  const [campaign, setCampaign] = useState<Campaign | null>(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState(false);
  const [unauthorized, setUnauthorized] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    const abort = new AbortController();
    // Bound the loading state even when a server or external dependency stalls.
    const timeout = window.setTimeout(() => abort.abort(), 20000);
    let active = true;
    fetch("/api/automations", { cache: "no-store", signal: abort.signal })
      .then(async (response) => {
        if (active) setUnauthorized(response.status === 401);
        const payload = await response.json();
        if (!response.ok || !payload.success || !Array.isArray(payload.data)) throw Error();
        if (active) setCampaign(payload.data.find((item: Campaign) => item.id === id) ?? null);
      })
      .catch(() => { if (active) setFailure(true); })
      .finally(() => { window.clearTimeout(timeout); if (active) setLoading(false); });
    return () => { active = false; window.clearTimeout(timeout); abort.abort(); };
  }, [id, reload]);

  function retry() {
    setLoading(true); setFailure(false); setCampaign(null); setUnauthorized(false);
    setReload((value) => value + 1);
  }

  const back = <Link className={styles.link} href="/campaigns">{t("Back to campaigns")}</Link>;
  if (loading) return <Skeleton label={t("Loading campaign settings")} />;
  if (failure) return <div className={styles.page}><EmptyState title={t("Campaigns unavailable")}
    description={t("We could not load your campaigns. No estimated data is shown.")}
    action={<div className={styles.actions}>{unauthorized
      ? <Link className={styles.primaryLink} href="/login">{t("Back to sign in")}</Link>
      : <Button onClick={retry}>{t("Try again")}</Button>}{back}</div>} /></div>;
  if (!campaign) return <div className={styles.page}><EmptyState title={t("Campaign not found.")} action={back} /></div>;

  const messages = [
    ...(campaign.openingDmEnabled ? [[t("They will get an opening DM"), campaign.openingDmMessage, campaign.openingDmButtonLabel]] : []),
    ...(campaign.requireFollow ? [[t("They must follow first"), campaign.followPromptMessage, campaign.followPromptButtonLabel]] : []),
    [t("And then, they will get a DM"), campaign.dmMessage, campaign.linkButtonLabel],
    ...(campaign.followUpEnabled ? [[t("Then a follow-up message"), campaign.followUpMessage]] : []),
  ];
  const replies = campaign.publicReplyMessages?.length ? campaign.publicReplyMessages
    : campaign.publicReplyMessage ? [campaign.publicReplyMessage] : [];
  const metrics = [
    [t("Sends"), campaign.analytics.sent], [t("Clicks"), campaign.analytics.clicks],
    [t("CTR"), campaign.analytics.ctr], [t("Failed"), campaign.analytics.failed],
    [t("skipped"), campaign.analytics.skipped],
  ] as const;

  return <div className={styles.page}>
    <header className={styles.header}>
      <div><h1 className={styles.wrap}>{campaign.name}</h1><p className={styles.wrap}>@{campaign.instagramAccount.username}</p></div>
      <Badge tone={campaign.isActive ? "success" : "neutral"}>{t(campaign.isActive ? "Active" : "Paused")}</Badge>
      <div className={styles.actions}>{back}<Link className={styles.primaryLink} href={`/campaigns/${encodeURIComponent(campaign.id)}/edit`}>{t("Edit campaign")}</Link></div>
    </header>
    <Card><h2>{t("Insights")}</h2><dl className={styles.metrics}>{metrics.map(([name, value]) =>
      <div key={name}><dt>{name}</dt><dd>{Number.isFinite(value) ? value.toLocaleString(locale) + (name === t("CTR") ? "%" : "") : t("not available")}</dd></div>)}</dl></Card>
    <Card><h2>{t("Configuration")}</h2><dl className={styles.summary}>
      <dt>{t("When someone comments on")}</dt><dd>{t(campaign.matchAnyPost ? "Any post or reel" : campaign.pendingNextReel ? "Your next reel" : "A specific post or reel")}</dd>
      <dt>{t("Keywords")}</dt><dd>{campaign.matchAnyWord ? t("Any comment") : campaign.keywords.join(", ") || t("No keywords")}</dd>
    </dl>{campaign.postUrl && <a className={styles.link} href={campaign.postUrl} target="_blank" rel="noreferrer">{t("Open on Instagram")}</a>}</Card>
    <Card><h2>{t("Messages")}</h2><div className={styles.stack}>{messages.map(([name, message, button], index) =>
      <div key={index}><h3>{name}</h3><p className={styles.message}>{message || t("No text configured")}</p>{button && <p className={styles.wrap}>{button}</p>}</div>)}
      {campaign.publicReplyEnabled && <div><h3>{t("Public reply under the post")}</h3>{replies.length ? replies.map((message, index) => <p className={styles.message} key={index}>{message}</p>) : <p>{t("No text configured")}</p>}</div>}
    </div></Card>
    <Card><h2>{t("Tracked Links")}</h2>{campaign.trackedLinks.length ? <dl className={styles.summary}>{campaign.trackedLinks.map((link) =>
      <div key={link.id}><dt>{link.label || t("The exact link sent")}</dt><dd className={styles.wrap}>{link.destinationUrl}</dd></div>)}</dl> : <p>{t("not available")}</p>}</Card>
  </div>;
}

