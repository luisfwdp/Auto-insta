import { getI18n } from "@/lib/i18n/server";
import Link from "next/link";
import styles from "../login/auth-page.module.css";

export async function generateMetadata() {
  const { t } = await getI18n();
  return {
    title: t("Check your email - PING CHAT"),
    description: t("A sign-in link was sent to your email."),
  };
}

export default async function VerifyRequestPage() {
  const { t } = await getI18n();
  return (
    <div className={`${styles.page} min-h-screen flex items-center justify-center px-6`}>
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <h1 className="text-2xl font-semibold text-[#F5F5F5]">
            PING CHAT
          </h1>
        </div>

        <div className="panel rounded p-8 text-center">
          <h2 className="text-lg font-semibold mb-2">{t("Check your email")}</h2>
          <p className="text-sm text-[#B5B5B5]">
            {t("If your address is eligible, you will receive a sign-in link. Check your inbox and spam folder.")}
          </p>
          <p className="mt-6 text-sm">
            <Link href="/login" className="text-[#C7FF2F] hover:underline">
              {t("Back to sign in")}
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
