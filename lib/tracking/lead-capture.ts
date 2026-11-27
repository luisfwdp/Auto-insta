import "server-only";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { encryptToken, decryptToken } from "@/lib/meta/oauth";

const FORM_LIFETIME_SECONDS = 30 * 60;
const UUID = /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/;

export const leadContact = z.object({
  name: z.string().trim().min(2).max(120).refine((value) => !/\p{Cc}/u.test(value)),
  email: z.string().trim().max(254).email().transform((value) => value.toLowerCase()),
  phone: z.string().trim().max(30).regex(/^\+?[0-9 ()-]+$/)
    .refine((value) => /^[0-9]{8,15}$/.test(value.replace(/\D/g, ""))),
}).strict();

type LeadContact = z.infer<typeof leadContact>;

function signForm(slug: string, data: string) {
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) throw new Error("Lead form signing is unavailable");
  return createHmac("sha256", secret).update(`lead-form:v1:${slug}:${data}`).digest();
}

export function issueLeadFormToken(slug: string, now = Date.now()) {
  const expiresAt = Math.floor(now / 1000) + FORM_LIFETIME_SECONDS;
  const data = `${randomUUID()}.${expiresAt}`;
  return `${data}.${signForm(slug, data).toString("base64url")}`;
}

export function verifyLeadFormToken(slug: string, token: string, now = Date.now()) {
  const [id, expiry, signature, ...extra] = token.split(".");
  if (
    extra.length || !UUID.test(id) || !/^\d{10}$/.test(expiry ?? "")
    || !/^[A-Za-z0-9_-]{43}$/.test(signature ?? "")
    || Number(expiry) <= Math.floor(now / 1000)
  ) return null;
  const expected = signForm(slug, `${id}.${expiry}`);
  return timingSafeEqual(expected, Buffer.from(signature, "base64url")) ? id : null;
}

export function encryptLeadContact(contact: LeadContact) {
  return encryptToken(JSON.stringify(contact));
}

export function decryptLeadContact(ciphertext: string) {
  return leadContact.parse(JSON.parse(decryptToken(ciphertext)));
}
