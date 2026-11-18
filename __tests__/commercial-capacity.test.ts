import { describe, expect, it, vi, afterEach } from "vitest";
import type { Prisma } from "../app/generated/prisma/client";
const state = vi.hoisted(() => ({ accesses: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ prisma: new Proxy({}, { get() { state.accesses(); throw new Error("Unexpected legacy DB access"); } }) }));
import { prisma } from "../lib/db/client";
import { assertCommercialAccountUsable, assertCommercialCapacityAccess, assertCommercialMemberCapacity, withCommercialAccountCapacity } from "../lib/billing/commercial-capacity";
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

describe("commercial capacity legacy compatibility", () => {
  it.each([undefined, "false", " FALSE ", "1", ""])("does no additional DB work with BILLING_ENABLED=%s", async flag => {
    vi.stubEnv("BILLING_ENABLED", flag);
    await assertCommercialAccountUsable("", ""); await assertCommercialCapacityAccess("workspace-a");
    await assertCommercialMemberCapacity({} as Prisma.TransactionClient, "workspace-a", { userId: "member", email: "member@example.test" });
    const write = vi.fn(async (tx: Prisma.TransactionClient) => { expect(tx).toBe(prisma); return "legacy-write"; });
    expect(await withCommercialAccountCapacity("workspace-a", "ig-a", write)).toBe("legacy-write");
    expect(write).toHaveBeenCalledOnce(); expect(state.accesses).not.toHaveBeenCalled();
  });
  it("retains an existing caller transaction unchanged in legacy mode", async () => {
    vi.stubEnv("BILLING_ENABLED", "false");
    const tx = {} as Prisma.TransactionClient, write = vi.fn(async (db: Prisma.TransactionClient) => { expect(db).toBe(tx); return true; });
    expect(await withCommercialAccountCapacity("workspace-a", "ig-a", write, tx)).toBe(true);
    expect(write).toHaveBeenCalledOnce(); expect(state.accesses).not.toHaveBeenCalled();
  });
});
