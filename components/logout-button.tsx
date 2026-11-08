"use client";

import { useI18n } from "@/lib/i18n/provider";
import { signOut } from "next-auth/react";
import { useState } from "react";

export default function LogoutButton({ newDesign = false }: { newDesign?: boolean }) {
  const { t } = useI18n();
  const [pending, setPending] = useState(false);

  return (
    <button
      type="button"
      disabled={pending}
      aria-busy={pending || undefined}
      onClick={() => {
        setPending(true);
        void signOut({ callbackUrl: "/login" }).catch(() => setPending(false));
      }}
      className={`mt-4 w-full rounded border px-3 py-2 text-left text-sm font-medium disabled:opacity-60 ${newDesign ? "border-[#494949] text-[#F5F5F5] hover:bg-[#252525]" : "border-border text-foreground hover:bg-surface-hover"}`}
    >
      {pending ? t("Signing out…") : t("Sign out")}
    </button>
  );
}
