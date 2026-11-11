import { describe, expect, it } from "vitest";
import { createRepeatedErrorThrottle } from "@/lib/ops/repeated-error-throttle";

describe("createRepeatedErrorThrottle", () => {
  it("reports an identical process error at most once per window", () => {
    const shouldReport = createRepeatedErrorThrottle(60_000);

    expect(shouldReport("redis quota exceeded", 1_000)).toBe(true);
    expect(shouldReport("redis quota exceeded", 1_001)).toBe(false);
    expect(shouldReport("redis quota exceeded", 60_999)).toBe(false);
    expect(shouldReport("redis quota exceeded", 61_000)).toBe(true);
  });

  it("reports a changed error immediately", () => {
    const shouldReport = createRepeatedErrorThrottle(60_000);

    expect(shouldReport("redis quota exceeded", 1_000)).toBe(true);
    expect(shouldReport("connection reset", 1_001)).toBe(true);
  });
});
