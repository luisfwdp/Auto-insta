import { describe, expect, it } from "vitest";
import { createBatchSchema, createAssetSchema, publicationInputSchema } from "@/lib/publishing/schemas";
import { generateBatchSchedule, orderBatchItems, zonedDateTimeToUtc } from "@/lib/publishing/schedule";

describe("publishing validation", () => {
  it("rejects oversized or unsupported uploads", () => {
    expect(createAssetSchema.safeParse({ filename: "payload.exe", mimeType: "application/octet-stream", byteSize: 100 }).success).toBe(false);
    expect(createAssetSchema.safeParse({ filename: "large.jpg", mimeType: "image/jpeg", byteSize: 9 * 1024 * 1024 }).success).toBe(false);
  });

  it("requires carousel cardinality and video-only trial reels", () => {
    const base = { instagramAccountId: "ig", caption: "hello", assetIds: ["asset"], timezone: "America/Sao_Paulo" };
    expect(publicationInputSchema.safeParse({ ...base, type: "CAROUSEL" }).success).toBe(false);
    expect(publicationInputSchema.safeParse({ ...base, type: "IMAGE_POST", reelMode: "TRIAL" }).success).toBe(false);
  });

  it("caps Speed Post batches at 100 unique items", () => {
    const base = { name: "Batch", instagramAccountId: "ig", postsPerDay: 1, scheduleMode: "FIXED", orderMode: "MANUAL", timezone: "UTC", timeSlots: ["10:00"], startsOn: "2030-01-01" };
    const duplicated = Array.from({ length: 2 }, () => ({ assetId: "same" }));
    expect(createBatchSchema.safeParse({ ...base, items: duplicated }).success).toBe(false);
    expect(createBatchSchema.safeParse({ ...base, items: Array.from({ length: 101 }, (_, index) => ({ assetId: `a${index}` })) }).success).toBe(false);
  });

  it("requires an explicit date for every custom item", () => {
    const parsed = createBatchSchema.safeParse({
      name: "Custom", instagramAccountId: "ig", postsPerDay: 1,
      scheduleMode: "CUSTOM", orderMode: "MANUAL", timezone: "UTC",
      timeSlots: [], startsOn: "2030-01-01", items: [{ assetId: "a1" }],
    });
    expect(parsed.success).toBe(false);
  });
});

describe("Speed Post schedule generation", () => {
  it("converts account local time to UTC", () => {
    expect(zonedDateTimeToUtc("2030-01-02", "10:00", "America/Sao_Paulo").toISOString()).toBe("2030-01-02T13:00:00.000Z");
  });

  it("expands 100 reels at five per day into exactly 20 local days", () => {
    const dates = generateBatchSchedule({
      startsOn: "2030-01-02",
      postsPerDay: 5,
      timeSlots: ["10:00", "12:00", "15:00", "18:00", "21:00"],
      timezone: "America/Sao_Paulo",
    }, 100);
    expect(dates).toHaveLength(100);
    expect(dates[0].toISOString()).toBe("2030-01-02T13:00:00.000Z");
    expect(dates[99].toISOString()).toBe("2030-01-22T00:00:00.000Z");
  });

  it("uses a stable random order for retry-safe previews", () => {
    const items = Array.from({ length: 10 }, (_, index) => ({ assetId: `a${index}`, caption: null }));
    const first = orderBatchItems(items, "RANDOM", "seed", new Map());
    const second = orderBatchItems(items, "RANDOM", "seed", new Map());
    expect(first).toEqual(second);
    expect(first).not.toEqual(items);
  });
});
