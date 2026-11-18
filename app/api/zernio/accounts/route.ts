import { NextResponse } from 'next/server';
import { z } from 'zod';
import { decryptToken } from '@/lib/meta/oauth';
import { withConnectionLock } from '@/lib/zernio/lock-connection';
import { loadConnection } from '@/lib/zernio/load-connection';
import { listInstagramAccounts } from '@/lib/zernio/manage-remote';
import { ConnectionError, readBody, withZernioManagement } from '@/lib/zernio/route-handler';
import { withCommercialAccountCapacity } from '@/lib/billing/commercial-capacity';
import { BillingError } from '@/lib/billing/config';
import { isBillingEnabled } from '@/lib/billing/trial';
import type { Prisma } from '@/app/generated/prisma/client';

const accountBodySchema = z.object({ accountId: z.string().min(1) });

export const POST = withZernioManagement(async ({ workspaceId }, request) => {
  const { accountId } = await readBody(request, accountBodySchema);
  const connection = await loadConnection(workspaceId);
  if (!connection.profileId || !connection.webhookId) throw new ConnectionError('Select a profile and finish webhook setup first.');
  const remote = (await listInstagramAccounts({ apiKey: connection.apiKey, profileId: connection.profileId })).find(a => a.id === accountId);
  if (!remote) throw new ConnectionError('That Instagram account is not in the selected profile.', 403);
  const persist = async (tx: Prisma.TransactionClient) => {
    const current = await tx.zernioConnection.findUnique({ where: { workspaceId } });
    if (!current || current.profileId !== connection.profileId || current.webhookId !== connection.webhookId || decryptToken(current.apiKey) !== connection.apiKey) throw new ConnectionError('Connection settings changed. Refresh and try again.');
      const existing = await tx.instagramAccount.findUnique({ where: { instagramId: remote.instagramId } });
      if (existing && (existing.workspaceId !== workspaceId || existing.provider !== 'ZERNIO')) throw new ConnectionError('This Instagram account is already connected. Existing connections are not migrated automatically.', 409);
      const data = { username: remote.username, name: remote.name, zernioAccountId: remote.id, webhookSubscribed: true };
      if (existing) {
        const updated = await tx.instagramAccount.updateMany({
          where: { id: existing.id, workspaceId, provider: 'ZERNIO' }, data,
        });
        if (!updated.count) throw new ConnectionError('This account connection changed. Refresh and try again.', 409);
      } else {
        await tx.instagramAccount.create({ data: { ...data, workspaceId, instagramId: remote.instagramId, provider: 'ZERNIO', accessToken: '' } });
      }
  };
  try {
    if (isBillingEnabled()) await withCommercialAccountCapacity(workspaceId, remote.instagramId, async tx => {
      // Commercial paths consistently lock owner before Workspace/FK writes.
      await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id = ${workspaceId} FOR UPDATE`;
      await persist(tx);
    });
    else await withConnectionLock(workspaceId, persist);
  } catch (error) {
    if (error instanceof BillingError) throw new ConnectionError(error.code, error.httpStatus);
    throw error;
  }
  return NextResponse.json({ success: true });
});
