import { describe, expect, it } from "vitest";
import { BillingError } from "@/lib/billing/config";
import { MetaApiError, RateLimitError, TokenExpiredError } from "@/lib/meta/client";
import { ZernioDeliveryUnconfirmedError } from "@/lib/zernio/client";
import { classifySendError, DeliveryUnconfirmedError, isConfirmedSendRejection, isDeliveryUnconfirmed } from "@/lib/instagram/delivery-errors";

describe("commercial no-send classification", () => {
  it.each(["COMMERCIAL_ACCESS_REQUIRED", "COMMERCIAL_QUOTA_EXCEEDED", "COMMERCIAL_ACCOUNT_LIMIT", "USAGE_OPERATION_CONFLICT"])("preserves pre-dispatch %s without pretending it is a Meta rejection", code => {
    const error = new BillingError(code, 402);
    expect(classifySendError(error)).toBe(error);
    expect(isDeliveryUnconfirmed(error)).toBe(false);
    expect(isConfirmedSendRejection(error)).toBe(false);
  });
  it("preserves a post-dispatch uncertainty wrapper even when its cause was a BillingError", () => {
    const error = new DeliveryUnconfirmedError(new BillingError("PERSISTENCE_FAILURE"));
    expect(classifySendError(error)).toBe(error);
    expect(isDeliveryUnconfirmed(error)).toBe(true);
    expect(isConfirmedSendRejection(error)).toBe(false);
  });
});

describe("provider uncertainty stays fail-closed", () => {
  it.each([new Error("network response lost"), new MetaApiError(1, undefined, undefined, "unknown"),
    new MetaApiError(2, undefined, undefined, "transient"), new MetaApiError(500, undefined, undefined, "server failure")])("keeps an ambiguous provider outcome uncertain: %s", error => {
    const classified = classifySendError(error);
    expect(classified).toBeInstanceOf(DeliveryUnconfirmedError);
    expect(isDeliveryUnconfirmed(classified)).toBe(true);
    expect(classifySendError(classified)).toBe(classified);
  });
  it.each([new RateLimitError("rate limit"), new TokenExpiredError("expired token"),
    ...[10, 100, 200, 551].map(code => new MetaApiError(code, undefined, undefined, "rejected"))])("preserves explicit Meta rejection: %s", error => {
    expect(classifySendError(error)).toBe(error);
    expect(isConfirmedSendRejection(error)).toBe(true);
  });
  it("does not downgrade an uncertain Zernio outcome", () => {
    const error = new ZernioDeliveryUnconfirmedError();
    expect(classifySendError(error)).toBe(error);
    expect(isDeliveryUnconfirmed(error)).toBe(true);
    expect(isConfirmedSendRejection(error)).toBe(false);
  });
});
