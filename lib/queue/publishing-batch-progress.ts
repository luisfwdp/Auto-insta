import { prisma } from "@/lib/db/client";

/** Serialize progress snapshots with other refreshes and batch pause/cancel updates. */
export async function refreshBatchProgress(batchId: string | null, workspaceId: string) {
  if (!batchId) return;
  await prisma.$transaction(async (tx) => {
    // Lock before counting. Otherwise a stale writer can overwrite cancellation
    // or counts produced by a later worker. Template parameters stay bound.
    const [batch] = await tx.$queryRaw<Array<{ totalItems: number; status: string }>>`
      SELECT "totalItems", "status" FROM "SpeedPostBatch"
      WHERE "id" = ${batchId} AND "workspaceId" = ${workspaceId}
      FOR UPDATE
    `;
    if (!batch || batch.status === "CANCELLED") return;

    const counts = await tx.scheduledPublication.groupBy({
      by: ["status"],
      where: { batchId, workspaceId, status: { in: ["PUBLISHED", "FAILED"] } },
      _count: { _all: true },
    });
    const publishedItems = counts.find((row) => row.status === "PUBLISHED")?._count._all ?? 0;
    const failedItems = counts.find((row) => row.status === "FAILED")?._count._all ?? 0;
    const complete = publishedItems + failedItems >= batch.totalItems;
    await tx.speedPostBatch.updateMany({
      where: { id: batchId, workspaceId },
      data: {
        publishedItems,
        failedItems,
        ...(complete ? { status: failedItems > 0 ? "FAILED" : "COMPLETED", completedAt: new Date() } : {}),
      },
    });
  });
}
