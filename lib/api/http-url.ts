import { z } from "zod";

/**
 * A URL a recipient's browser may open: http(s) only. `z.string().url()`
 * alone accepts javascript:, data:, file: and mailto: URLs, which end up as
 * DM button destinations (redirected by /r/) and as links on the public
 * report page.
 */
export const httpUrl = z
  .string()
  .url()
  .max(2048)
  .refine((value) => {
    try {
      const { protocol } = new URL(value);
      return protocol === "https:" || protocol === "http:";
    } catch {
      return false;
    }
  }, "URL must start with http:// or https://");
