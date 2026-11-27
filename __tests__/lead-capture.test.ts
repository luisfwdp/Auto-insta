import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findLink: vi.fn(), click: vi.fn(), createLeads: vi.fn(), limit: vi.fn(),
}));
vi.mock("@/lib/db/client", () => ({
  prisma: {
    trackedLink: { findUnique: mocks.findLink },
    linkClick: { create: mocks.click },
    campaignLead: { createMany: mocks.createLeads },
  },
}));
vi.mock("@/lib/api/request-rate-limit", () => ({ consumeRequestLimit: mocks.limit }));

import { GET, POST } from "@/app/r/[slug]/route";
import { metadata as formMetadata } from "@/app/material/[slug]/page";
import { decryptLeadContact, issueLeadFormToken, verifyLeadFormToken } from "@/lib/tracking/lead-capture";

const slug = "demo_link";
const origin = "https://app.example";
const url = `${origin}/r/${slug}`;
const destinationUrl = "https://downloads.example/guide.pdf";
const route = { params: Promise.resolve({ slug }) };
const contact = { name: "Ana Teste", email: "Ana@example.com", phone: "+55 (41) 99999-0000" };
const link = {
  id: "link1", workspaceId: "ws1", automationId: "campaign1", requireLead: true, destinationUrl,
  automation: { isActive: true, workspaceId: "ws1", instagramAccountId: "account1", instagramAccount: { workspaceId: "ws1" } },
};

function submit(form = new URLSearchParams({ ...contact, token: issueLeadFormToken(slug) }), sender = origin) {
  return POST(new NextRequest(url, { method: "POST", headers: { origin: sender }, body: form }), route);
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("NEXTAUTH_SECRET", "publicly-fake-test-secret");
  vi.stubEnv("ENCRYPTION_KEY", "12".repeat(32));
  mocks.findLink.mockResolvedValue(link);
  mocks.limit.mockResolvedValue({ allowed: true, retryAfter: 600 });
  mocks.createLeads.mockResolvedValue({ count: 1 });
});
afterEach(() => vi.unstubAllEnvs());

describe("tracked-link lead capture", () => {
  it("uses a document policy that preserves Origin on the native same-origin POST", () => {
    expect(formMetadata.referrer).toBe("same-origin");
  });

  it("sends opt-in links to the form without revealing the destination", async () => {
    const response = await GET(new NextRequest(`${url}?r=${"a".repeat(22)}`), route);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(`${origin}/material/${slug}`);
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(mocks.click).toHaveBeenCalledOnce();
  });

  it("preserves the original redirect when capture is disabled", async () => {
    mocks.findLink.mockResolvedValue({ ...link, requireLead: false });
    const response = await GET(new NextRequest(url), route);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(destinationUrl);
  });

  it("stores encrypted contacts, then redirects, and reuses the submission ID on retry", async () => {
    const token = issueLeadFormToken(slug);
    const form = new URLSearchParams({ ...contact, token });
    for (const response of [await submit(form), await submit(form)]) {
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe(destinationUrl);
      expect(response.headers.get("cache-control")).toContain("no-store");
    }
    expect(mocks.createLeads.mock.calls[0][0]).toMatchObject({
      skipDuplicates: true,
      data: { id: verifyLeadFormToken(slug, token), workspaceId: "ws1", automationId: "campaign1", sourceLinkId: "link1" },
    });
    expect(mocks.createLeads.mock.calls[0][0].data.id).toBe(mocks.createLeads.mock.calls[1][0].data.id);
    const encrypted = mocks.createLeads.mock.calls[0][0].data.contactCiphertext;
    expect(encrypted).not.toContain(contact.name);
    expect(decryptLeadContact(encrypted)).toEqual({ ...contact, email: "ana@example.com" });
  });

  it("rejects cross-origin submissions before persistence", async () => {
    const response = await submit(undefined, "https://untrusted.example");
    expect(response.status).toBe(403);
    expect(mocks.limit).not.toHaveBeenCalled();
    expect(mocks.createLeads).not.toHaveBeenCalled();
  });

  it("rejects a missing phone, an expired token and a token issued for another link", async () => {
    for (const form of [
      new URLSearchParams({ ...contact, phone: "", token: issueLeadFormToken(slug) }),
      new URLSearchParams({ ...contact, token: issueLeadFormToken(slug, Date.now() - 31 * 60_000) }),
      new URLSearchParams({ ...contact, token: issueLeadFormToken("different_link") }),
    ]) {
      const response = await submit(form);
      expect(response.headers.get("location")).toMatch(/^https:\/\/app\.example\/material\/demo_link\?status=(invalid|expired)$/);
    }
    expect(mocks.createLeads).not.toHaveBeenCalled();
  });

  it("denies a paused campaign, a disabled gate and a mismatched tenant", async () => {
    for (const candidate of [
      { ...link, requireLead: false },
      { ...link, automation: { ...link.automation, isActive: false } },
      { ...link, automation: { ...link.automation, workspaceId: "another-workspace" } },
    ]) {
      mocks.findLink.mockResolvedValue(candidate);
      expect((await submit()).status).toBe(404);
    }
    expect(mocks.createLeads).not.toHaveBeenCalled();
  });

  it("keeps the destination private when the rate limiter or persistence fails", async () => {
    mocks.limit.mockResolvedValueOnce({ allowed: false, retryAfter: 50 }).mockRejectedValueOnce(new Error("redis"));
    expect((await submit()).headers.get("location")).toContain("status=limit");
    expect((await submit()).headers.get("location")).toContain("status=unavailable");
    expect(mocks.createLeads).not.toHaveBeenCalled();
    mocks.createLeads.mockRejectedValueOnce(new Error("database"));
    expect((await submit()).headers.get("location")).toContain("status=unavailable");
  });
});
