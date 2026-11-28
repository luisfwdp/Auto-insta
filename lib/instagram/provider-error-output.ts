import { MetaApiError } from "@/lib/meta/client";

// Provider messages and stack traces can include private request data.
export function instagramErrorCode(error: unknown): string {
  return error instanceof MetaApiError && Number.isSafeInteger(error.code)
    ? `INSTAGRAM_PROVIDER_${error.code}`
    : "INTERNAL_ERROR";
}
