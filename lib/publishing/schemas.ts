import { z } from "zod";

const caption = z.string().trim().max(2_200).optional().nullable();
const timezone = z.string().trim().min(1).max(100).refine((value) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}, "Invalid IANA timezone");

export const ALLOWED_MEDIA = {
  "image/jpeg": { mediaType: "IMAGE", maxBytes: 8 * 1024 * 1024 },
  "video/mp4": { mediaType: "VIDEO", maxBytes: 300 * 1024 * 1024 },
  "video/quicktime": { mediaType: "VIDEO", maxBytes: 300 * 1024 * 1024 },
} as const;

export const createAssetSchema = z.object({
  filename: z.string().trim().min(1).max(255),
  mimeType: z.enum(Object.keys(ALLOWED_MEDIA) as [keyof typeof ALLOWED_MEDIA, ...(keyof typeof ALLOWED_MEDIA)[]]),
  byteSize: z.number().int().positive(),
  checksum: z.string().regex(/^[a-fA-F0-9]{64}$/).optional(),
}).superRefine((value, ctx) => {
  if (value.byteSize > ALLOWED_MEDIA[value.mimeType].maxBytes) {
    ctx.addIssue({ code: "custom", path: ["byteSize"], message: "File exceeds the allowed size" });
  }
});

export const confirmAssetSchema = z.object({
  id: z.string().min(1),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  durationMs: z.number().int().positive().optional(),
});

const publicationFields = z.object({
  instagramAccountId: z.string().min(1),
  type: z.enum(["IMAGE_POST", "CAROUSEL", "REEL"]),
  reelMode: z.enum(["STANDARD", "TRIAL"]).default("STANDARD"),
  caption,
  assetIds: z.array(z.string().min(1)).min(1).max(10),
  scheduledFor: z.string().datetime({ offset: true }).optional().nullable(),
  publishNow: z.boolean().default(false),
  timezone,
});

function validatePublicationShape(value: Partial<z.infer<typeof publicationFields>>, ctx: z.RefinementCtx) {
  if (value.assetIds && new Set(value.assetIds).size !== value.assetIds.length) {
    ctx.addIssue({ code: "custom", path: ["assetIds"], message: "Duplicate media is not allowed" });
  }
  if (value.type === "CAROUSEL" && value.assetIds && value.assetIds.length < 2) {
    ctx.addIssue({ code: "custom", path: ["assetIds"], message: "A carousel needs at least two media items" });
  }
  if (value.type && value.type !== "CAROUSEL" && value.assetIds && value.assetIds.length !== 1) {
    ctx.addIssue({ code: "custom", path: ["assetIds"], message: "This publication type accepts one media item" });
  }
  if (value.type !== "REEL" && value.reelMode === "TRIAL") {
    ctx.addIssue({ code: "custom", path: ["reelMode"], message: "Trial mode is only available for Reels" });
  }
}

export const publicationInputSchema = publicationFields.superRefine(validatePublicationShape);

export const updatePublicationSchema = publicationFields.partial().extend({
  action: z.enum(["schedule", "publish", "cancel", "reschedule"]).optional(),
}).superRefine(validatePublicationShape);

const timeSlot = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

export const createBatchSchema = z.object({
  name: z.string().trim().min(1).max(100),
  instagramAccountId: z.string().min(1),
  items: z.array(z.object({
    assetId: z.string().min(1),
    caption,
    scheduledFor: z.string().datetime({ offset: true }).optional(),
  })).min(1).max(100),
  postsPerDay: z.number().int().min(1).max(25),
  scheduleMode: z.enum(["FIXED", "CUSTOM"]),
  orderMode: z.enum(["MANUAL", "SEQUENTIAL", "RANDOM"]),
  timezone,
  timeSlots: z.array(timeSlot).max(25),
  startsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  defaultCaption: caption,
  reelMode: z.enum(["STANDARD", "TRIAL"]).default("STANDARD"),
}).superRefine((value, ctx) => {
  if (value.scheduleMode === "FIXED" && value.timeSlots.length < value.postsPerDay) {
    ctx.addIssue({ code: "custom", path: ["timeSlots"], message: "Provide at least one time slot per daily post" });
  }
  if (value.scheduleMode === "CUSTOM" && value.items.some((item) => !item.scheduledFor)) {
    ctx.addIssue({ code: "custom", path: ["items"], message: "Every custom item needs its own scheduled date" });
  }
  if (new Set(value.items.map((item) => item.assetId)).size !== value.items.length) {
    ctx.addIssue({ code: "custom", path: ["items"], message: "Duplicate media is not allowed in a batch" });
  }
});

export const batchActionSchema = z.object({ action: z.enum(["pause", "resume", "cancel"]) });

export type CreateBatchInput = z.infer<typeof createBatchSchema>;
