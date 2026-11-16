import { describe, expect, it } from "vitest";
import { createBatchSchema, createAssetSchema, publicationInputSchema } from "@/lib/publishing/schemas";
import { generateBatchSchedule, orderBatchItems, zonedDateTimeToUtc } from "@/lib/publishing/schedule";
import { fillUniqueTimeSlots } from "@/components/publishing/speed-post-workspace";

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

  it("accepts the UI limit of 25 daily posts and a client preview seed", () => {
    const parsed = createBatchSchema.safeParse({
      name: "Daily launch",
      instagramAccountId: "ig",
      items: Array.from({ length: 25 }, (_, index) => ({ assetId: `a${index}` })),
      postsPerDay: 25,
      scheduleMode: "FIXED",
      orderMode: "RANDOM",
      randomSeed: "a68ee5d7-7922-4950-98fe-67882fe913f7",
      timezone: "UTC",
      timeSlots: fillUniqueTimeSlots([], 25),
      startsOn: "2030-01-01",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.randomSeed).toBe("a68ee5d7-7922-4950-98fe-67882fe913f7");
  });

  it("rejects duplicate daily times and generates 25 unique UI defaults", () => {
    const slots = fillUniqueTimeSlots(["10:00", "12:00", "15:00", "18:00", "21:00"], 25);
    expect(slots).toHaveLength(25);
    expect(new Set(slots).size).toBe(25);
    expect(createBatchSchema.safeParse({
      name: "Burst",
      instagramAccountId: "ig",
      items: [{ assetId: "a1" }, { assetId: "a2" }],
      postsPerDay: 2,
      scheduleMode: "FIXED",
      orderMode: "SEQUENTIAL",
      timezone: "UTC",
      timeSlots: ["10:00", "10:00"],
      startsOn: "2030-01-01",
    }).success).toBe(false);
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

  it("keeps the selected media order when growing from five to six daily posts", () => {
    const slots = fillUniqueTimeSlots(["10:00", "12:00", "15:00", "18:00", "21:00"], 6);
    const items = orderBatchItems(
      Array.from({ length: 100 }, (_, index) => ({ assetId: `selected-${100 - index}` })),
      "MANUAL", "unused", new Map()
    );
    const dates = generateBatchSchedule({
      startsOn: "2030-01-02", postsPerDay: 6, timeSlots: slots, timezone: "America/Sao_Paulo",
    }, items.length);
    const actualExecutionOrder = items.map((item, index) => ({ item, date: dates[index] }))
      .sort((left, right) => left.date.getTime() - right.date.getTime())
      .map(({ item }) => item.assetId);

    expect(actualExecutionOrder).toEqual(items.map(item => item.assetId));
    expect(slots).toEqual(["10:00", "12:00", "15:00", "15:15", "18:00", "21:00"]);
    expect(new Set(dates.map(date => date.toISOString())).size).toBe(100);
  });

  it("assigns edited daily times chronologically without mutating the submitted slots", () => {
    const slots = ["21:00", "00:15", "10:00"];
    const dates = generateBatchSchedule({
      startsOn: "2030-01-02", postsPerDay: 3, timeSlots: slots, timezone: "America/Sao_Paulo",
    }, 6);

    expect(dates.map(date => date.toISOString())).toEqual([
      "2030-01-02T03:15:00.000Z", "2030-01-02T13:00:00.000Z", "2030-01-03T00:00:00.000Z",
      "2030-01-03T03:15:00.000Z", "2030-01-03T13:00:00.000Z", "2030-01-04T00:00:00.000Z",
    ]);
    expect(slots).toEqual(["21:00", "00:15", "10:00"]);
  });

  it("uses a stable random order for retry-safe previews", () => {
    const items = Array.from({ length: 10 }, (_, index) => ({ assetId: `a${index}`, caption: null }));
    const first = orderBatchItems(items, "RANDOM", "seed", new Map());
    const second = orderBatchItems(items, "RANDOM", "seed", new Map());
    expect(first).toEqual(second);
    expect(first).not.toEqual(items);
  });
});
