import { redirect } from "next/navigation";
import { isFeatureEnabled } from "@/lib/feature-flags";
import { getMissingInstagramOAuthEnv } from "@/lib/env";
import CriapingOnboarding from "@/components/criaping-onboarding";

export default function OnboardingPage() {
  if (!isFeatureEnabled("newDesign")) redirect("/dashboard");
  return <CriapingOnboarding metaConfigured={getMissingInstagramOAuthEnv().length === 0} />;
}
