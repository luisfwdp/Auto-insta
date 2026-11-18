import { redirect } from "next/navigation";
import { isFeatureEnabled } from "@/lib/feature-flags";
import { getMissingInstagramOAuthEnv } from "@/lib/env";
import CriapingOnboarding from "@/components/criaping-onboarding";
import { TrialOnboarding } from "@/components/billing-settings";
import { getCurrentWorkspaceContext } from "@/lib/workspace-access";
import { isBillingEnabled } from "@/lib/billing/trial";
import { loadCommercialEntitlement } from "@/lib/billing/commercial-access";
import { prisma } from "@/lib/db/client";

export default async function OnboardingPage() {
  if (isBillingEnabled()) {
    const context = await getCurrentWorkspaceContext();
    if (!context) redirect("/login");
    const access = await prisma.$transaction(tx => loadCommercialEntitlement(tx, context.workspaceId, new Date()));
    if (!access || access.status === "denied") return <TrialOnboarding role={context.role} onSuccessHref="/onboarding" />;
  }
  if (!isFeatureEnabled("newDesign")) redirect("/dashboard");
  return <CriapingOnboarding metaConfigured={getMissingInstagramOAuthEnv().length === 0} />;
}
