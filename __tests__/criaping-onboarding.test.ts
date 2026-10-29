import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  CriapingOnboardingView,
} from "../components/criaping-onboarding";
import { CriapingInstagramAccounts } from "../components/criaping-instagram-accounts";
import { classifyRequestFailure } from "../components/request-failure";

const account = {
  id: "ig-1",
  username: "criaping",
  instagramId: "123",
  name: "Creator Lab",
};

function render(
  state: Parameters<typeof CriapingOnboardingView>[0]["state"],
  metaConfigured = true,
) {
  return renderToStaticMarkup(
    createElement(CriapingOnboardingView, {
      state,
      metaConfigured,
      onRetry: () => undefined,
    }),
  );
}

describe("CRIA PING onboarding", () => {
  it("uses real connected accounts to select the first campaign account", () => {
    const html = render({ status: "ready", accounts: [account] });
    expect(html).toContain("@criaping");
    expect(html).toContain("instagramAccountId=ig-1");
    expect(html).toContain("Create Campaign");
  });

  it("does not pretend Meta is available when configuration is absent", () => {
    const html = render({ status: "ready", accounts: [] }, false);
    expect(html).toContain("Meta is not configured");
    expect(html).not.toContain("/api/instagram/connect");
    expect(html).toContain("/settings");
  });

  it("shows the real connect action only when Meta is configured", () => {
    const html = render({ status: "ready", accounts: [] });
    expect(html).toContain("/api/instagram/connect");
  });

  it("covers prolonged loading without substituting estimated data", () => {
    const html = render({ status: "loading", slow: true });
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("taking longer than expected");
    expect(html).toContain("not been replaced or estimated");
  });

  it.each([
    [401, "session"],
    [403, "permission"],
    [400, "refused"],
    [503, "external"],
    [500, "api"],
  ] as const)("maps HTTP %i to the %s recovery state", (status, expected) => {
    expect(classifyRequestFailure(status)).toBe(expected);
    const html = render({ status: "error", failure: expected });
    expect(html).toContain('role="alert"');
  });
});

describe("CRIA PING Instagram accounts", () => {
  it("shows only connection facts supplied by the dashboard API", () => {
    const html = renderToStaticMarkup(
      createElement(CriapingInstagramAccounts, {
        accounts: [
          {
            ...account,
            provider: "META",
            tokenExpiresAt: null,
            webhookSubscribed: false,
          },
        ],
        loading: false,
        busyAccountId: null,
        failure: null,
        onDisconnect: () => undefined,
        onRetry: () => undefined,
      }),
    );
    expect(html).toContain("@criaping");
    expect(html).toContain("Webhook pending");
    expect(html).toContain("not available");
    expect(html).toContain("instagramAccountId=ig-1");
  });

  it("renders actionable empty and refused-operation states", () => {
    const empty = renderToStaticMarkup(
      createElement(CriapingInstagramAccounts, {
        accounts: [],
        loading: false,
        busyAccountId: null,
        failure: null,
        onDisconnect: () => undefined,
        onRetry: () => undefined,
      }),
    );
    expect(empty).toContain("No Instagram account connected");
    expect(empty).toContain("/api/instagram/connect");

    const refused = renderToStaticMarkup(
      createElement(CriapingInstagramAccounts, {
        accounts: [],
        loading: false,
        busyAccountId: null,
        failure: "refused",
        onDisconnect: () => undefined,
        onRetry: () => undefined,
      }),
    );
    expect(refused).toContain('role="alert"');
    expect(refused).toContain("operation was refused");
  });
});
