import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ enabled: true, newDesign: true }));
const mocks = vi.hoisted(() => ({ signIn: vi.fn(), context: vi.fn(), access: vi.fn(), transaction: vi.fn(), redirect: vi.fn() }));
vi.mock("@/lib/auth", () => ({ EMAIL_PROVIDER_ID: "resend", signIn: mocks.signIn }));
vi.mock("next-auth", () => ({ AuthError: class AuthError extends Error {} }));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ host: "app.example.test" }) }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("@/lib/i18n/server", () => ({ getI18n: async () => ({ t: (key: string) => key }) }));
vi.mock("@/lib/env", () => ({ isPublicDemoHost: async () => false, isEmailAllowedToSignIn: () => true, getMissingInstagramOAuthEnv: () => [] }));
vi.mock("@/lib/api/auth-rate-limit", () => ({ checkMagicLinkRateLimit: async () => ({ allowed: true }) }));
vi.mock("@/components/demo-notice", () => ({ DemoNotice: () => null }));
vi.mock("@/lib/billing/trial", () => ({ isBillingEnabled: () => state.enabled }));
vi.mock("@/lib/billing/commercial-access", () => ({ loadCommercialEntitlement: mocks.access }));
vi.mock("@/lib/workspace-access", () => ({ getCurrentWorkspaceContext: mocks.context }));
vi.mock("@/lib/feature-flags", () => ({ isFeatureEnabled: () => state.newDesign }));
vi.mock("@/lib/db/client", () => ({ prisma: { $transaction: mocks.transaction } }));
vi.mock("@/components/billing-settings", () => ({ TrialOnboarding: () => null }));
vi.mock("@/components/criaping-onboarding", () => ({ default: () => null }));

import Login from "@/app/login/page";
import Onboarding from "@/app/(dashboard)/onboarding/page";
import { TrialOnboarding } from "@/components/billing-settings";
import CriapingOnboarding from "@/components/criaping-onboarding";

class Redirect extends Error { constructor(readonly location: string) { super("Redirect"); } }
const slug = "dtc-product-link", destination = `/campaigns/new?template=${slug}`;
function formAction(node: unknown): ((body: FormData) => Promise<void>) | null {
  if (Array.isArray(node)) { for (const item of node) { const found = formAction(item); if (found) return found; } return null; }
  if (!node || typeof node !== "object" || !("props" in node)) return null;
  const element = node as { type: unknown; props: { action?: unknown; children?: unknown } };
  if (element.type === "form" && typeof element.props.action === "function") return element.props.action as (body: FormData) => Promise<void>;
  return formAction(element.props.children);
}
function visibleText(node: unknown): string {
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(visibleText).join(" ");
  if (node && typeof node === "object" && "props" in node) return visibleText((node as { props: { children?: unknown } }).props.children);
  return "";
}
async function requestSignIn(params: { mode?: string; template?: string; callbackUrl?: string }) {
  const action = formAction(await Login({ searchParams: Promise.resolve(params) }));
  expect(action).toBeTypeOf("function"); const body = new FormData(); body.set("email", "new@example.test"); await action!(body);
  return mocks.signIn.mock.calls.at(-1)![1].redirectTo;
}
beforeEach(() => {
  vi.clearAllMocks(); state.enabled = true; state.newDesign = true;
  mocks.context.mockResolvedValue({ userId: "user", workspaceId: "workspace", role: "OWNER" });
  mocks.access.mockResolvedValue({ status: "denied", code: "BILLING_NOT_STARTED" });
  mocks.transaction.mockImplementation(async operation => operation({ fixture: true }));
  mocks.redirect.mockImplementation((href: string) => { throw new Redirect(href); });
  mocks.signIn.mockResolvedValue(undefined);
});

describe("template registration preserves intent through the card-free trial", () => {
  it.each([undefined, "signup"])("routes a validated template through onboarding with signup mode %s", async mode => {
    expect(await requestSignIn({ mode, template: slug })).toBe(`/onboarding?template=${slug}`);
  });
  it("keeps the original template callback when commercial mode is disabled", async () => {
    state.enabled = false; expect(await requestSignIn({ template: slug })).toBe(destination);
  });
  it("does not advertise or promise a trial when billing is disabled", async () => {
    state.enabled = false;
    const copy = visibleText(await Login({ searchParams: Promise.resolve({ mode: "signup" }) }));
    expect(copy).not.toContain("Start 3 days free without a card.");
    expect(copy).not.toContain("Confirm your email, then activate your free trial.");
    expect(copy).not.toContain("New here? Create an account");
    expect(await requestSignIn({ mode: "signup" })).toBe("/dashboard");
  });
  it("keeps ordinary signup and existing explicit callback behavior", async () => {
    expect(await requestSignIn({ mode: "signup" })).toBe("/onboarding");
    expect(await requestSignIn({ mode: "signup", template: slug, callbackUrl: "/settings" })).toBe("/settings");
  });
  it("does not carry unrecognized template input into the callback", async () => {
    expect(await requestSignIn({ mode: "signup", template: "../../foreign?x=1" })).toBe("/onboarding");
  });
  it("shows the trial first and keeps the validated destination after activation", async () => {
    const page = await Onboarding({ searchParams: Promise.resolve({ template: slug }) });
    expect(page).toMatchObject({ type: TrialOnboarding, props: { role: "OWNER", onSuccessHref: destination } });
    expect(mocks.access).toHaveBeenCalledWith({ fixture: true }, "workspace", expect.any(Date));
    expect(mocks.redirect).not.toHaveBeenCalled();
  });
  it.each(["trial", "paid"])("takes an already entitled %s account directly to its template without starting/resetting trial", async status => {
    mocks.access.mockResolvedValue({ status });
    await expect(Onboarding({ searchParams: Promise.resolve({ template: slug }) })).rejects.toMatchObject({ location: destination });
    expect(mocks.transaction).toHaveBeenCalledOnce(); expect(mocks.signIn).not.toHaveBeenCalled();
  });
  it("keeps normal onboarding and legacy OFF behavior unchanged", async () => {
    expect(await Onboarding({ searchParams: Promise.resolve({}) })).toMatchObject({ type: TrialOnboarding, props: { onSuccessHref: "/onboarding" } });
    state.enabled = false; mocks.transaction.mockClear();
    expect(await Onboarding({ searchParams: Promise.resolve({ template: slug }) })).toMatchObject({ type: CriapingOnboarding, props: { metaConfigured: true } });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
  it("does not trust unknown templates or bypass authentication", async () => {
    expect(await Onboarding({ searchParams: Promise.resolve({ template: "https://foreign.test" }) })).toMatchObject({ props: { onSuccessHref: "/onboarding" } });
    mocks.context.mockResolvedValue(null);
    await expect(Onboarding({ searchParams: Promise.resolve({ template: slug }) })).rejects.toMatchObject({ location: "/login" });
  });
});
