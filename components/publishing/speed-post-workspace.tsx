"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useI18n } from "@/lib/i18n/provider";
import styles from "./publishing.module.css";
import { publishingRequest, usePublishingData } from "./use-publishing";
import type { PublishingBatch } from "./types";
import MediaUploader from "./media-uploader";
import { orderBatchItems } from "@/lib/publishing/schedule";

const DEFAULT_SLOTS = ["10:00", "12:00", "15:00", "18:00", "21:00"];

export default function SpeedPostWorkspace() {
  const { t, locale } = useI18n();
  const data = usePublishingData();
  const [name, setName] = useState("");
  const [accountId, setAccountId] = useState("");
  const [mediaIds, setMediaIds] = useState<string[]>([]);
  const [postsPerDay, setPostsPerDay] = useState(5);
  const [slots, setSlots] = useState(DEFAULT_SLOTS);
  const [scheduleMode, setScheduleMode] = useState<"FIXED" | "CUSTOM">("FIXED");
  const [customDates, setCustomDates] = useState<Record<string, string>>({});
  const [order, setOrder] = useState<"SEQUENTIAL" | "MANUAL" | "RANDOM">("SEQUENTIAL");
  const [randomSeed, setRandomSeed] = useState("");
  const [caption, setCaption] = useState("");
  const [itemCaptions, setItemCaptions] = useState<Record<string, string>>({});
  const [trialReels, setTrialReels] = useState(false);
  const [startDate, setStartDate] = useState(() => new Date(Date.now() + 86_400_000).toISOString().slice(0,10));
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const effectiveAccount = accountId || data.accounts[0]?.id || "";
  const orderedMediaIds = useMemo(() => {
    const filenames = new Map(data.media.map(asset => [asset.id, asset.filename]));
    return orderBatchItems(
      mediaIds.map(assetId => ({ assetId })),
      order,
      randomSeed || "pending-random-seed",
      filenames
    ).map(item => item.assetId);
  }, [data.media, mediaIds, order, randomSeed]);
  const schedule = useMemo(() => orderedMediaIds.map((id,index) => {
    if (scheduleMode === "CUSTOM" && customDates[id]) return { id, date: new Date(customDates[id]) };
    const dayOffset = Math.floor(index / Math.max(1,postsPerDay));
    const date = new Date(`${startDate}T${slots[index % Math.max(1,postsPerDay)] || "10:00"}:00`);
    date.setDate(date.getDate() + dayOffset);
    return { id, date };
  }), [orderedMediaIds, postsPerDay, slots, startDate, scheduleMode, customDates]);

  function moveMedia(index: number, delta: number) {
    setMediaIds(ids => { const next = [...ids]; const target = index + delta; if (target < 0 || target >= next.length) return ids; [next[index],next[target]] = [next[target],next[index]]; return next; });
  }

  function changePostsPerDay(value: number) {
    const count = Math.min(25, Math.max(1,value));
    setPostsPerDay(count);
    setSlots(current => Array.from({ length: count }, (_,i) => current[i] ?? `${String(Math.min(23,10+i*2)).padStart(2,"0")}:00`));
  }

  async function createBatch() {
    if (!effectiveAccount || mediaIds.length === 0) return;
    setSubmitting(true); setFeedback(null);
    try {
      await publishingRequest<PublishingBatch>("/api/publishing/batches", { method: "POST", body: JSON.stringify({ name: name || t("Speed Post batch"), instagramAccountId: effectiveAccount, items: mediaIds.map(assetId => ({ assetId, caption: itemCaptions[assetId] || undefined, scheduledFor: scheduleMode === "CUSTOM" ? new Date(customDates[assetId]).toISOString() : undefined })), postsPerDay, scheduleMode, timeSlots: scheduleMode === "FIXED" ? slots : [], orderMode: order, randomSeed: order === "RANDOM" ? randomSeed : undefined, defaultCaption: caption, reelMode: trialReels ? "TRIAL" : "STANDARD", startsOn: startDate, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }) });
      setFeedback(t("Batch created and scheduled successfully.")); setMediaIds([]); setName("");
      await data.refresh();
    } catch (cause) { setFeedback(cause instanceof Error ? cause.message : t("The request could not be completed.")); }
    finally { setSubmitting(false); }
  }

  async function batchAction(id: string, action: "pause" | "resume" | "cancel") {
    setFeedback(null);
    try { await publishingRequest(`/api/publishing/batches/${id}`, { method: "PATCH", body: JSON.stringify({ action }) }); await data.refresh(); }
    catch (cause) { setFeedback(cause instanceof Error ? cause.message : t("The request could not be completed.")); }
  }

  return <div className={styles.page}>
    <header className={styles.header}><div><p className={styles.eyebrow}>{t("Bulk Instagram publishing")}</p><h1 className={styles.title}>{t("Speed Post")}</h1><p className={styles.subtitle}>{t("Select up to 100 media files and turn them into an automatic publishing calendar.")}</p></div><nav className={styles.tabs} aria-label={t("Publishing sections")}><Link className={styles.tab} href="/scheduling">{t("Scheduling")}</Link><Link className={`${styles.tab} ${styles.tabActive}`} href="/speed-post">{t("Speed Post")}</Link></nav></header>
    {data.error && <p className={`${styles.notice} ${styles.error}`} role="alert">{t("Publishing data could not be loaded.")} {data.error}</p>}{feedback && <p className={styles.notice} role="status">{feedback}</p>}
    <div className={styles.grid}>
      <section className={styles.panel}><h2>{t("Batch settings")}</h2><div className={styles.fields}>
        <label className={styles.field}>{t("Batch name")}<input className={styles.control} value={name} onChange={e => setName(e.target.value)} maxLength={100} /></label>
        <label className={styles.field}>{t("Instagram account")}<select className={styles.control} value={effectiveAccount} onChange={e => setAccountId(e.target.value)}><option value="">{t("Select an account")}</option>{data.accounts.map(a => <option key={a.id} value={a.id}>@{a.username}</option>)}</select></label>
        <label className={styles.field}>{t("Start date")}<input className={styles.control} type="date" min={new Date().toISOString().slice(0,10)} value={startDate} onChange={e => setStartDate(e.target.value)} /></label>
        <label className={styles.field}>{t("Posts per day")}<input className={styles.control} type="number" min={1} max={25} value={postsPerDay} onChange={e => changePostsPerDay(Number(e.target.value))} /></label>
        <label className={styles.field}>{t("Schedule mode")}<select className={styles.control} value={scheduleMode} onChange={e => setScheduleMode(e.target.value as typeof scheduleMode)}><option value="FIXED">{t("Fixed daily times")}</option><option value="CUSTOM">{t("Custom date per item")}</option></select></label>
        {scheduleMode === "FIXED" && <fieldset className={styles.field}><legend>{t("Publishing times")}</legend><div className={styles.slots}>{slots.map((slot,index) => <input key={index} aria-label={`${t("Time")} ${index+1}`} className={styles.control} type="time" value={slot} onChange={e => setSlots(values => values.map((value,i) => i === index ? e.target.value : value))} />)}</div></fieldset>}
        <label className={styles.field}>{t("Order")}<select className={styles.control} value={order} onChange={e => { const next = e.target.value as typeof order; if (next === "RANDOM" && order !== "RANDOM") setRandomSeed(crypto.randomUUID()); setOrder(next); }}><option value="SEQUENTIAL">{t("Sequential")}</option><option value="MANUAL">{t("Manual")}</option><option value="RANDOM">{t("Random")}</option></select></label>
        <label className={styles.field}>{t("Default caption")}<textarea className={styles.control} maxLength={2200} value={caption} onChange={e => setCaption(e.target.value)} placeholder={t("Applied to every Reel unless an individual caption is set.")} /></label>
        {mediaIds.length > 0 && <details><summary className={styles.button}>{t("Individual settings")}</summary><div className={styles.fields}>{mediaIds.map((id,index) => <div className={styles.notice} key={id}><div className={styles.row}><strong>Reel {index+1}</strong>{order === "MANUAL" && <><button className={styles.button} onClick={() => moveMedia(index,-1)} disabled={index === 0} aria-label={t("Move earlier")}>↑</button><button className={styles.button} onClick={() => moveMedia(index,1)} disabled={index === mediaIds.length-1} aria-label={t("Move later")}>↓</button></>}</div>{scheduleMode === "CUSTOM" && <label className={styles.field}>{t("Custom date and time")}<input className={styles.control} type="datetime-local" value={customDates[id] ?? ""} onChange={e => setCustomDates(values => ({...values,[id]:e.target.value}))} /></label>}<label className={styles.field}>{t("Individual caption")}<textarea className={styles.control} maxLength={2200} value={itemCaptions[id] ?? ""} onChange={e => setItemCaptions(values => ({...values,[id]:e.target.value}))} placeholder={t("Use the default caption")} /></label></div>)}</div></details>}
        <label className={styles.row}><input type="checkbox" checked={trialReels} onChange={e => setTrialReels(e.target.checked)} /> <span>{t("Use Trial Reels when the account is eligible")}</span></label>
        {trialReels && <p className={styles.notice}>{t("Eligibility is checked by Meta at publishing time. Unsupported accounts will not be treated as Trial Reels.")}</p>}
        <button className={`${styles.button} ${styles.primary}`} disabled={submitting || !effectiveAccount || mediaIds.length === 0 || (scheduleMode === "CUSTOM" && mediaIds.some(id => !customDates[id]))} onClick={() => void createBatch()}>{t("Create automatic calendar")}</button>
      </div></section>
      <div className={styles.fields}>
        <section className={styles.panel}><h2>{t("Select media")} · <span className={styles.counter}>{mediaIds.length}/100</span></h2><MediaUploader onUploaded={data.refresh} />{data.loading ? <p className={styles.muted}>{t("Loading...")}</p> : data.media.filter(asset => asset.mediaType === "VIDEO").length === 0 ? <p className={styles.notice}>{t("No media uploaded yet. Use the secure uploader to add photos or videos.")}</p> : <div className={styles.mediaGrid}>{data.media.filter(asset => asset.mediaType === "VIDEO").map(asset => { const selected = mediaIds.includes(asset.id); return <button type="button" key={asset.id} aria-pressed={selected} className={`${styles.media} ${selected ? styles.mediaSelected : ""}`} onClick={() => setMediaIds(ids => selected ? ids.filter(id => id !== asset.id) : ids.length < 100 ? [...ids,asset.id] : ids)}><span className={styles.thumb}>▶</span><span className={styles.mediaName}>{asset.filename}</span></button>; })}</div>}</section>
        <section className={styles.panel}><h2>{t("Generated calendar")} · {schedule.length ? Math.ceil(schedule.length / postsPerDay) : 0} {t("days")}</h2>{schedule.length === 0 ? <p className={styles.muted}>{t("Select media to preview the schedule.")}</p> : <div className={styles.list}>{schedule.slice(0,20).map((item,index) => <div className={styles.listItem} key={`${item.id}-${index}`}><span><strong>Reel {index+1}</strong><br/><span className={styles.muted}>{item.date.toLocaleString(locale,{dateStyle:"short",timeStyle:"short"})}</span></span><span className={styles.status}>{trialReels ? "Trial Reel" : "Reel"}</span></div>)}{schedule.length > 20 && <p className={styles.muted}>+ {schedule.length - 20} {t("scheduled items")}</p>}</div>}</section>
      </div>
    </div>
    <section className={styles.panel}><h2>{t("Batches, progress and errors")}</h2><div className={styles.list}>{data.batches.length === 0 ? <p className={styles.muted}>{t("No Speed Post batches yet.")}</p> : data.batches.map(batch => { const done = batch.publishedItems + batch.failedItems; const percent = batch.totalItems ? Math.round(done / batch.totalItems * 100) : 0; return <article className={styles.listItem} key={batch.id}><div><strong>{batch.name}</strong> <span className={styles.status}>{batch.status}</span><p className={styles.muted}>{batch.publishedItems}/{batch.totalItems} {t("published")} · {batch.failedItems} {t("errors")}</p><div className={styles.progress} aria-label={`${percent}%`}><span style={{width:`${percent}%`}} /></div></div><div className={styles.row}>{["SCHEDULED","RUNNING"].includes(batch.status) && <button className={styles.button} onClick={() => void batchAction(batch.id,"pause")}>{t("Pause")}</button>}{["PAUSED","FAILED"].includes(batch.status) && <button className={`${styles.button} ${styles.primary}`} onClick={() => void batchAction(batch.id,"resume")}>{t("Resume")}</button>}{!["COMPLETED","CANCELLED"].includes(batch.status) && <button className={`${styles.button} ${styles.danger}`} onClick={() => void batchAction(batch.id,"cancel")}>{t("Cancel")}</button>}</div></article>; })}</div></section>
  </div>;
}
