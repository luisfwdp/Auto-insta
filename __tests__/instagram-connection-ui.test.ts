import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  InstagramConnectNotice,
  resolveInstagramConnectFeedback,
} from "../components/instagram-connect-notice";
import { InstagramConnectionPanel } from "../components/instagram-connection-panel";

const navigation = vi.hoisted(() => ({ params: new URLSearchParams() }));
vi.mock("next/navigation", () => ({ useSearchParams: () => navigation.params }));

const account = {
  id: "account-1",
  username: "luispagodinsta",
  instagramId: "ig-1",
  provider: "META" as const,
  tokenExpiresAt: null,
  webhookSubscribed: true,
};

function renderPanel(props: Partial<Parameters<typeof InstagramConnectionPanel>[0]> = {}) {
  return renderToStaticMarkup(createElement(InstagramConnectionPanel, {
    accounts: [],
    ...props,
  }));
}

describe("Instagram connection interface", () => {
  beforeEach(() => {
    navigation.params = new URLSearchParams();
  });

  it("does not infer a disconnected account while the status is loading or unavailable", () => {
    const loading = renderPanel({ loading: true });
    expect(loading).toContain('aria-busy="true"');
    expect(loading).not.toContain("Not connected");

    const failed = renderPanel({ error: true, onRetry: () => undefined });
    expect(failed).toContain('role="alert"');
    expect(failed).toContain("Connection status unavailable");
    expect(failed).toContain("No connection status was assumed");
    expect(failed).not.toContain("Not connected");
  });

  it("shows an explicit disconnected state and a connection action only after a successful fetch", () => {
    const html = renderPanel();
    expect(html).toContain("Not connected");
    expect(html).toContain("Connect using your own Meta app");
    expect(html).toContain('/api/instagram/connect');
  });

  it("shows the connected username and webhook subscription state", () => {
    const ready = renderPanel({ accounts: [account] });
    expect(ready).toContain("@luispagodinsta");
    expect(ready).toContain("Webhook ready");
    expect(ready).toContain("Connect another Instagram account");

    const pending = renderPanel({ accounts: [{ ...account, webhookSubscribed: false }] });
    expect(pending).toContain("Webhook pending");
  });

  it.each([
    ["denied", null, "Instagram connection cancelled"],
    ["invalid", null, "OAuth return incomplete"],
    ["forbidden", null, "Not permitted"],
    ["already_connected", null, "Account already connected"],
    ["connected", null, "Instagram account connected"],
    ["failed", "No Instagram account was shared during login", "Professional Instagram account not found"],
    ["failed", "Share exactly one Instagram account during login", "Instagram permission is insufficient"],
    ["failed", "Token exchange failed: internal detail", "Meta configuration needs attention"],
    ["failed", "Meta API temporary error", "Meta is temporarily unavailable"],
    ["failed", "unexpected internal detail", "Instagram connection failed"],
  ])("maps %s to safe feedback", (status, reason, title) => {
    expect(resolveInstagramConnectFeedback(status, reason)?.title).toBe(title);
  });

  it("never renders the raw backend reason and offers a safe next action", () => {
    const rawReason = "Token exchange failed: secret internal detail";
    navigation.params = new URLSearchParams({ instagram: "failed", reason: rawReason });
    const html = renderToStaticMarkup(createElement(InstagramConnectNotice));
    expect(html).toContain("Meta configuration needs attention");
    expect(html).toContain("Open diagnostics");
    expect(html).not.toContain(rawReason);
  });

  it("renders an assertive alert for an incomplete OAuth return", () => {
    navigation.params = new URLSearchParams({ instagram: "invalid" });
    const html = renderToStaticMarkup(createElement(InstagramConnectNotice));
    expect(html).toContain('role="alert"');
    expect(html).toContain('aria-live="assertive"');
    expect(html).toContain("Try again");
  });
});
