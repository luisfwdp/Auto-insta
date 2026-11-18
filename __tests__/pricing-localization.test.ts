import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveLocale, createI18n } from "../lib/i18n";
import { BILLING_PLANS, BILLING_PLAN_IDS } from "../lib/billing/catalog";

vi.mock("@/lib/i18n/server", () => ({ getI18n: async () => ({ locale: "pt-BR", t: createI18n("pt-BR").t }) }));
vi.mock("@/lib/i18n/provider", () => ({ I18nProvider: ({ children }: { children: React.ReactNode }) => children }));
vi.mock("@/components/language-switcher", () => ({ default: () => null }));
const switcher = readFileSync(new URL("../components/language-switcher.tsx", import.meta.url), "utf8");
afterEach(() => vi.unstubAllEnvs());

async function pricingHtml(enabled: boolean, selling: boolean) {
  vi.stubEnv("BILLING_ENABLED", String(enabled)); vi.stubEnv("BILLING_SALES_ENABLED", String(selling));
  const { default: Pricing } = await import("../app/pricing/page");
  return renderToStaticMarkup(createElement("div", null, await Pricing()));
}

describe("Portuguese-first pricing", () => {
  it("uses Brazilian Portuguese when no supported cookie is present", () => {
    expect(resolveLocale(undefined)).toBe("pt-BR"); expect(resolveLocale("unsupported")).toBe("pt-BR");
  });
  it("renders the actual versioned offers and the three-day card-free contract", async () => {
    const html = await pricingHtml(true, true), format = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
    for (const id of BILLING_PLAN_IDS) expect(html).toContain(format.format(BILLING_PLANS[id].amountCents / 100));
    expect(html).toContain(createI18n("pt-BR").t("3 days free. No card required."));
    expect(html).toContain(createI18n("pt-BR").t("No automatic charge without a subscription."));
    expect(html).toContain('href="/login?mode=signup"');
    expect(html).not.toContain("R$ 29"); expect(html).not.toContain("R$ 59");
  });
  it.each([[false, false], [true, false]])("hides purchase offers when billing=%s and sales=%s", async (enabled, selling) => {
    const html = await pricingHtml(enabled, selling);
    expect(html).toContain(createI18n("pt-BR").t("New subscriptions are temporarily unavailable."));
    for (const id of BILLING_PLAN_IDS) expect(html).not.toContain(new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(BILLING_PLANS[id].amountCents / 100));
  });
  it("offers Portuguese and English in the visible language control", () => {
    expect(switcher).toContain('value="pt-BR"'); expect(switcher).toContain('value="en"'); expect(switcher).not.toContain('value="zh-TW"');
  });
});
