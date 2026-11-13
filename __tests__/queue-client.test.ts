import { describe, expect, it } from "vitest";
import { redisOptionsFromUrl } from "@/lib/queue/client";

describe("redisOptionsFromUrl", () => {
  it("parses a secure Redis URL without Node's legacy url.parse", () => {
    expect(redisOptionsFromUrl("rediss://default:p%40ss@example.upstash.io:6380/2?family=6")).toEqual({
      host: "example.upstash.io",
      port: 6380,
      username: "default",
      password: "p@ss",
      db: 2,
      family: 6,
      tls: {},
      maxRetriesPerRequest: null,
    });
  });

  it("uses safe defaults and rejects unrelated protocols", () => {
    expect(redisOptionsFromUrl("redis://localhost")).toMatchObject({
      host: "localhost",
      port: 6379,
      maxRetriesPerRequest: null,
    });
    expect(() => redisOptionsFromUrl("https://example.com")).toThrow(
      "REDIS_URL must use redis:// or rediss://"
    );
  });
});
