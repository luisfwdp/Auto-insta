// Temporary local review fixture: never ship an auth bypass or fake API route.
// Run cleanup before production builds/commits. APIs are intercepted by Playwright.
import { mkdir, writeFile, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
const directory = "app/design-system/campaign-review";
const baselineBuilder = "components/campaign-review-baseline-builder.tsx";
const baselineList = "components/campaign-review-baseline-list.tsx";
if (process.argv[2] === "cleanup") {
  await Promise.all([rm(directory, { recursive: true, force: true }), rm(baselineBuilder, { force: true }), rm(baselineList, { force: true })]);
} else {
  await mkdir(directory, { recursive: true });
  await writeFile(baselineBuilder, execFileSync("git", ["show", "origin/main:components/campaign-builder.tsx"]));
  await writeFile(baselineList, execFileSync("git", ["show", "origin/main:app/(dashboard)/campaigns/page.tsx"]));
  await writeFile(`${directory}/page.tsx`, `import { I18nProvider } from "@/lib/i18n/provider";
import DashboardShell from "@/components/dashboard-shell";
import CampaignBuilder from "@/components/campaign-builder";
import CampaignsPage from "@/app/(dashboard)/campaigns/page";
import BaselineBuilder from "@/components/campaign-review-baseline-builder";
import BaselineList from "@/components/campaign-review-baseline-list";
import { isFeatureEnabled } from "@/lib/feature-flags";
export const dynamic = "force-dynamic";
export const metadata = { title: "LOCAL REVIEW — mocked API data", robots: {index:false,follow:false} };
export default async function LocalReview({searchParams}:{searchParams:Promise<{screen?:string;lang?:string}>}) {
 const {screen="list",lang="pt-BR"}=await searchParams;
 return <I18nProvider locale={lang==="en"||lang==="zh-TW"?lang:"pt-BR"}><DashboardShell newDesign={isFeatureEnabled("newDesign")} workspaceName="Fixture local — dados de teste" instagramUsername="creator_one" instagramAccountCount={2}>
 {screen==="baseline-list"?<BaselineList/>:screen==="baseline-new"?<BaselineBuilder mode="new"/>:screen==="list"?<CampaignsPage/>:<CampaignBuilder mode={screen==="edit"?"edit":"new"} campaignId={screen==="edit"?"c1":undefined}/>}
 </DashboardShell></I18nProvider>;
}`);
}
