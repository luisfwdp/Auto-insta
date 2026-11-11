import { randomBytes, timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db/client";
import {
  issueAuthorizationCode,
  resolveAuthorizationRequest,
  type McpScope,
} from "@/lib/mcp/oauth";

const CONSENT_COOKIE = "pingchat_mcp_consent";

function escapeHtml(value: string) {
  return value.replace(/[&<>'"]/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    '"': "&quot;",
  })[char]!);
}

function html(body: string, status = 200) {
  return new NextResponse(body, {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      "x-frame-options": "DENY",
      "x-content-type-options": "nosniff",
    },
  });
}

function redirectWithError(redirectUri: string, state: string, error: string) {
  const url = new URL(redirectUri);
  url.searchParams.set("error", error);
  url.searchParams.set("state", state);
  return NextResponse.redirect(url, { headers: { "cache-control": "no-store" } });
}

function authorizationInput(params: URLSearchParams | FormData) {
  const get = (name: string) => {
    const value = params.get(name);
    return typeof value === "string" ? value : "";
  };
  return {
    response_type: get("response_type"),
    client_id: get("client_id"),
    redirect_uri: get("redirect_uri"),
    code_challenge: get("code_challenge"),
    code_challenge_method: get("code_challenge_method"),
    state: get("state"),
    scope: get("scope"),
    resource: get("resource") || undefined,
  };
}

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    const login = new URL("/login", request.url);
    login.searchParams.set("callbackUrl", request.nextUrl.pathname + request.nextUrl.search);
    return NextResponse.redirect(login);
  }
  let resolved;
  try {
    resolved = await resolveAuthorizationRequest(authorizationInput(request.nextUrl.searchParams));
  } catch {
    return html("<h1>Solicitação OAuth inválida</h1>", 400);
  }
  const memberships = await prisma.workspaceMember.findMany({
    where: { userId: session.user.id },
    include: { workspace: { select: { id: true, name: true } } },
    orderBy: { createdAt: "asc" },
  });
  if (memberships.length === 0) return html("<h1>Nenhum workspace disponível</h1>", 403);
  const nonce = randomBytes(32).toString("base64url");
  const requestFields = Object.entries(resolved.request)
    .filter(([, value]) => value !== undefined)
    .map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(String(value))}">`)
    .join("");
  const options = memberships.map((membership) =>
    `<option value="${escapeHtml(membership.workspace.id)}">${escapeHtml(membership.workspace.name)} — ${membership.role}</option>`
  ).join("");
  const scopes = resolved.scopes.map((scope) => `<li>${escapeHtml(scope)}</li>`).join("");
  const response = html(`<!doctype html><html lang="pt-BR"><head><meta name="viewport" content="width=device-width"><title>Conectar ao PING CHAT</title><style>body{background:#0b0b0b;color:#f5f5f5;font:16px system-ui;margin:0;padding:32px}.card{max-width:620px;margin:auto;background:#1a1a1a;padding:28px;border-radius:16px}h1{margin-top:0}label{display:block;margin:20px 0 8px}select,button{font:inherit;padding:12px;border-radius:8px;width:100%}button{margin-top:12px;border:0;background:#c7ff2f;color:#0b0b0b;font-weight:700}.deny{background:#333;color:#fff}</style></head><body><main class="card"><h1>Conectar ${escapeHtml(resolved.client.clientName)}</h1><p>Escolha o workspace que o ChatGPT ou Claude poderá acessar.</p><ul>${scopes}</ul><form method="post">${requestFields}<input type="hidden" name="consent_nonce" value="${nonce}"><label for="workspace_id">Workspace</label><select id="workspace_id" name="workspace_id">${options}</select><button name="decision" value="approve">Autorizar conexão</button><button class="deny" name="decision" value="deny">Cancelar</button></form></main></body></html>`);
  response.cookies.set(CONSENT_COOKIE, nonce, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/api/mcp/oauth/authorize",
    maxAge: 600,
  });
  return response;
}

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) return html("<h1>Sessão expirada</h1>", 401);
  const form = await request.formData().catch(() => null);
  if (!form) return html("<h1>Solicitação inválida</h1>", 400);
  const cookieNonce = request.cookies.get(CONSENT_COOKIE)?.value ?? "";
  const formNonce = String(form.get("consent_nonce") ?? "");
  const left = Buffer.from(cookieNonce);
  const right = Buffer.from(formNonce);
  if (!left.length || left.length !== right.length || !timingSafeEqual(left, right)) {
    return html("<h1>Consentimento expirado</h1>", 400);
  }
  let resolved;
  try {
    resolved = await resolveAuthorizationRequest(authorizationInput(form));
  } catch {
    return html("<h1>Solicitação OAuth inválida</h1>", 400);
  }
  if (form.get("decision") !== "approve") {
    return redirectWithError(resolved.request.redirect_uri, resolved.request.state, "access_denied");
  }
  try {
    const code = await issueAuthorizationCode({
      userId: session.user.id,
      workspaceId: String(form.get("workspace_id") ?? ""),
      clientId: resolved.request.client_id,
      redirectUri: resolved.request.redirect_uri,
      codeChallenge: resolved.request.code_challenge,
      scopes: resolved.scopes as McpScope[],
    });
    const target = new URL(resolved.request.redirect_uri);
    target.searchParams.set("code", code);
    target.searchParams.set("state", resolved.request.state);
    const response = NextResponse.redirect(target, { headers: { "cache-control": "no-store" } });
    response.cookies.delete(CONSENT_COOKIE);
    return response;
  } catch (error) {
    const code = error instanceof Error && error.message === "insufficient_role"
      ? "access_denied"
      : "server_error";
    return redirectWithError(resolved.request.redirect_uri, resolved.request.state, code);
  }
}
