"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n/provider";
import { Button } from "@/components/ui/primitives";

type CapturedLead = { id: string; name: string; phone: string; email: string; createdAt: string };
type CaptureLink = { id: string; label: string | null; requireLead: boolean };
type LeadPage = {
  leads: CapturedLead[];
  links: CaptureLink[];
  nextCursor: string | null;
  restartPagination?: boolean;
};

export function removeLeadFromPage(page: LeadPage, id: string): LeadPage {
  const leads = page.leads.filter((lead) => lead.id !== id);
  if (page.nextCursor !== id) return { ...page, leads };
  // The API looks up the cursor row. Use the preceding surviving row after
  // deleting it, or request the first page if no loaded contacts remain.
  return {
    ...page,
    leads,
    nextCursor: leads.at(-1)?.id ?? null,
    restartPagination: leads.length === 0,
  };
}

async function getLeads(endpoint: string, signal?: AbortSignal): Promise<LeadPage> {
  const response = await fetch(endpoint, { cache: "no-store", signal });
  if (!response.ok) throw new Error("Leads unavailable");
  return response.json() as Promise<LeadPage>;
}

export function CampaignLeads({ campaignId }: { campaignId: string }) {
  const { locale, t } = useI18n();
  const endpoint = `/api/automations/${encodeURIComponent(campaignId)}/leads`;
  const [page, setPage] = useState<LeadPage | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const cursor = page?.nextCursor;

  useEffect(() => {
    const controller = new AbortController();
    getLeads(endpoint, controller.signal).then(setPage).catch(() => {
      if (!controller.signal.aborted) setFailed(true);
    });
    return () => controller.abort();
  }, [endpoint]);

  async function perform(action: () => Promise<void>) {
    setBusy(true);
    setFailed(false);
    try {
      await action();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  async function changeCapture(link: CaptureLink) {
    const requireLead = !link.requireLead;
    await perform(async () => {
      const response = await fetch(endpoint, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ linkId: link.id, requireLead }),
      });
      if (!response.ok) throw new Error("Could not update capture");
      setPage((current) => current && ({
        ...current, links: current.links.map((entry) => entry.id === link.id ? { ...entry, requireLead } : entry),
      }));
    });
  }

  async function removeLead(id: string) {
    await perform(async () => {
      const response = await fetch(`${endpoint}?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!response.ok) throw new Error("Could not delete lead");
      setConfirmDelete(null);
      setPage((current) => current && removeLeadFromPage(current, id));
    });
  }

  return (
    <div className="space-y-6">
      {failed && (
        <p role="alert" className="rounded-lg border border-destructive p-3 text-sm">
          {t("The lead request could not be completed.")}
        </p>
      )}
      {!page && (failed
        ? <Button variant="secondary" disabled={busy} onClick={() => perform(async () => setPage(await getLeads(endpoint)))}>{t("Try again")}</Button>
        : <p role="status">{t("Loading…")}</p>)}
      {page && <>
        <section className="space-y-3 rounded-xl border border-border bg-card p-4">
          <h2 className="text-lg font-semibold">{t("Contact capture")}</h2>
          <p className="text-sm text-muted-foreground">{t("Require name, email and phone before opening a campaign link.")}</p>
          {page.links.length === 0 && <p className="text-sm">{t("Add a link to the campaign before enabling capture.")}</p>}
          {page.links.map((link, index) => (
            <label key={link.id} className="flex items-center gap-3 break-words rounded-lg border border-border p-3 text-sm">
              <input type="checkbox" checked={link.requireLead} disabled={busy}
                onChange={() => void changeCapture(link)} className="size-4 shrink-0 accent-[#C7FF2F]" />
              <span className="min-w-0">{link.label || t("Campaign link {position}", { position: index + 1 })}</span>
            </label>
          ))}
        </section>
        <section className="space-y-3">
          <h2 className="text-lg font-semibold">{t("Captured contacts")}</h2>
          {!page.leads.length && !page.restartPagination &&
            <p className="text-sm text-muted-foreground">{t("No contacts captured yet.")}</p>}
          <ul className="space-y-3">
            {page.leads.map((lead) => (
              <li key={lead.id} className="flex flex-wrap justify-between gap-3 rounded-xl border border-border bg-card p-4">
                <div className="min-w-0 space-y-1 break-words text-sm">
                  <strong>{lead.name}</strong>
                  <p>{lead.email}</p>
                  <p>{lead.phone}</p>
                  <time dateTime={lead.createdAt} className="text-muted-foreground">
                    {new Date(lead.createdAt).toLocaleString(locale)}
                  </time>
                </div>
                {confirmDelete === lead.id
                  ? <div className="space-y-2">
                      <p className="text-sm">{t("Permanently delete this contact?")}</p>
                      <div className="flex gap-2">
                        <Button variant="secondary" disabled={busy} onClick={() => setConfirmDelete(null)}>{t("Cancel")}</Button>
                        <Button variant="danger" disabled={busy} onClick={() => void removeLead(lead.id)}>{t("Delete")}</Button>
                      </div>
                    </div>
                  : <Button variant="secondary" disabled={busy} onClick={() => setConfirmDelete(lead.id)}>{t("Delete")}</Button>}
              </li>
            ))}
          </ul>
          {(cursor || page.restartPagination) && <Button variant="secondary" disabled={busy} onClick={() => perform(async () => {
            const url = cursor ? `${endpoint}?cursor=${encodeURIComponent(cursor)}` : endpoint;
            const next = await getLeads(url);
            setPage((current) => ({ ...next, leads: [...(current?.leads ?? []), ...next.leads] }));
          })}>{t("Show more contacts")}</Button>}
        </section>
      </>}
    </div>
  );
}
