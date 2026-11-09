"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useI18n } from "@/lib/i18n/provider";
import styles from "./publishing.module.css";
import { publishingRequest, usePublishingData } from "./use-publishing";
import type { ScheduledPublication } from "./types";
import MediaUploader from "./media-uploader";

function monthDays(date: Date) {
  const first = new Date(date.getFullYear(), date.getMonth(), 1);
  const count = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  return [...Array(first.getDay()).fill(null), ...Array.from({ length: count }, (_, index) => index + 1)];
}

export default function ProgrammingWorkspace() {
  const { t, locale } = useI18n();
  const data = usePublishingData();
  const [accountId, setAccountId] = useState("");
  const [selectedMedia, setSelectedMedia] = useState<string[]>([]);
  const [mediaType, setMediaType] = useState<"POST" | "REEL" | "CAROUSEL">("REEL");
  const [caption, setCaption] = useState("");
  const [scheduledAt, setScheduledAt] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const now = useMemo(() => new Date(), []);
  const days = useMemo(() => monthDays(now), [now]);
  const effectiveAccount = accountId || data.accounts[0]?.id || "";

  async function createPublication(publishNow: boolean) {
    if (!effectiveAccount || selectedMedia.length === 0) return;
    setSubmitting(true); setFeedback(null);
    try {
      await publishingRequest<ScheduledPublication>("/api/publishing/publications", {
        method: "POST",
        body: JSON.stringify({ instagramAccountId: effectiveAccount, assetIds: selectedMedia, type: mediaType === "POST" ? "IMAGE_POST" : mediaType, reelMode: "STANDARD", caption, publishNow, scheduledFor: publishNow ? undefined : new Date(scheduledAt).toISOString(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }),
      });
      setFeedback(publishNow ? t("Publication queued successfully.") : t("Publication scheduled successfully."));
      setCaption(""); setSelectedMedia([]); setScheduledAt("");
      await data.refresh();
    } catch (cause) { setFeedback(cause instanceof Error ? cause.message : t("The request could not be completed.")); }
    finally { setSubmitting(false); }
  }

  async function updatePublication(id: string, action: "cancel" | "publish") {
    setFeedback(null);
    try {
      await publishingRequest(`/api/publishing/publications?id=${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ action }) });
      await data.refresh();
    } catch (cause) { setFeedback(cause instanceof Error ? cause.message : t("The request could not be completed.")); }
  }

  return <div className={styles.page}>
    <header className={styles.header}>
      <div><p className={styles.eyebrow}>{t("Instagram publishing")}</p><h1 className={styles.title}>{t("Scheduling")}</h1><p className={styles.subtitle}>{t("Create, schedule and follow every post from one calendar.")}</p></div>
      <nav className={styles.tabs} aria-label={t("Publishing sections")}><Link className={`${styles.tab} ${styles.tabActive}`} href="/scheduling">{t("Scheduling")}</Link><Link className={styles.tab} href="/speed-post">{t("Speed Post")}</Link></nav>
    </header>
    {data.error && <p className={`${styles.notice} ${styles.error}`} role="alert">{t("Publishing data could not be loaded.")} {data.error}</p>}
    {feedback && <p className={styles.notice} role="status">{feedback}</p>}
    <div className={styles.grid}>
      <section className={styles.panel} aria-labelledby="new-publication"><h2 id="new-publication">{t("New publication")}</h2><div className={styles.fields}>
        <label className={styles.field}>{t("Instagram account")}<select className={styles.control} value={effectiveAccount} onChange={e => setAccountId(e.target.value)}><option value="">{t("Select an account")}</option>{data.accounts.map(a => <option key={a.id} value={a.id}>@{a.username}</option>)}</select></label>
        <label className={styles.field}>{t("Format")}<select className={styles.control} value={mediaType} onChange={e => setMediaType(e.target.value as typeof mediaType)}><option value="POST">{t("Post")}</option><option value="REEL">Reel</option><option value="CAROUSEL">{t("Carousel")}</option></select></label>
        <label className={styles.field}>{t("Caption")}<textarea className={styles.control} maxLength={2200} value={caption} onChange={e => setCaption(e.target.value)} placeholder={t("Write the caption and hashtags...")} /></label>
        <label className={styles.field}>{t("Date and time")}<input className={styles.control} type="datetime-local" value={scheduledAt} min={new Date().toISOString().slice(0,16)} onChange={e => setScheduledAt(e.target.value)} /></label>
        <div className={styles.row}><button className={`${styles.button} ${styles.primary}`} disabled={submitting || !scheduledAt || !effectiveAccount || selectedMedia.length === 0} onClick={() => void createPublication(false)}>{t("Schedule")}</button><button className={styles.button} disabled={submitting || !effectiveAccount || selectedMedia.length === 0} onClick={() => void createPublication(true)}>{t("Publish now")}</button></div>
      </div></section>
      <div className={styles.fields}>
        <section className={styles.panel}><h2>{t("Private media library")} · <span className={styles.counter}>{selectedMedia.length}</span></h2><MediaUploader onUploaded={data.refresh} />{data.loading ? <p className={styles.muted}>{t("Loading...")}</p> : data.media.length === 0 ? <p className={styles.notice}>{t("No media uploaded yet. Use the secure uploader to add photos or videos.")}</p> : <div className={styles.mediaGrid}>{data.media.map(asset => { const selected = selectedMedia.includes(asset.id); return <button type="button" key={asset.id} aria-pressed={selected} className={`${styles.media} ${selected ? styles.mediaSelected : ""}`} onClick={() => setSelectedMedia(items => selected ? items.filter(id => id !== asset.id) : mediaType === "CAROUSEL" ? [...items, asset.id].slice(0,10) : [asset.id])}><span className={styles.thumb}>{asset.mediaType === "VIDEO" ? "▶" : "▧"}</span><span className={styles.mediaName}>{asset.filename}</span></button>; })}</div>}</section>
        <section className={styles.panel}><h2>{new Intl.DateTimeFormat(locale, { month: "long", year: "numeric" }).format(now)}</h2><div className={styles.calendarWrap}><div className={styles.calendar}>{days.map((day,index) => <div className={styles.day} key={index}>{day && <><span className={styles.dayNumber}>{day}</span>{data.publications.filter(item => item.scheduledFor && new Date(item.scheduledFor).getDate() === day && new Date(item.scheduledFor).getMonth() === now.getMonth()).map(item => <div className={styles.event} key={item.id}>{new Date(item.scheduledFor!).toLocaleTimeString(locale,{hour:"2-digit",minute:"2-digit"})} · {item.type}<br/><span className={styles.status}>{item.status}</span></div>)}</>}</div>)}</div></div></section>
      </div>
    </div>
    <section className={styles.panel}><h2>{t("History and status")}</h2><div className={styles.list}>{data.publications.length === 0 ? <p className={styles.muted}>{t("No publications yet.")}</p> : data.publications.map(item => <article className={styles.listItem} key={item.id}><div><strong>{item.type}</strong> <span className={styles.status}>{item.status}</span><p className={styles.muted}>{item.scheduledFor ? new Date(item.scheduledFor).toLocaleString(locale) : t("Publish immediately")}{item.lastError ? ` · ${item.lastError}` : ""}</p></div><div className={styles.row}>{item.status === "DRAFT" && <button className={styles.button} onClick={() => void updatePublication(item.id,"publish")}>{t("Publish now")}</button>}{["DRAFT","SCHEDULED","FAILED"].includes(item.status) && <button className={`${styles.button} ${styles.danger}`} onClick={() => void updatePublication(item.id,"cancel")}>{t("Cancel")}</button>}</div></article>)}</div></section>
  </div>;
}
