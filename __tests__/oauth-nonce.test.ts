import { beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => new Map<string, string>());
vi.mock("@/lib/queue/client", () => ({
  getRedisConnection: () => ({
    set: vi.fn(async (k: string, v: string) => void store.set(k, v)),
    getdel: vi.fn(async (k: string) => {
      const v = store.get(k) ?? null;
      store.delete(k);
      return v;
    }),
  }),
}));

import { consumeOAuthNonce, rememberOAuthNonce } from "@/lib/meta/oauth-nonce";

describe("OAuth nonce store", () => {
  beforeEach(() => store.clear());

  it("consumes a nonce once, for the user it was issued to", async () => {
    await rememberOAuthNonce("n1", "user_1", 1800);
    expect(await consumeOAuthNonce("n1", "user_1")).toBe(true);
    expect(await consumeOAuthNonce("n1", "user_1")).toBe(false);
  });

  it("refuses another user and still burns the nonce", async () => {
    await rememberOAuthNonce("n2", "user_1", 1800);
    expect(await consumeOAuthNonce("n2", "user_2")).toBe(false);
    expect(await consumeOAuthNonce("n2", "user_1")).toBe(false);
  });

  it("stores only a hash of the nonce", async () => {
    await rememberOAuthNonce("secret-nonce", "user_1", 1800);
    expect([...store.keys()].join()).not.toContain("secret-nonce");
  });
});
