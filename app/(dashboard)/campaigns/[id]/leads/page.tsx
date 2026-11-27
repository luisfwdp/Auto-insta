import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { CampaignLeads } from "@/components/campaign-leads";
import { prisma } from "@/lib/db/client";
import { getI18n } from "@/lib/i18n/server";
import { canManageWorkspace, getCurrentWorkspaceContext } from "@/lib/workspace-access";

export default async function CampaignLeadsPage({ params }: { params: Promise<{ id: string }> }) {
  const [{ id }, workspace, { t }] = await Promise.all([params, getCurrentWorkspaceContext(), getI18n()]);
  if (!workspace) redirect("/login");
  const campaign = await prisma.automation.findFirst({
    where: { id, workspaceId: workspace.workspaceId },
    select: { name: true },
  });
  if (!campaign) notFound();

  return (
    <main className="mx-auto max-w-4xl space-y-6 px-4 py-6 sm:px-6">
      <Link href={`/campaigns/${encodeURIComponent(id)}`} className="text-sm underline underline-offset-4">
        {campaign.name}
      </Link>
      <h1 className="text-2xl font-semibold">{t("Campaign leads")}</h1>
      {canManageWorkspace(workspace.role)
        ? <CampaignLeads key={id} campaignId={id} />
        : <p className="text-sm text-muted-foreground">{t("Only owners and admins can manage campaign leads.")}</p>}
    </main>
  );
}
