import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const state = vi.hoisted(() => ({ enabled: true, authenticated: true, role: "OWNER" }));
const commercial = vi.hoisted(() => ({ prepare: vi.fn(), confirm: vi.fn(), remove: vi.fn() }));
const old = vi.hoisted(() => ({ sign: vi.fn(), inspect: vi.fn(), remove: vi.fn(), create: vi.fn(), find: vi.fn(), update: vi.fn() }));
vi.mock("@/lib/billing/trial", () => ({ isBillingEnabled: () => state.enabled }));
vi.mock("@/lib/workspace-access", () => ({ getCurrentWorkspaceContext: async () => state.authenticated ? { workspaceId: "workspace_a", userId: "user_a", role: state.role } : null,
  canManageWorkspace: (role: string) => role === "OWNER" || role === "ADMIN" }));
vi.mock("@/lib/db/client", () => ({ prisma: { publishingAsset: { create: old.create, findFirst: old.find, update: old.update } } }));
vi.mock("@/lib/publishing/storage", async importOriginal => ({ ...await importOriginal<typeof import("../lib/publishing/storage")>(), createSignedUpload: old.sign, inspectPrivateObject: old.inspect, deletePrivateObject: old.remove }));
vi.mock("@/lib/billing/commercial-storage", async importOriginal => ({ ...await importOriginal<typeof import("../lib/billing/commercial-storage")>(), prepareCommercialMediaUpload: commercial.prepare,
  confirmCommercialMediaUpload: commercial.confirm, deleteCommercialMedia: commercial.remove }));
