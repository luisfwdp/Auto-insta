"use client";

import { useCallback, useEffect, useState } from "react";
import type { InstagramAccountOption, MediaAsset, PublishingBatch, ScheduledPublication } from "./types";

async function readJson<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => null) as { success?: boolean; data?: T; error?: string } | null;
  if (!response.ok || !payload?.success) throw new Error(payload?.error ?? "Request failed");
  return payload.data as T;
}

export async function publishingRequest<T>(url: string, init?: RequestInit) {
  return readJson<T>(await fetch(url, { cache: "no-store", ...init, headers: { "Content-Type": "application/json", ...init?.headers } }));
}

export function usePublishingData() {
  const [accounts, setAccounts] = useState<InstagramAccountOption[]>([]);
  const [media, setMedia] = useState<MediaAsset[]>([]);
  const [publications, setPublications] = useState<ScheduledPublication[]>([]);
  const [batches, setBatches] = useState<PublishingBatch[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [accountData, mediaData, publicationData, batchData] = await Promise.all([
        publishingRequest<{ instagramAccounts: InstagramAccountOption[] }>("/api/instagram/accounts"),
        publishingRequest<MediaAsset[]>("/api/publishing/media?status=READY"),
        publishingRequest<ScheduledPublication[]>("/api/publishing/publications"),
        publishingRequest<PublishingBatch[]>("/api/publishing/batches"),
      ]);
      setAccounts(accountData.instagramAccounts);
      setMedia(mediaData);
      setPublications(publicationData);
      setBatches(batchData);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Request failed");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => { void refresh(); }, 0);
    return () => window.clearTimeout(timer);
  }, [refresh]);
  return { accounts, media, publications, batches, loading, error, refresh };
}
