import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkManualDmRateLimit,
  MANUAL_DM_RATE_LIMIT,
} from "@/lib/api/manual-dm-rate-limit";

const savedSecret = process.env.NEXTAUTH_SECRET;

beforeEach(() => {
  process.env.NEXTAUTH_SECRET = "manual-dm-test-secret";
});

afterEach(() => {
  if (savedSecret === undefined) delete process.env.NEXTAUTH_SECRET;
  else process.env.NEXTAUTH_SECRET = savedSecret;
});

describe("manual DM rate limiting", () => {
  it("allows sends through the configured limit and then returns the Redis TTL", async () => {
    let count = 0;
    const redis = {
      eval: async () => {
        count += 1;
        return [count, 321];
      },
    };
    const input = {
      workspaceId: "workspace_1",
      instagramAccountId: "account_1",
      redis: redis as never,
    };

    for (let attempt = 0; attempt < MANUAL_DM_RATE_LIMIT.sends; attempt += 1) {
      await expect(checkManualDmRateLimit(input)).resolves.toEqual({ allowed: true });
    }
    await expect(checkManualDmRateLimit(input)).resolves.toEqual({
      allowed: false,
      retryAfter: 321,
    });
  });

  it("does not put tenant or account identifiers in the Redis key", async () => {
    let key = "";
    const redis = {
      eval: async (_script: string, _keys: number, receivedKey: string) => {
        key = receivedKey;
        return [1, 900];
      },
    };

    await checkManualDmRateLimit({
      workspaceId: "sensitive_workspace",
      instagramAccountId: "sensitive_account",
      redis: redis as never,
    });

    expect(key).toMatch(/^api:manual-dm:[a-f0-9]{64}$/);
    expect(key).not.toContain("sensitive");
  });
});
