// Temporary local review fixture. Playwright intercepts every API request;
// cleanup removes the route before builds and commits.
import { mkdir, rm, writeFile } from "node:fs/promises";

const directory = "app/design-system/instagram-accounts-review";

if (process.argv[2] === "cleanup") {
  await rm(directory, { recursive: true, force: true });
} else {
  await mkdir(directory, { recursive: true });
  await writeFile(
    `${directory}/page.tsx`,
    `import { I18nProvider } from "@/lib/i18n/provider";
import DashboardShell from "@/components/dashboard-shell";
import SettingsPage from "@/app/(dashboard)/settings/page";
export const dynamic = "force-dynamic";
export const metadata = { title: "LOCAL REVIEW — mocked API data", robots: {index:false,follow:false} };
export default async function Review({searchParams}:{searchParams:Promise<{count?:string}>}) {
 const {count="2"}=await searchParams;
 const accountCount=Number(count) || 0;
 return <I18nProvider locale="pt-BR"><DashboardShell newDesign workspaceName="Fixture local — dados de teste" instagramUsername={accountCount?"creator_lab":null} instagramAccountCount={accountCount}>
 <SettingsPage />
 </DashboardShell></I18nProvider>;
}`,
  );
}
