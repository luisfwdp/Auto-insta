"use client";

import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { useI18n } from "@/lib/i18n/provider";

const workspaceId = z.string().min(1).max(200);
const workspace = z.object({ id: workspaceId, name: z.string(), role: z.enum(["OWNER", "ADMIN", "MEMBER"]) });
const selection = z.object({ activeWorkspaceId: workspaceId.nullable(), activeWorkspaceName: z.string().nullable(), workspaces: z.array(workspace) })
  .refine(value => new Set(value.workspaces.map(item => item.id)).size === value.workspaces.length
    && (value.activeWorkspaceId === null || value.workspaces.some(item => item.id === value.activeWorkspaceId)));
export type WorkspaceSelection = z.infer<typeof selection>;
export class WorkspaceSelectionError extends Error {
  constructor(readonly status: number) { super("Workspace selection unavailable"); }
}
type RequestOptions = { signal?: AbortSignal; fetcher?: typeof fetch };

/** The server membership list is the only source of options. No role is used
 * as client-side authority; selection is available to every actual member. */
export async function loadWorkspaceSelection({ signal, fetcher = fetch }: RequestOptions = {}): Promise<WorkspaceSelection | null> {
  const response = await fetcher("/api/workspace/selection", { credentials: "same-origin", cache: "no-store", redirect: "error", signal });
  if (response.status === 404) return null;
  if (!response.ok) throw new WorkspaceSelectionError(response.status);
  const parsed = z.object({ success: z.literal(true), data: selection }).safeParse(await response.json());
  if (!parsed.success) throw new WorkspaceSelectionError(503);
  return parsed.data.data;
}

export async function switchWorkspace(id: string, { signal, fetcher = fetch, navigate = (href: string) => window.location.assign(href) }:
  RequestOptions & { navigate?: (href: string) => void } = {}) {
  if (!workspaceId.safeParse(id).success || signal?.aborted) throw new WorkspaceSelectionError(400);
  const response = await fetcher("/api/workspace/selection", { method: "POST", credentials: "same-origin", cache: "no-store", redirect: "error", signal,
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ workspaceId: id }) });
  if (!response.ok) throw new WorkspaceSelectionError(response.status);
  const parsed = z.object({ success: z.literal(true), data: workspace }).safeParse(await response.json());
  if (!parsed.success || parsed.data.data.id !== id) throw new WorkspaceSelectionError(503);
  if (!signal?.aborted) navigate("/dashboard"); // Discard all tenant-scoped client caches/state.
}

export function WorkspaceOptions({ workspaces }: Pick<WorkspaceSelection, "workspaces">) {
  return <>{workspaces.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</>;
}

export function WorkspaceSwitcher() {
  const { t } = useI18n();
  const [data, setData] = useState<WorkspaceSelection | null>(null);
  const [phase, setPhase] = useState<"loading" | "hidden" | "ready" | "error" | "switching">("loading");
  const [changed, setChanged] = useState(false), [visible, setVisible] = useState(false);
  const controller = useRef<AbortController | null>(null), lock = useRef(false);
  const alive = () => controller.current !== null && !controller.current.signal.aborted;

  async function reload(signal = controller.current?.signal) {
    try {
      const value = await loadWorkspaceSelection({ signal });
      if (signal?.aborted) return;
      setData(value); setPhase(value === null ? "hidden" : "ready"); setVisible(value !== null);
    } catch { if (!signal?.aborted) { setData(null); setPhase("error"); setVisible(true); } }
  }
  useEffect(() => {
    const lifetime = new AbortController(); controller.current = lifetime;
    void reload(lifetime.signal);
    return () => lifetime.abort();
    // One membership lookup per mount; retry is an explicit user action.
  }, []);

  async function select(id: string) {
    if (lock.current || phase !== "ready" || id === data?.activeWorkspaceId) return;
    if (!data?.workspaces.some(item => item.id === id)) { setChanged(true); return; }
    lock.current = true; setPhase("switching"); setChanged(false);
    let completed = false;
    try { await switchWorkspace(id, { signal: controller.current?.signal }); completed = true; }
    catch (error) {
      if (!alive()) return;
      if (error instanceof WorkspaceSelectionError && error.status === 404) { await reload(); if (alive()) setChanged(true); }
      else { setData(null); setPhase("error"); }
    } finally { if (!completed) lock.current = false; }
  }
  if (phase === "hidden" || (phase === "loading" && !visible)) return null;
  return <div className="space-y-2 text-sm" aria-busy={phase === "loading" || phase === "switching"}>
    {phase === "error" ? <><p role="alert" className="text-xs text-red-300">{t("Could not load workspaces.")}</p><button type="button" className="text-xs text-[#C7FF2F] underline" onClick={() => {
      if (lock.current) return; lock.current = true; setPhase("loading"); setChanged(false);
      void reload().finally(() => { lock.current = false; });
    }}>{t("Try again")}</button></> : phase === "loading" ? <p role="status">{t("Loading workspaces")}</p> : data && data.workspaces.length > 0 ? <>
      <label className="block space-y-1"><span className="text-xs text-[#B5B5B5]">{t("Workspace")}</span>
        <select className="w-full rounded border border-[#494949] bg-[#0B0B0B] px-2 py-2 text-[#F5F5F5]" value={data.activeWorkspaceId ?? ""}
          disabled={phase === "switching" || data.workspaces.length < 2} onChange={event => void select(event.target.value)}>
          {data.activeWorkspaceId === null ? <option value="" disabled>{t("Choose a workspace")}</option> : null}
          <WorkspaceOptions workspaces={data.workspaces} />
        </select>
      </label>
      {phase === "switching" ? <p role="status" className="text-xs">{t("Switching workspace")}</p> : null}
    </> : null}
    {changed ? <p role="status" className="text-xs text-[#B5B5B5]">{t("Workspace access changed. Refresh the list.")}</p> : null}
  </div>;
}

export default WorkspaceSwitcher;
