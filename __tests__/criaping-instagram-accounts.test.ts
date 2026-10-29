import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CriapingInstagramAccounts } from "../components/criaping-instagram-accounts";
import { classifyRequestFailure } from "../components/request-failure";

const account = {
  id: "ig-1",
  username: "criaping",
  instagramId: "123",
  name: "Creator Lab",
};

describe("CRIA PING Instagram accounts", () => {
  it.each([
    [401, "session"],
    [403, "permission"],
    [400, "refused"],
    [503, "external"],
    [500, "api"],
  ] as const)("maps HTTP %i to the %s recovery state", (status, expected) => {
    expect(classifyRequestFailure(status)).toBe(expected);
  });

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
