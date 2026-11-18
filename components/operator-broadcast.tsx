"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n/provider";

type Preview = { recipients: number; configured: boolean; lastSentAt: string | null };

/** Shown only to instance operators: the preview request answers 403 for everyone else. */
export default function OperatorBroadcast() {
  const { t } = useI18n();
  const [preview, setPreview] = useState<Preview | null>(null);
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [status, setStatus] = useState<{ kind: "success" | "error"; text: string } | null>(null);

  useEffect(() => {
    let active = true;
    fetch("/api/admin/broadcast")
      .then((response) => (response.ok ? response.json() : null))
      .then((body) => { if (active && body?.success) setPreview(body.data); })
      .catch(() => {});
    return () => { active = false; };
  }, []);

  if (!preview) return null;

  async function send() {
    if (!preview) return;
    const question = t("Send this email to every account holder? This cannot be undone.");
    if (!window.confirm(`${question} (${preview.recipients})`)) return;
    setSending(true);
    setStatus(null);
    try {
      const response = await fetch("/api/admin/broadcast", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subject, message, confirm: "SEND" }),
      });
      const body = await response.json().catch(() => null);
      if (response.ok && body?.success) {
        setStatus({ kind: "success", text: `${t("Email sent to all accounts.")} (${body.data.sent})` });
        setSubject("");
        setMessage("");
      } else if (response.status === 429) {
        setStatus({ kind: "error", text: t("A broadcast was sent less than 10 minutes ago. Wait before sending another.") });
      } else {
        setStatus({ kind: "error", text: t("The email could not be sent to everyone. Check the email provider settings.") });
      }
    } catch {
      setStatus({ kind: "error", text: t("The email could not be sent to everyone. Check the email provider settings.") });
    } finally {
      setSending(false);
    }
  }

  const ready = preview.configured && subject.trim().length >= 3 && message.trim().length >= 10 && !sending;

  return (
    <section className="panel rounded p-5" aria-labelledby="operator-broadcast-title">
      <h2 id="operator-broadcast-title" className="text-lg font-bold text-foreground">
        {t("Email all accounts")}
      </h2>
      <p className="mt-1 text-sm text-muted">
        {t("Sends one individual email to each verified account holder.")} ({preview.recipients})
      </p>
      {!preview.configured && (
        <p className="mt-3 text-sm text-warning" role="alert">
          {t("Email sending is not configured for this environment.")}
        </p>
      )}
      <label className="mt-4 block text-sm font-semibold text-foreground" htmlFor="broadcast-subject">
        {t("Email subject")}
      </label>
      <input
        id="broadcast-subject"
        className="mt-1 w-full rounded border border-border bg-surface px-3 py-2 text-sm text-foreground"
        value={subject}
        maxLength={150}
        onChange={(event) => setSubject(event.target.value)}
      />
      <label className="mt-4 block text-sm font-semibold text-foreground" htmlFor="broadcast-message">
        {t("Email message")}
      </label>
      <textarea
        id="broadcast-message"
        className="mt-1 h-40 w-full rounded border border-border bg-surface px-3 py-2 text-sm text-foreground"
        value={message}
        maxLength={5000}
        onChange={(event) => setMessage(event.target.value)}
      />
      <button
        type="button"
        onClick={() => void send()}
        disabled={!ready}
        aria-busy={sending || undefined}
        className="mt-4 rounded bg-accent px-4 py-2 text-sm font-semibold text-[#0B0B0B] transition disabled:opacity-50"
      >
        {t("Send to all accounts")}
      </button>
      {status && (
        <p className={`mt-3 text-sm ${status.kind === "success" ? "text-success" : "text-warning"}`} role="status">
          {status.text}
        </p>
      )}
    </section>
  );
}
