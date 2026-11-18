import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { BillingSettings, TrialOnboarding, BillingWorkspaceChangedNotice } from "@/components/billing-settings";

vi.mock("@/lib/i18n/provider", () => ({ useI18n: () => ({ locale: "en", t: (key: string, values?: Record<string, string | number>) => key.replace(/\{(\w+)\}/g, (all, name) => String(values?.[name] ?? all)) }) }));

describe("billing shell privacy and onboarding semantics", () => {
  it("keeps an administrator read-only and announces loading without inventing zero usage", () => {
    const html = renderToStaticMarkup(createElement(BillingSettings, { role: "ADMIN", workspaceId: "workspace-a" }));
    expect(html).toContain("Only the workspace owner can start a trial or change billing.");
    expect(html).toContain('role="status"'); expect(html).toContain('aria-busy="true"');
    expect(html).not.toContain("Create secure Asaas checkout"); expect(html).not.toContain("Confirm renewal cancellation");
    expect(html).not.toContain("Used: 0"); expect(html).not.toContain("7900");
  });
  it("renders the owner shell without an automatic purchase or fabricated access", () => {
    const html = renderToStaticMarkup(createElement(BillingSettings, { role: "OWNER", workspaceId: "workspace-a" }));
    expect(html).toContain("Billing and subscription"); expect(html).toContain("Loading billing details");
    expect(html).not.toContain("Recorded access is active."); expect(html).not.toContain('href="https://asaas');
    expect(html).not.toContain("7900"); expect(html).not.toContain('type="submit"');
  });
  it("introduces the three-day card-free trial before offering any connection or payment", () => {
    const html = renderToStaticMarkup(createElement(TrialOnboarding, { role: "OWNER", workspaceId: "workspace-a" }));
    expect(html).toContain("3 days free. No card required."); expect(html).toContain("Loading billing details");
    expect(html).not.toContain('type="password"'); expect(html).not.toContain("Create secure Asaas checkout");
    expect(html).not.toContain('href="/settings"');
  });
  it.each(["/billing", "/onboarding"] as const)("shows only a hard reload action after the workspace pin fails: %s", href => {
    const html = renderToStaticMarkup(createElement(BillingWorkspaceChangedNotice, { href }));
    expect(html).toContain("Workspace changed. Reload this page before continuing.");
    expect(html).toContain(`href="${href}"`); expect(html).toContain('role="alert"');
    expect(html).not.toContain("<button"); expect(html).not.toContain("<form"); expect(html).not.toContain("Create secure Asaas checkout");
    expect(html).not.toContain("Confirm renewal cancellation"); expect(html).not.toContain("Start your 3-day trial");
  });
});
