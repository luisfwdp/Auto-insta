const pulsoLink = /^https:\/\/catalogo\.pulsofinance\.app\/c\/p1\.[A-Za-z0-9_-]{1,360}\.[A-Za-z0-9_-]{86}$/;

export function safePulsoCheckoutUrl(value: unknown): string | null {
  return typeof value === "string" && value === value.trim() && pulsoLink.test(value) ? value : null;
}
