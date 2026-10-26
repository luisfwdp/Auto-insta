"use client";

import { useI18n } from "@/lib/i18n/provider";


export interface AccountOption {
  id: string;
  username: string;
  instagramId: string;
  name?: string | null;
}

interface AccountSelectProps {
  accounts: AccountOption[];
  value: string;
  onChange: (value: string) => void;
  includeAll?: boolean;
  label?: string;
  newDesign?: boolean;
}

export default function AccountSelect({
  accounts,
  value,
  onChange,
  includeAll = true,
  label,
  newDesign = false,
}: AccountSelectProps) {
  const { t } = useI18n();
  return (
    <label className="flex flex-col gap-2 text-sm">
      <span className={`text-xs font-semibold uppercase tracking-wide ${newDesign ? "text-[#B5B5B5]" : "text-zinc-500"}`}>
        {label ?? t("Instagram account")}
      </span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={`min-w-52 rounded-xl border px-3 py-2 text-sm outline-none transition-colors ${newDesign ? "border-[#828282] bg-[#1A1A1A] text-[#F5F5F5] focus:border-[#C7FF2F]" : "border-border bg-surface text-foreground focus:border-accent/40"}`}
      >
        {includeAll && <option value="all">{t("All accounts")}</option>}
        {accounts.map((account) => (
          <option key={account.id} value={account.id}>
            @{account.username}
          </option>
        ))}
      </select>
    </label>
  );
}

