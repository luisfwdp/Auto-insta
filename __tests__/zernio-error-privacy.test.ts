import { expect, it, vi } from "vitest";
vi.mock("@/lib/workspace-access", () => ({ getCurrentWorkspaceContext: async () => ({ workspaceId: "workspace", role: "OWNER" }), canManageWorkspace: () => true }));
import { withZernioManagement } from "../lib/zernio/route-handler";
import { MetaApiError } from "../lib/meta/client";
it.each([401, 402, 403, 429, 500])("keeps useful safe guidance for provider %s without echoing its secret-bearing message", async code => {
  const handler = withZernioManagement(async () => { throw new MetaApiError(code, undefined, undefined, "private-provider-key-fixture"); });
  const response = await handler(new Request("https://app.example/api/zernio/settings"));
  expect(response.status).toBe(502);
  const text = await response.text(); expect(text).not.toContain("private-provider-key-fixture");
  expect(text).toContain(code === 401 ? "invalid or expired" : code === 402 ? "Inbox access" : code === 403 ? "read-write" : "Could not configure Zernio");
});
