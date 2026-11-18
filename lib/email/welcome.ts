import { sendEmail, textToHtml, emailSettings } from "./send";

/** Confirmation that the account exists, sent once when the user is created. */
export function welcomeMessage(to: string, appUrl: string, contact: string | null) {
  const lines = [
    "Olá!",
    "Sua conta no CRIA PING foi criada com sucesso.",
    `Para começar, acesse ${appUrl} e conecte a sua conta profissional do Instagram.`,
    contact
      ? `Se precisar de ajuda, responda a este e-mail ou escreva para ${contact}.`
      : "Se precisar de ajuda, responda a este e-mail.",
    "Equipe CRIA PING",
  ];
  const text = lines.join("\n\n");
  return { to, subject: "Sua conta no CRIA PING foi criada", text, html: textToHtml(text) };
}

export async function sendWelcomeEmail(to: string | null | undefined) {
  if (!to) return;
  const appUrl = (process.env.NEXTAUTH_URL ?? process.env.AUTH_URL ?? "").replace(/\/$/, "");
  if (!appUrl) return;
  const result = await sendEmail(welcomeMessage(to, appUrl, emailSettings().replyTo));
  // Never block sign-up on email; the address is not logged.
  if (!result.ok) console.error("[Email] Welcome email was not sent:", result.error);
}
