import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db/client";
import { getI18n } from "@/lib/i18n/server";
import type { StaticMessageKey } from "@/lib/i18n";
import { issueLeadFormToken } from "@/lib/tracking/lead-capture";

export const metadata: Metadata = {
  title: "PING CHAT",
  robots: { index: false, follow: false },
  // Preserve Origin on a native same-origin POST. The redirect sets its own
  // no-referrer policy for navigation to the campaign destination.
  referrer: "same-origin",
};

const statusMessages: Record<string, StaticMessageKey> = {
  invalid: "Check your name, email and phone number.",
  expired: "This form expired. Fill in the new form to continue.",
  limit: "Too many attempts. Wait a few minutes and try again.",
  unavailable: "We could not save your details. Try again in a moment.",
};
const inputStyle = "mt-2 w-full rounded-lg border border-input bg-background px-3 py-2 text-foreground focus-visible:outline-2 focus-visible:outline-ring";

export default async function MaterialPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ status?: string | string[] }>;
}) {
  const [{ slug }, { status }, { t }] = await Promise.all([params, searchParams, getI18n()]);
  const link = await prisma.trackedLink.findUnique({
    where: { slug },
    select: {
      requireLead: true,
      workspaceId: true,
      automation: {
        select: { isActive: true, workspaceId: true, instagramAccount: { select: { username: true, workspaceId: true } } },
      },
    },
  });
  if (
    !link?.requireLead || !link.automation.isActive || link.automation.workspaceId !== link.workspaceId
    || link.automation.instagramAccount.workspaceId !== link.workspaceId
  ) notFound();

  const error = typeof status === "string" && Object.hasOwn(statusMessages, status) ? t(statusMessages[status]) : null;
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-lg items-center px-4 py-8">
      <div className="w-full rounded-2xl border border-border bg-card p-6 sm:p-8">
        <p className="text-sm font-medium text-muted-foreground">@{link.automation.instagramAccount.username}</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">{t("Access the material")}</h1>
        <p className="mt-3 text-sm text-muted-foreground">
          {t("Enter your details to open the link. They will be shared with the campaign organizer.")}
        </p>
        {error && <p role="alert" className="mt-4 rounded-lg border border-destructive p-3 text-sm">{error}</p>}
        <form action={`/r/${encodeURIComponent(slug)}`} method="post" className="mt-6 space-y-4">
          <input type="hidden" name="token" value={issueLeadFormToken(slug)} />
          <label className="block text-sm font-medium">
            {t("Full name")}
            <input name="name" autoComplete="name" minLength={2} maxLength={120} required className={inputStyle} />
          </label>
          <label className="block text-sm font-medium">
            {t("Email")}
            <input type="email" name="email" autoComplete="email" maxLength={254} required className={inputStyle} />
          </label>
          <label className="block text-sm font-medium">
            {t("Phone number")}
            <input type="tel" name="phone" autoComplete="tel" minLength={8} maxLength={30} required className={inputStyle} />
          </label>
          <button type="submit" className="w-full rounded-lg bg-[#C7FF2F] px-4 py-3 font-semibold text-[#0B0B0B] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring">
            {t("Open material")}
          </button>
        </form>
        <p className="mt-5 text-sm">
          <a href="/privacy" className="text-muted-foreground underline underline-offset-4">{t("Privacy Policy")}</a>
        </p>
      </div>
    </main>
  );
}
