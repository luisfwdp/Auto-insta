import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  webhookDelete: vi.fn(), operationalDelete: vi.fn(), operationalCreate: vi.fn(), dmUpdate: vi.fn(),
}));
vi.mock("@/lib/db/client", () => ({ prisma: {
  webhookEvent: { deleteMany: mocks.webhookDelete },
  operationalEvent: { deleteMany: mocks.operationalDelete, create: mocks.operationalCreate },
  dmLog: { updateMany: mocks.dmUpdate },
} }));

import { applyRetention, retentionDays, RETENTION_ERASED_TEXT } from "@/lib/privacy/retention";

const now = new Date("2030-06-30T00:00:00Z");
const env = (values: Record<string, string>) => values as unknown as NodeJS.ProcessEnv;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.webhookDelete.mockResolvedValue({ count: 5 });
  mocks.operationalDelete.mockResolvedValue({ count: 2 });
  mocks.dmUpdate.mockResolvedValue({ count: 3 });
  mocks.operationalCreate.mockResolvedValue({});
});

describe("opt-in data retention", () => {
  it("is disabled for unset, invalid or too-short values", () => {
    for (const value of [undefined, "", "abc", "0", "-30", "6", "30.5"]) {
      expect(retentionDays(value)).toBeNull();
    }
    expect(retentionDays("7")).toBe(7);
    expect(retentionDays("90")).toBe(90);
  });

  it("touches nothing when no retention variable is configured", async () => {
    await expect(applyRetention(now, env({}))).resolves.toBeNull();
    await expect(applyRetention(now, env({ RETENTION_WEBHOOK_EVENTS_DAYS: "1" }))).resolves.toBeNull();
    expect(mocks.webhookDelete).not.toHaveBeenCalled();
    expect(mocks.operationalDelete).not.toHaveBeenCalled();
    expect(mocks.dmUpdate).not.toHaveBeenCalled();
    expect(mocks.operationalCreate).not.toHaveBeenCalled();
  });

  it("applies only the configured class and never removes pending payloads", async () => {
    const result = await applyRetention(now, env({ RETENTION_WEBHOOK_EVENTS_DAYS: "30" }));
    expect(result).toEqual({ webhookEvents: 5, operationalEvents: 0, contactTexts: 0 });
    expect(mocks.webhookDelete).toHaveBeenCalledWith({
      where: { createdAt: { lt: new Date("2030-05-31T00:00:00Z") }, status: { not: "PENDING" } },
    });
    expect(mocks.operationalDelete).not.toHaveBeenCalled();
    expect(mocks.dmUpdate).not.toHaveBeenCalled();
  });

  it("clears old contact text but keeps the delivery row", async () => {
    await applyRetention(now, env({ RETENTION_CONTACT_TEXT_DAYS: "90" }));
    const call = mocks.dmUpdate.mock.calls[0][0];
    expect(call.where.createdAt).toEqual({ lt: new Date("2030-04-01T00:00:00Z") });
    expect(call.where.status).toEqual({ not: "PENDING" });
    expect(call.data).toEqual({ commentText: RETENTION_ERASED_TEXT, commenterName: null });
    expect(call.data).not.toHaveProperty("commentId");
  });

  it("records one summary event only when something was removed", async () => {
    await applyRetention(now, env({ RETENTION_OPERATIONAL_EVENTS_DAYS: "60" }));
    expect(mocks.operationalCreate).toHaveBeenCalledOnce();
    expect(mocks.operationalCreate.mock.calls[0][0].data.payload).toMatchObject({ operationalEvents: 2, days: { operationalEvents: 60 } });

    vi.clearAllMocks();
    mocks.operationalDelete.mockResolvedValue({ count: 0 });
    await applyRetention(now, env({ RETENTION_OPERATIONAL_EVENTS_DAYS: "60" }));
    expect(mocks.operationalCreate).not.toHaveBeenCalled();
  });
});
