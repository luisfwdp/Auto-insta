export type PublishingStatus = "DRAFT" | "SCHEDULED" | "QUEUED" | "PROCESSING" | "PUBLISHED" | "FAILED" | "CANCELLED";

export interface MediaAsset {
  id: string;
  filename: string;
  mediaType: "IMAGE" | "VIDEO";
  status?: "UPLOADING" | "READY" | "FAILED" | "DELETED";
  createdAt: string;
}

export interface ScheduledPublication {
  id: string;
  caption?: string | null;
  type: "IMAGE_POST" | "REEL" | "CAROUSEL";
  scheduledFor?: string | null;
  publishedAt?: string | null;
  status: PublishingStatus;
  instagramAccount?: { id: string; username: string };
  assets?: Array<{ asset: MediaAsset }>;
  lastError?: string | null;
}

export interface PublishingBatch {
  id: string;
  name: string;
  status: "DRAFT" | "SCHEDULED" | "RUNNING" | "PAUSED" | "COMPLETED" | "CANCELLED" | "FAILED";
  totalItems: number;
  publishedItems: number;
  failedItems: number;
  createdAt: string;
}

export interface InstagramAccountOption {
  id: string;
  username: string;
  instagramId: string;
  name?: string | null;
}
