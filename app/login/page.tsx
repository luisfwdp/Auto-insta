import { EMAIL_PROVIDER_ID, signIn } from "@/lib/auth";
import { getI18n } from "@/lib/i18n/server";
import { getCampaignTemplate } from "@/lib/templates/campaign-templates";
import { DemoNotice } from "@/components/demo-notice";
import { isEmailAllowedToSignIn, isPublicDemoHost } from "@/lib/env";
import { checkMagicLinkRateLimit } from "@/lib/api/auth-rate-limit";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { AuthError } from "next-auth";
import { z } from "zod";
import Link from "next/link";
import styles from "./auth-page.module.css";

const GITHUB_URL = "https://github.com/diwenne/openreply";
const SETUP_DOCS_URL = `${GITHUB_URL}/blob/main/docs/setup.md`;

export async function generateMetadata() {
  const { t } = await getI18n();
  return {
    title: t("Sign in - CRIA PING"),
    description: t("Sign in to manage Instagram comment-to-DM campaigns."),
  };
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{
    checkEmail?: string;
    callbackUrl?: string;
    template?: string;
    mode?: string;
  }>;
}) {
  const { t } = await getI18n();
  if (await isPublicDemoHost()) {
    return (
      <div className="min-h-screen flex items-center justify-center px-6">
        <div className="w-full max-w-md text-center">
          <h1 className="text-2xl font-semibold text-foreground">
            OpenReply
          </h1>
          <div className="panel rounded p-8 mt-8 shadow-black/40">
            <h2 className="text-lg font-semibold text-foreground">
              {t("Sign-in is off on this demo")}
            </h2>
            <p className="mt-3 text-sm leading-relaxed text-muted">
              {t("This is the public demo — it doesn’t create real accounts or send DMs. To use OpenReply for real, clone it and run your own instance with your own Meta app and domain.")}
            </p>
            <a
              href={SETUP_DOCS_URL}
              target="_blank"
              rel="noreferrer"
              className="mt-6 inline-flex w-full items-center justify-center gap-2 rounded bg-accent px-6 py-3.5 text-sm font-semibold text-white shadow-indigo-500/25 transition-all hover:shadow-indigo-500/30"
            >
              {t("Clone it yourself")} <span aria-hidden="true">↗</span>
            </a>
          </div>
        </div>
      </div>
    );
  }

  const params = await searchParams;
  const signup = params.mode === "signup";
  const checkEmail = params.checkEmail === "1";
  const selectedTemplate = getCampaignTemplate(params.template);
  const templateCallbackUrl = selectedTemplate
    ? `/campaigns/new?template=${selectedTemplate.slug}`
    : null;
  const callbackUrl = params.callbackUrl ?? templateCallbackUrl ?? (signup ? "/onboarding" : "/dashboard");
  const checkEmailUrl = `/login?checkEmail=1${signup ? "&mode=signup" : ""}`;

  async function sendMagicLink(formData: FormData) {
    "use server";
    const parsed = z.email().max(254).safeParse(String(formData.get("email") ?? "").trim().toLowerCase());
    if (!parsed.success) redirect(checkEmailUrl);
    const email = parsed.data;
    const limit = await checkMagicLinkRateLimit({
      headers: await headers(),
      email,
    }).catch(() => ({ allowed: false as const, retryAfter: 60 }));

    if (!limit.allowed) redirect(checkEmailUrl);

    // Keep the browser response identical for allowed and unknown addresses.
    // The signIn callback repeats this check when the magic link is consumed.
    if (!isEmailAllowedToSignIn(email)) redirect(checkEmailUrl);

    try {
      await signIn(EMAIL_PROVIDER_ID, { email, redirectTo: callbackUrl });
    } catch (error) {
      // Keep account eligibility and provider errors private. Next redirects
      // are not AuthErrors and must keep propagating to the framework.
      if (error instanceof AuthError) redirect(checkEmailUrl);
      throw error;
    }
  }

  return (
    <div className={`${styles.page} min-h-screen flex items-center justify-center px-6`}>
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <h1 className="text-2xl font-semibold text-[#F5F5F5]">
            PING CHAT
          </h1>
          <p className="text-[#B5B5B5] text-sm leading-relaxed mt-2">
            {selectedTemplate
              ? t("Sign in to use the {name} template.", { name: selectedTemplate.title })
              : signup ? t("Confirm your email, then activate your free trial.")
              : t("Sign in by email, then connect your Instagram professional account.")}
          </p>
        </div>

        <DemoNotice variant="panel" />

        <div className="panel rounded p-8 shadow-black/40">
          {signup && !checkEmail && <div className="mb-6 space-y-2">
            <h2 className="text-xl font-semibold">{t("Create your account")}</h2>
            <p className="text-sm text-[#C7FF2F]">{t("Start 3 days free without a card.")}</p>
            <p className="text-sm text-[#B5B5B5]">{t("Your trial starts when you activate it. No payment is required to register.")}</p>
          </div>}
          {selectedTemplate && !checkEmail && (
            <div className="mb-5 border border-[#C7FF2F]/20 bg-[#C7FF2F]/10 p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-[#C7FF2F]">
                {t("Template selected")}
              </p>
              <p className="mt-2 text-sm font-semibold text-[#F5F5F5]">
                {selectedTemplate.title}
              </p>
            </div>
          )}

          {checkEmail ? (
            <div className="text-center py-4">
              <h2 className="text-lg font-semibold mb-2">{t("Check your email")}</h2>
              <p className="text-sm text-[#B5B5B5]">
                {t("If your address is eligible, you will receive a sign-in link. Check your inbox and spam folder.")}
              </p>
              <p className="mt-3 text-xs text-[#B5B5B5]">{t("Please wait before requesting another sign-in link.")}</p>
            </div>
          ) : (
            <form action={sendMagicLink} className="space-y-5">
              <div className="space-y-2">
                <label
                  htmlFor="email"
                  className="block text-sm font-medium text-[#F5F5F5]"
                >
                  {t("Work email")}
                </label>
                <input
                  id="email"
                  name="email"
                  type="email"
                  required
                  autoComplete="email"
                  placeholder="you@company.com"
                  className="w-full px-4 py-3 rounded bg-[#1A1A1A] border border-[#494949] text-sm text-[#F5F5F5] placeholder:text-[#B5B5B5] focus:border-[#C7FF2F] focus:outline-none transition-colors"
                />
              </div>

              <button
                type="submit"
                className="w-full inline-flex items-center justify-center gap-2 rounded bg-[#C7FF2F] px-6 py-3.5 text-sm font-semibold text-[#0B0B0B] transition-colors hover:bg-[#B7ED20]"
              >
                {t("Email me a magic link")}
              </button>
            </form>
          )}
        </div>
        <div className="mt-6 space-y-3 text-center text-sm text-[#B5B5B5]">
          <Link href={signup ? "/login" : "/login?mode=signup"} className="text-[#C7FF2F] hover:underline">
            {signup ? t("Already have an account? Sign in") : t("New here? Create an account")}
          </Link>
          <p><Link href="/privacy" className="hover:underline">{t("Privacy")}</Link>{" · "}<Link href="/terms" className="hover:underline">{t("Terms")}</Link></p>
        </div>
      </div>
    </div>
  );
}
