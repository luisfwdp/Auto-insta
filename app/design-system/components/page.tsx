import type { Metadata } from "next";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { isFeatureEnabled } from "@/lib/feature-flags";
import { isLocale, LOCALE_COOKIE } from "@/lib/i18n";
import { I18nProvider } from "@/lib/i18n/provider";
import Gallery from "./gallery";

export const metadata: Metadata = { title: "CRIA PING | UI", robots: { index: false, follow: false } };
export default async function ComponentsPage() {
  if (!isFeatureEnabled("newDesign")) notFound();
  const cookieStore = await cookies();
  const preference = cookieStore.get(LOCALE_COOKIE)?.value;
  return <I18nProvider locale={isLocale(preference) ? preference : "pt-BR"}><Gallery /></I18nProvider>;
}
