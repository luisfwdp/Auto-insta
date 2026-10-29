import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import CriapingDashboard, { type CriapingDashboardStats } from "../components/criaping-dashboard";
import Sidebar from "../components/sidebar";

vi.mock("next/navigation", () => ({ usePathname: () => "/dashboard" }));

const stats: CriapingDashboardStats = {
  userName: "Luis",
  totalAutomations: 2,
  activeAutomations: 1,
  totalDMs: 12,
  totalClicks: 3,
  instagramAccounts: [{ id: "ig-1", username: "criaping", instagramId: "123" }],
  dailyDMs: [{ date: "Mon", count: 0 }, { date: "Tue", count: 2 }],
};

function render(props: Partial<Parameters<typeof CriapingDashboard>[0]> = {}) {
  return renderToStaticMarkup(createElement(CriapingDashboard, {
    stats,
    loading: false,
    error: false,
    selectedAccountId: "all",
    onAccountChange: () => undefined,
    onRetry: () => undefined,
    ...props,
  }));
}

describe("CRIA PING operational dashboard", () => {
  it("renders only metrics supplied by the real stats endpoint", () => {
    const html = render();
    expect(html).toContain("Automations");
    expect(html).toContain("Messages sent");
    expect(html).toContain(">12<");
    expect(html).toContain("Results available");
  });

  it("guides a new account without inventing results", () => {
    const html = render({ stats: { ...stats, totalAutomations: 0, activeAutomations: 0, totalDMs: 0, totalClicks: 0, instagramAccounts: [] } });
    expect(html).toContain("Connect Instagram");
    expect(html).toContain("/api/instagram/connect");
  });

  it("shows the campaign empty state only after an account exists", () => {
    const html = render({ stats: { ...stats, totalAutomations: 0, activeAutomations: 0 } });
    expect(html).toContain("No campaigns yet");
    expect(html).toContain('/campaigns/new');
  });

  it("reuses the Instagram account selector when multiple accounts exist", () => {
    const html = render({ stats: { ...stats, instagramAccounts: [...stats.instagramAccounts, { id: "ig-2", username: "creator", instagramId: "456" }] } });
    expect(html).toContain("Instagram account");
    expect(html).toContain("@criaping");
    expect(html).toContain("@creator");
  });

  it("uses explicit loading and error states", () => {
    expect(render({ loading: true })).toContain('aria-busy="true"');
    const error = render({ stats: null, error: true });
    expect(error).toContain("Dashboard unavailable");
    expect(error).toContain("Nothing estimated was shown");
  });

  it("exposes an accessible close action in the mobile navigation", () => {
    const html = renderToStaticMarkup(createElement(Sidebar, { isOpen: true, onClose: () => undefined, workspaceName: "CRIA PING", newDesign: true }));
    expect(html).toContain('aria-label="Close menu"');
    expect(html).toContain('aria-current="page"');
    expect(html).toContain("CRIA");
  });
});
