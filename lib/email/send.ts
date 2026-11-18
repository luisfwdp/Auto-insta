/**
 * Transactional email through Resend's REST API (the same provider and key the
 * magic-link login already uses).
 * https://resend.com/docs/api-reference/emails/send-email
 * https://resend.com/docs/api-reference/emails/send-batch-emails
 */
const RESEND_API = "https://api.resend.com";
export const RESEND_BATCH_LIMIT = 100;

export type EmailMessage = { to: string; subject: string; text: string; html: string };
export type SendResult = { ok: true; ids: string[] } | { ok: false; error: string };

export function emailSettings(env: NodeJS.ProcessEnv = process.env) {
  return {
    apiKey: env.RESEND_API_KEY?.trim() || null,
    from: env.EMAIL_FROM?.trim() || null,
    // Where replies go: the contact mailbox on the product's own domain.
    replyTo: env.EMAIL_REPLY_TO?.trim() || null,
  };
}

export function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** Plain text written by a person, rendered as safe paragraphs. */
export function textToHtml(text: string) {
  return text
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${escapeHtml(paragraph.trim()).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

async function post(path: string, body: unknown, apiKey: string): Promise<SendResult> {
  try {
    const response = await fetch(`${RESEND_API}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await response.json().catch(() => null)) as
      | { id?: string; data?: Array<{ id?: string }>; message?: string }
      | null;
    if (!response.ok) {
      return { ok: false, error: `Resend ${response.status}: ${(data?.message ?? "request failed").slice(0, 200)}` };
    }
    const ids = data?.data ? data.data.map((item) => item.id ?? "") : data?.id ? [data.id] : [];
    return { ok: true, ids };
  } catch {
    return { ok: false, error: "Resend request could not be completed" };
  }
}

function payload(message: EmailMessage, from: string, replyTo: string | null) {
  return {
    from,
    to: message.to,
    subject: message.subject,
    text: message.text,
    html: message.html,
    ...(replyTo ? { reply_to: replyTo } : {}),
  };
}

export async function sendEmail(message: EmailMessage): Promise<SendResult> {
  const { apiKey, from, replyTo } = emailSettings();
  if (!apiKey || !from) return { ok: false, error: "Email is not configured (RESEND_API_KEY and EMAIL_FROM)" };
  return post("/emails", payload(message, from, replyTo), apiKey);
}

/** One message per recipient, so nobody sees anyone else's address. */
export async function sendEmailBatch(messages: EmailMessage[]): Promise<{ sent: number; failed: number; errors: string[] }> {
  const { apiKey, from, replyTo } = emailSettings();
  if (!apiKey || !from) return { sent: 0, failed: messages.length, errors: ["Email is not configured (RESEND_API_KEY and EMAIL_FROM)"] };
  let sent = 0;
  let failed = 0;
  const errors: string[] = [];
  for (let start = 0; start < messages.length; start += RESEND_BATCH_LIMIT) {
    const chunk = messages.slice(start, start + RESEND_BATCH_LIMIT);
    const result = await post("/emails/batch", chunk.map((message) => payload(message, from, replyTo)), apiKey);
    if (result.ok) sent += chunk.length;
    else {
      failed += chunk.length;
      if (!errors.includes(result.error)) errors.push(result.error);
    }
  }
  return { sent, failed, errors };
}