import { POST, PATCH, DELETE } from "../app/api/publishing/media/route";
import { CommercialStorageError } from "../lib/billing/commercial-storage";
const input = { filename: "image.jpg", mimeType: "image/jpeg", byteSize: 1 };
const asset = { id: "asset_a", workspaceId: "workspace_a", filename: "image.jpg", mimeType: "image/jpeg", mediaType: "IMAGE", byteSize: 1, storagePath: "workspace_a/asset_a.jpg", status: "UPLOADING", _count: { publications: 0 } };
const signedUpload = { uploadUrl: "https://storage.example.test/upload?token=fake", token: "fake" };
const req = (method: string, body?: unknown) => new NextRequest(`https://app.example.test/api/publishing/media${method === "DELETE" ? "?id=asset_a" : ""}`, { method,
  headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
beforeEach(() => {
  vi.clearAllMocks(); state.enabled = true; state.authenticated = true; state.role = "OWNER";
  commercial.prepare.mockResolvedValue({ asset, signedUpload }); commercial.confirm.mockResolvedValue({ valid: true, asset: { ...asset, status: "READY", byteSize: 500 } }); commercial.remove.mockResolvedValue(undefined);
  old.sign.mockResolvedValue(signedUpload); old.create.mockResolvedValue(asset); old.find.mockResolvedValue(asset); old.update.mockResolvedValue({ ...asset, status: "READY" });
  old.inspect.mockResolvedValue({ byteSize: 500, contentType: "image/jpeg", prefix: new Uint8Array([255,216,255]) }); old.remove.mockResolvedValue(undefined);
});
describe("publishing media commercial route", () => {
  it("delegates even one declared byte to capped admission and marks signed responses private/no-store", async () => {
    const response = await POST(req("POST", input)); expect(response.status).toBe(201);
    expect(commercial.prepare).toHaveBeenCalledWith("workspace_a", input); expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(old.sign).not.toHaveBeenCalled(); expect(old.create).not.toHaveBeenCalled();
  });
  it.each(["OWNER", "ADMIN"])("allows an authenticated %s but passes only the server-derived workspace", async role => {
    state.role = role; expect((await POST(req("POST", { ...input, workspaceId: "foreign_workspace" }))).status).toBe(201);
    expect(commercial.prepare).toHaveBeenCalledWith("workspace_a", input);
  });
  it("requires authentication and write role before any storage operations", async () => {
    state.authenticated = false; expect((await POST(req("POST", input))).status).toBe(401);
    state.authenticated = true; state.role = "MEMBER";
    for (const response of [await POST(req("POST", input)), await PATCH(req("PATCH", { id: asset.id })), await DELETE(req("DELETE"))]) expect(response.status).toBe(403);
    for (const operation of Object.values(commercial)) expect(operation).not.toHaveBeenCalled();
  });
  it("keeps failed validation in the commercial helper and never executes legacy deletion", async () => {
    commercial.confirm.mockResolvedValue({ valid: false }); const response = await PATCH(req("PATCH", { id: asset.id }));
    expect(response.status).toBe(400); expect(await response.json()).toMatchObject({ code: "UPLOAD_VALIDATION_FAILED" });
    expect(old.inspect).not.toHaveBeenCalled(); expect(old.remove).not.toHaveBeenCalled();
  });
  it("returns409 Retry-After while a READY upload token remains valid, preserving data", async () => {
    commercial.remove.mockRejectedValue(new CommercialStorageError("UPLOAD_TOKEN_STILL_VALID", 409, 3600));
    const response = await DELETE(req("DELETE")); expect(response.status).toBe(409); expect(response.headers.get("Retry-After")).toBe("3600");
    expect(old.remove).not.toHaveBeenCalled(); expect(old.update).not.toHaveBeenCalled();
  });
  it("keeps expired unconfirmed uploads held and returns an explicit recovery classification", async () => {
    commercial.remove.mockRejectedValue(new CommercialStorageError("UPLOAD_RECOVERY_REQUIRED", 409));
    const response = await DELETE(req("DELETE")); expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ code: "UPLOAD_RECOVERY_REQUIRED" }); expect(old.remove).not.toHaveBeenCalled();
  });
  it("scopes confirmation/deletion and preserves not-found errors for foreign media IDs", async () => {
    commercial.confirm.mockRejectedValue(new CommercialStorageError("MEDIA_NOT_FOUND", 404)); commercial.remove.mockRejectedValue(new CommercialStorageError("MEDIA_NOT_FOUND", 404));
    expect((await PATCH(req("PATCH", { id: "foreign_asset" }))).status).toBe(404); expect(commercial.confirm).toHaveBeenCalledWith("workspace_a", { id: "foreign_asset" });
    expect((await DELETE(new NextRequest("https://app.example.test/api/publishing/media?id=foreign_asset", { method: "DELETE" }))).status).toBe(404);
    expect(commercial.remove).toHaveBeenCalledWith("workspace_a", "foreign_asset");
  });
  it("does not expose provider response bodies or credentials in an unexpected commercial error", async () => {
    commercial.prepare.mockRejectedValue(new Error("fake-secret-key-and-signed-token")); const response = await POST(req("POST", input));
    expect(response.status).toBe(503); expect(JSON.stringify(await response.json())).not.toContain("fake-secret");
  });
  it("preserves the legacy POST contract and signing-before-create ordering when disabled", async () => {
    state.enabled = false; const response = await POST(req("POST", input)); expect(response.status).toBe(201);
    expect(old.sign).toHaveBeenCalledOnce(); expect(old.create).toHaveBeenCalledOnce(); expect(old.sign.mock.invocationCallOrder[0]).toBeLessThan(old.create.mock.invocationCallOrder[0]); expect(commercial.prepare).not.toHaveBeenCalled();
    expect(old.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ workspaceId: "workspace_a", byteSize: 1 }) }));
  });
  it("preserves legacy confirmation/deletion and does not query commercial storage", async () => {
    state.enabled = false; expect((await PATCH(req("PATCH", { id: asset.id }))).status).toBe(200); expect(old.inspect).toHaveBeenCalledWith(asset.storagePath);
    expect((await DELETE(req("DELETE"))).status).toBe(200); expect(old.remove).toHaveBeenCalledWith(asset.storagePath);
    expect(commercial.confirm).not.toHaveBeenCalled(); expect(commercial.remove).not.toHaveBeenCalled();
  });
});
