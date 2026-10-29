import { redirect } from "next/navigation";
import CriapingOnboarding from "@/components/criaping-onboarding";
import { getMissingInstagramOAuthEnv } from "@/lib/env";
import { isFeatureEnabled } from "@/lib/feature-flags";

export default function OnboardingPage() {
  if (!isFeatureEnabled("newDesign")) redirect("/dashboard");

  return (
    <CriapingOnboarding
      metaConfigured={getMissingInstagramOAuthEnv().length === 0}
    />
  );
}
