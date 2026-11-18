import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  context: vi.fn(), userFindUnique: vi.fn(), userFindMany: vi.fn(), userCount: vi.fn(),
  eventFindFirst: vi.fn(), eventCreate: vi.fn(),
}));
vi.mock("@/lib/workspace-access", () => ({ getCurrentWorkspaceContext: mocks.context }));
vi.mock("@/lib/db/client", () => ({ prisma: {
  user: { findUnique: mocks.userFindUnique, findMany: mocks.userFindMany, count: mocks.userCount },
  operationalEvent: { findFirst: mocks.eventFindFirst, create: mocks.eventCreate },
} }));

import { GET, POST } from "@/app/api/admin/broadcast/route";
import { textToHtml } from "@/lib/email/send";
import { welcomeMessage } from "@/lib/email/welcome";

const fetchMock = vi.fn();
const post = (body: unknown) => POST(new NextRequest("https://app.test/api/admin/broadcast", {
  method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" },
}));
const valid = { subject: "Aviso geral", message: "Olá a todos.\n\nNovidade no ar.", confirm: "SEND" };

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("OPERATOR_EMAILS", "op@example.test");
  vi.stubEnv("RESEND_API_KEY", "anonymous-key");
  vi.stubEnv("EMAIL_FROM", "CRIA PING <contato@example.test>");
  vi.stubEnv("EMAIL_REPLY_TO", "contato@example.test");
  mocks.context.mockResolvedValue({ userId: "user_op", workspaceId: "ws_1", role: "OWNER" });
  mocks.userFindUnique.mockResolvedValue({ email: "op@example.test" });
  mocks.userFindMany.mockResolvedValue([{ email: "a@example.test" }, { email: "b@example.test" }]);
  mocks.userCount.mockResolvedValue(2);
  mocks.eventFindFirst.mockResolvedValue(null);
  mocks.eventCreate.mockResolvedValue({});
  fetchMock.mockImplementation(async () => new Response(JSON.stringify({ data: [{ id: "1" }, { id: "2" }] })));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("operator broadcast email", () => {
  it("is closed to anonymous callers and to workspace owners who are not operators", async () => {
    mocks.context.mockResolvedValueOnce(null);
    expect((await GET()).status).toBe(401);
    mocks.userFindUnique.mockResolvedValueOnce({ email: "owner@example.test" });
    expect((await post(valid)).status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("previews the audience without sending", async () => {
    const body = await (await GET()).json();
    expect(body.data).toMatchObject({ recipients: 2, configured: true, lastSentAt: null });
    expect(mocks.userCount.mock.calls[0][0].where).toEqual({ email: { not: null }, emailVerified: { not: null } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires explicit confirmation and sane content", async () => {
    expect((await post({ ...valid, confirm: "yes" })).status).toBe(400);
    expect((await post({ ...valid, subject: "a" })).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends one message per verified user and records an audit event without addresses", async () => {
    const response = await post(valid);
    expect((await response.json()).data).toEqual({ sent: 2, failed: 0, errors: [] });

    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.resend.com/emails/batch");
    expect(options.headers.Authorization).toBe("Bearer anonymous-key");
    const sent = JSON.parse(options.body);
    expect(sent.map((email: { to: string }) => email.to)).toEqual(["a@example.test", "b@example.test"]);
    expect(sent[0]).toMatchObject({ from: "CRIA PING <contato@example.test>", reply_to: "contato@example.test", subject: "Aviso geral" });
    expect(sent[0]).not.toHaveProperty("cc");
    expect(sent[0]).not.toHaveProperty("bcc");

    const audit = JSON.stringify(mocks.eventCreate.mock.calls[0][0].data);
    expect(audit).toContain("user_op");
    expect(audit).not.toMatch(/a@example\.test|Novidade/);
  });

  it("refuses a second broadcast within ten minutes", async () => {
    mocks.eventFindFirst.mockResolvedValueOnce({ createdAt: new Date(Date.now() - 60_000) });
    expect((await post(valid)).status).toBe(429);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports provider failure instead of claiming delivery", async () => {
    fetchMock.mockImplementationOnce(async () => new Response(JSON.stringify({ message: "domain is not verified" }), { status: 403 }));
    const response = await post(valid);
    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body.success).toBe(false);
    expect(body.data).toMatchObject({ sent: 0, failed: 2 });
  });

  it("escapes operator text and builds the welcome message", () => {
    expect(textToHtml("<b>oi</b>\nlinha")).toBe("<p>&lt;b&gt;oi&lt;/b&gt;<br>linha</p>");
    const welcome = welcomeMessage("novo@example.test", "https://app.test", "contato@example.test");
    expect(welcome.subject).toContain("conta");
    expect(welcome.text).toContain("https://app.test");
    expect(welcome.text).toContain("contato@example.test");
  });
});
