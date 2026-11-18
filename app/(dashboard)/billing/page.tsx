import { redirect } from "next/navigation";
import { getCurrentWorkspaceContext } from "@/lib/workspace-access";
import { BillingSettings } from "@/components/billing-settings";

export default async function BillingPage() {
  const context = await getCurrentWorkspaceContext();
  if (!context) redirect("/login");
  return <BillingSettings role={context.role} workspaceId={context.workspaceId} />;
}
