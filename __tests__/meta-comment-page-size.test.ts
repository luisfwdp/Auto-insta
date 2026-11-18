import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getRecentMediaComments, MetaApiError } from "@/lib/meta/client";

const fetchMock = vi.fn();
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const tooMuch = () => json({ error: { code: 1, message: "Please reduce the amount of data you're asking for, then retry your request" } }, 500);
const comment = (id: string) => ({ id, text: "anon", timestamp: "2030-01-01T10:00:00+0000" });
const limitOf = (call: unknown[]) => new URL(String(call[0])).searchParams.get("limit");

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("META_GRAPH_API_VERSION", "v26.0");
  vi.stubEnv("INSTAGRAM_LOGIN_MODE", "unified");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("comment sweep page size", () => {
  it("retries the same page with a smaller limit when Meta asks for less data", async () => {
    fetchMock
      .mockResolvedValueOnce(tooMuch())
      .mockResolvedValueOnce(json({ data: [comment("c1")] }));

    const result = await getRecentMediaComments("anonymous-token", "media_test", 0);

    expect(result.map((c) => c.id)).toEqual(["c1"]);
    expect(fetchMock.mock.calls.map(limitOf)).toEqual(["50", "25"]);
    const retried = new URL(String(fetchMock.mock.calls[1][0]));
    expect(retried.pathname).toBe("/v26.0/media_test/comments");
    expect(retried.searchParams.get("order")).toBe("reverse_chronological");
  });

  it("keeps the cursor when shrinking a later page", async () => {
    const next = "https://graph.facebook.com/v26.0/media_test/comments?limit=50&after=CURSOR_A&access_token=anonymous-token";
    fetchMock
      .mockResolvedValueOnce(json({ data: [comment("c1")], paging: { next } }))
      .mockResolvedValueOnce(tooMuch())
      .mockResolvedValueOnce(tooMuch())
      .mockResolvedValueOnce(json({ data: [comment("c2")] }));

    const result = await getRecentMediaComments("anonymous-token", "media_test", 0);

    expect(result.map((c) => c.id)).toEqual(["c1", "c2"]);
    expect(fetchMock.mock.calls.slice(1).map(limitOf)).toEqual(["50", "25", "10"]);
    for (const call of fetchMock.mock.calls.slice(1)) {
      expect(new URL(String(call[0])).searchParams.get("after")).toBe("CURSOR_A");
    }
  });

  it("fails after the smallest page is still rejected", async () => {
    fetchMock.mockImplementation(async () => tooMuch());
    await expect(getRecentMediaComments("anonymous-token", "media_test", 0)).rejects.toBeInstanceOf(MetaApiError);
    expect(fetchMock.mock.calls.map(limitOf)).toEqual(["50", "25", "10"]);
  });

  it("does not retry other Meta errors", async () => {
    fetchMock.mockResolvedValueOnce(json({ error: { code: 190, message: "Anonymous expired token" } }, 400));
    await expect(getRecentMediaComments("anonymous-token", "media_test", 0)).rejects.toThrow("Anonymous expired token");
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
