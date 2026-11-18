import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { loadWorkspaceSelection, switchWorkspace, WorkspaceSwitcher, WorkspaceOptions, type WorkspaceSelection } from "@/components/workspace-switcher";

const options: WorkspaceSelection["workspaces"] = [
  { id: "workspace-a", name: "Original team", role: "MEMBER" },
  { id: "workspace-b", name: "Invited agency", role: "ADMIN" },
];
const list = { activeWorkspaceId: "workspace-b", activeWorkspaceName: "Invited agency", workspaces: options };
const response = (data: unknown) => Response.json({ success: true, data });

describe("workspace switcher backend contract", () => {
  it("loads exactly the server associations and the actual active workspace", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => response(list));
    expect(await loadWorkspaceSelection({ fetcher })).toEqual(list);
    expect(fetcher).toHaveBeenCalledExactlyOnceWith("/api/workspace/selection", expect.objectContaining({ credentials: "same-origin", cache: "no-store", redirect: "error" }));
  });
  it("hides the disabled feature on GET404 without parsing or displaying a backend error", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response("Not found", { status: 404 }));
    expect(await loadWorkspaceSelection({ fetcher })).toBeNull(); expect(fetcher).toHaveBeenCalledOnce();
    expect(renderToStaticMarkup(createElement(WorkspaceSwitcher))).toBe("");
  });
  it.each([401, 403, 503])("rejects HTTP%s without returning stale options or raw error details", async status => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ error: "private backend details" }, { status }));
    await expect(loadWorkspaceSelection({ fetcher })).rejects.toMatchObject({ status, message: "Workspace selection unavailable" });
  });
  it.each([
    { ...list, activeWorkspaceId: "foreign" },
    { ...list, workspaces: [options[0], options[0]] },
    { ...list, workspaces: [{ ...options[0], role: "INVALID" }] },
  ])("fails closed on inconsistent or malformed server memberships %#", async data => {
    await expect(loadWorkspaceSelection({ fetcher: async () => response(data) })).rejects.toMatchObject({ status: 503 });
  });
  it("drops fields outside the response allowlist", async () => {
    const value = await loadWorkspaceSelection({ fetcher: async () => response({ ...list, token: "secret", workspaces: options.map(item => ({ ...item, privateOwnerId: "private" })) }) });
    expect(value).toEqual(list); expect(JSON.stringify(value)).not.toContain("secret"); expect(JSON.stringify(value)).not.toContain("private");
  });
});

describe("explicit selection and cache isolation", () => {
  it("lets a MEMBER return to the original team and reloads only after server confirmation", async () => {
    let finish!: (response: Response) => void;
    const fetcher = vi.fn<typeof fetch>(() => new Promise(resolve => { finish = resolve; })), navigate = vi.fn();
    const pending = switchWorkspace("workspace-a", { fetcher, navigate });
    expect(navigate).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledWith("/api/workspace/selection", expect.objectContaining({ method: "POST", credentials: "same-origin", cache: "no-store", redirect: "error" }));
    expect(JSON.parse(fetcher.mock.calls[0][1]!.body as string)).toEqual({ workspaceId: "workspace-a" });
    finish(response(options[0])); await pending;
    expect(navigate).toHaveBeenCalledExactlyOnceWith("/dashboard");
  });
  it("does not navigate or retry automatically after revoked membership", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ success: false, error: "NOT_FOUND" }, { status: 404 })), navigate = vi.fn();
    await expect(switchWorkspace("workspace-a", { fetcher, navigate })).rejects.toMatchObject({ status: 404 });
    expect(fetcher).toHaveBeenCalledOnce(); expect(navigate).not.toHaveBeenCalled();
    const next = await loadWorkspaceSelection({ fetcher: async () => response({ ...list, workspaces: [options[1]] }) });
    expect(next?.workspaces.map(item => item.id)).toEqual(["workspace-b"]);
  });
  it("never navigates on a response naming another workspace", async () => {
    const navigate = vi.fn();
    await expect(switchWorkspace("workspace-a", { navigate, fetcher: async () => response(options[1]) })).rejects.toMatchObject({ status: 503 });
    expect(navigate).not.toHaveBeenCalled();
  });
  it("passes the lifetime abort signal and suppresses navigation if unmounted during the POST", async () => {
    const controller = new AbortController(), navigate = vi.fn();
    let finish!: (response: Response) => void;
    const fetcher = vi.fn<typeof fetch>(() => new Promise(resolve => { finish = resolve; }));
    const pending = switchWorkspace("workspace-a", { signal: controller.signal, fetcher, navigate });
    expect(fetcher.mock.calls[0][1]?.signal).toBe(controller.signal);
    controller.abort(); finish(response(options[0])); await pending;
    expect(navigate).not.toHaveBeenCalled();
  });
  it("does not POST invalid selections or requests already aborted", async () => {
    const fetcher = vi.fn(), navigate = vi.fn(), controller = new AbortController(); controller.abort();
    await expect(switchWorkspace("", { fetcher, navigate })).rejects.toMatchObject({ status: 400 });
    await expect(switchWorkspace("workspace-a", { fetcher, navigate, signal: controller.signal })).rejects.toMatchObject({ status: 400 });
    expect(fetcher).not.toHaveBeenCalled(); expect(navigate).not.toHaveBeenCalled();
  });
  it("renders workspace names as escaped text, preserving original team choices", () => {
    const html = renderToStaticMarkup(createElement(WorkspaceOptions, { workspaces: [
      { id: "a", name: '<img src=x onerror="alert(1)">', role: "MEMBER" }, options[1],
    ] }));
    expect(html).not.toContain("<img"); expect(html).toContain("&lt;img");
    expect(html).toContain("Invited agency"); expect(html).toContain('value="a"');
  });
});
