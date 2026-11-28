import { expect, it, vi } from "vitest";

const { webhookFind, operationalFind } = vi.hoisted(() => ({
  webhookFind: vi.fn().mockResolvedValue([]),
  operationalFind: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/lib/workspace-access", () => ({
  canManageWorkspace: () => true,
  getCurrentWorkspaceContext: async () => ({ workspaceId: "workspace", userId: "user" }),
}));
vi.mock("@/lib/db/client", () => ({
  prisma: {
    user: { findUnique: async () => ({ email: "owner@example.test" }) },
    webhookEvent: { findMany: webhookFind },
    dmLog: { findMany: async () => [] },
    operationalEvent: { findMany: operationalFind },
  },
}));
vi.mock("@/lib/queue/client", () => ({
  getDMQueue: () => ({ getJobCounts: async () => ({ waiting: 0 }) }),
}));
vi.mock("@/lib/ops/worker-health", () => ({
  getWorkerAlerts: async () => [],
  getWorkerHealth: async () => ({ healthy: true, ageMs: 1, heartbeat: { hostname: "private-host", pid: 123 } }),
}));

it("returns minimal diagnostics and excludes historical provider error data", async () => {
  const { GET } = await import("@/app/api/admin/diagnostics/route");
  const result = await GET();
  expect(result.headers.get("cache-control")).toBe("no-store");
  const response = await result.json();
  expect(response.data.workerHealth).toEqual({ healthy: true, ageMs: 1 });
  expect(webhookFind.mock.calls[0][0]).toMatchObject({ where: { workspaceId: "workspace" } });
  expect(webhookFind.mock.calls[0][0].select).not.toHaveProperty("errorMessage");
  expect(operationalFind.mock.calls[0][0].select).not.toHaveProperty("payload");
});
