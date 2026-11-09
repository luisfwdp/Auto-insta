"use client";

import { useRef, useState } from "react";
import { useI18n } from "@/lib/i18n/provider";
import styles from "./publishing.module.css";
import { publishingRequest } from "./use-publishing";

interface Props { onUploaded: () => Promise<void>; multiple?: boolean }

export default function MediaUploader({ onUploaded, multiple = true }: Props) {
  const { t } = useI18n();
  const input = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function uploadFiles(files: FileList | null) {
    if (!files?.length) return;
    setUploading(true); setMessage(null);
    try {
      for (const file of Array.from(files)) {
        const prepared = await publishingRequest<{ asset: { id: string }; signedUpload: { uploadUrl: string; token: string } }>("/api/publishing/media", {
          method: "POST",
          body: JSON.stringify({ filename: file.name, mimeType: file.type, byteSize: file.size }),
        });
        const result = await fetch(prepared.signedUpload.uploadUrl, { method: "PUT", headers: { "Content-Type": file.type, "x-upsert": "false" }, body: file });
        if (!result.ok) throw new Error(`${t("Upload failed")}: ${file.name}`);
        await publishingRequest("/api/publishing/media", { method: "PATCH", body: JSON.stringify({ id: prepared.asset.id }) });
      }
      setMessage(t("Media uploaded securely."));
      await onUploaded();
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : t("Upload failed")); }
    finally { setUploading(false); if (input.current) input.current.value = ""; }
  }

  return <div className={styles.row}>
    <input ref={input} className={styles.visuallyHidden} type="file" accept="image/jpeg,image/png,image/webp,video/mp4,video/quicktime" multiple={multiple} onChange={event => void uploadFiles(event.target.files)} />
    <button className={styles.button} disabled={uploading} onClick={() => input.current?.click()}>{uploading ? t("Uploading...") : t("Upload media")}</button>
    {message && <span className={styles.muted} role="status">{message}</span>}
  </div>;
}
