"use client";

import Image from "next/image";
import { useEffect, useId, useRef, useState } from "react";
import { useI18n } from "@/lib/i18n/provider";
import styles from "./publishing.module.css";
import { publishingRequest } from "./use-publishing";

interface Props { onUploaded: () => Promise<void>; multiple?: boolean; videosOnly?: boolean }
export const MEDIA_FILE_ACCEPT = "image/jpeg,video/mp4,video/quicktime";
type UploadState = "waiting" | "uploading" | "verifying" | "ready" | "failed";
type Upload = { name: string; preview: string; image: boolean; state: UploadState; error?: string };

export function mediaSelectionError(files: Pick<File, "type">[], multiple = true, videosOnly = false) {
  if (files.length > (multiple ? 100 : 1)) return "LIMIT";
  const allowed = (videosOnly ? "video/mp4,video/quicktime" : MEDIA_FILE_ACCEPT).split(",");
  return files.some(file => !allowed.includes(file.type)) ? "TYPE" : null;
}

export default function MediaUploader({ onUploaded, multiple = true, videosOnly = false }: Props) {
  const { t } = useI18n();
  const input = useRef<HTMLInputElement>(null);
  const busy = useRef(false);
  const previews = useRef<string[]>([]);
  const hintId = useId();
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const accept = videosOnly ? "video/mp4,video/quicktime" : MEDIA_FILE_ACCEPT;
  const labels = { waiting: t("Waiting to upload"), uploading: t("Uploading..."), verifying: t("Verifying file"), ready: t("Ready"), failed: t("Upload failed") };
  const ready = uploads.filter(file => file.state === "ready").length;
  useEffect(() => () => { previews.current.forEach(url => URL.revokeObjectURL(url)); }, []);

  async function uploadFiles(files: FileList | null) {
    if (!files?.length || busy.current) return;
    setDragging(false); setMessage(null);
    const selected = Array.from(files);
    const selectionError = mediaSelectionError(selected, multiple, videosOnly);
    if (selectionError === "LIMIT") { setMessage(t("Choose up to {count} files at a time.", { count: multiple ? 100 : 1 })); return; }
    if (selectionError === "TYPE") { setMessage(t("Choose supported media files only.")); return; }
    busy.current = true; setUploading(true);
    previews.current.forEach(url => URL.revokeObjectURL(url));
    previews.current = selected.map(file => URL.createObjectURL(file));
    setUploads(selected.map((file, index) => ({ name: file.name, preview: previews.current[index], image: file.type === "image/jpeg", state: "waiting" })));
    const update = (index: number, state: UploadState, error?: string) => setUploads(values => values.map((value, i) => i === index ? { ...value, state, error } : value));
    let completed = 0;
    try {
      for (const [index, file] of selected.entries()) {
        try {
          update(index, "uploading");
          const prepared = await publishingRequest<{ asset: { id: string }; signedUpload: { uploadUrl: string; token: string } }>("/api/publishing/media", {
            method: "POST", body: JSON.stringify({ filename: file.name, mimeType: file.type, byteSize: file.size }),
          });
          const result = await fetch(prepared.signedUpload.uploadUrl, { method: "PUT", headers: { "Content-Type": file.type, "x-upsert": "false" }, body: file });
          if (!result.ok) throw new Error(t("Upload failed"));
          update(index, "verifying");
          await publishingRequest("/api/publishing/media", { method: "PATCH", body: JSON.stringify({ id: prepared.asset.id }) });
          update(index, "ready"); completed++;
        } catch (cause) { update(index, "failed", cause instanceof Error ? cause.message : t("Upload failed")); }
      }
      if (completed) await onUploaded();
    } catch { setMessage(t("Files uploaded. Refresh the library to see them.")); }
    finally { busy.current = false; setUploading(false); if (input.current) input.current.value = ""; }
  }

  return <div className={styles.uploader} aria-busy={uploading}>
    <input ref={input} aria-label={t("Upload media")} className={styles.visuallyHidden} tabIndex={-1} type="file" accept={accept} multiple={multiple} onChange={event => void uploadFiles(event.target.files)} />
    <div className={`${styles.dropzone} ${dragging ? styles.dropzoneActive : ""}`}
      onDragOver={event => { event.preventDefault(); if (!busy.current) setDragging(true); }}
      onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }}
      onDrop={event => { event.preventDefault(); setDragging(false); void uploadFiles(event.dataTransfer.files); }}>
      <span className={styles.uploadIcon} aria-hidden="true">↑</span>
      <strong>{t("Drop your media here")}</strong><p id={hintId} className={styles.muted}>{t(videosOnly ? "MP4 or MOV videos. Up to {count} files at a time." : "JPEG images, MP4 or MOV videos. Up to {count} files at a time.", { count: multiple ? 100 : 1 })}</p>
      <button type="button" className={`${styles.button} ${styles.primary}`} aria-describedby={hintId} disabled={uploading} onClick={() => input.current?.click()}>{uploading ? t("Uploading...") : t("Choose files")}</button>
    </div>
    {uploads.length > 0 && <><p className={styles.muted} role="status">{t("{ready} of {total} files ready", { ready, total: uploads.length })}</p>
      <progress className={styles.uploadProgress} value={ready} max={uploads.length} aria-label={t("Upload progress")} />
      <ul className={styles.uploadList}>{uploads.map((file, index) => <li className={styles.uploadItem} key={index}>
        {file.image ? <Image unoptimized src={file.preview} width={48} height={56} alt="" className={styles.uploadPreview} /> : <video src={file.preview} muted playsInline preload="metadata" aria-hidden="true" className={styles.uploadPreview} />}
        <span className={styles.uploadDetails}><strong>{file.name}</strong><span className={file.state === "failed" ? styles.danger : styles.muted}>{file.error || labels[file.state]}</span></span>
        <span className={file.state === "ready" ? styles.counter : styles.muted} aria-hidden="true">{file.state === "ready" ? "✓" : file.state === "failed" ? "!" : index + 1}</span>
      </li>)}</ul></>}
    {message && <p className={`${styles.notice} ${styles.error}`} role="alert">{message}</p>}
  </div>;
}
