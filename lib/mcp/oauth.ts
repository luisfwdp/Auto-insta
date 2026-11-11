import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";

import type { WorkspaceRole } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/db/client";

export const MCP_SCOPES = [
  "accounts:read",
  "campaigns:read",
  "drafts:write",
  "publishing:read",
  "publishing:write",
] as const;
export type McpScope = (typeof MCP_SCOPES)[number];

export const MCP_ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
export const MCP_REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
export const MCP_AUTH_CODE_TTL_SECONDS = 5 * 60;

export type McpAuthContext = {
  grantId: string;
  userId: string;
  workspaceId: string;
  role: WorkspaceRole;
  scopes: Set<McpScope>;
};

const redirectUriSchema = z.string().url().superRefine((value, ctx) => {
  const url = new URL(value);
  const local = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    ctx.addIssue({ code: "custom", message: "Redirect URI must use HTTPS" });
  }
  if (url.username || url.password || url.hash) {
    ctx.addIssue({ code: "custom", message: "Redirect URI cannot contain credentials or a fragment" });
  }
});

export const dynamicClientSchema = z.object({
  client_name: z.string().trim().min(1).max(100),
  redirect_uris: z.array(redirectUriSchema).min(1).max(10),
  token_endpoint_auth_method: z.literal("none").default("none"),
  grant_types: z.array(z.enum(["authorization_code", "refresh_token"])).optional(),
  response_types: z.array(z.literal("code")).optional(),
});

export const authorizationRequestSchema = z.object({
  response_type: z.literal("code"),
  client_id: z.string().min(1).max(255),
  redirect_uri: redirectUriSchema,
  code_challenge: z.string().regex(/^[A-Za-z0-9_-]{43,128}$/),
  code_challenge_method: z.literal("S256"),
  state: z.string().min(1).max(2048),
  scope: z.string().max(500).default("accounts:read campaigns:read publishing:read"),
  resource: z.string().url().optional(),
});

export function hashCredential(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export function createOpaqueCredential(prefix: "pc_code" | "pc_at" | "pc_rt" | "pc_client") {
  return `${prefix}_${randomBytes(32).toString("base64url")}`;
}

export function verifyPkce(codeVerifier: string, expectedChallenge: string) {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(codeVerifier)) return false;
  const actual = createHash("sha256").update(codeVerifier).digest("base64url");
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expectedChallenge);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

export function parseScopes(value: string): McpScope[] {
  const requested = [...new Set(value.split(/\s+/).filter(Boolean))];
  if (requested.length === 0 || requested.some((scope) => !MCP_SCOPES.includes(scope as McpScope))) {
    throw new Error("invalid_scope");
  }
  return requested as McpScope[];
}

export function publicMcpBaseUrl() {
  const base = process.env.NEXTAUTH_URL?.replace(/\/$/, "");
  if (!base) throw new Error("NEXTAUTH_URL is required for MCP OAuth");
  return base;
}

export async function registerMcpClient(input: z.infer<typeof dynamicClientSchema>) {
  const parsed = dynamicClientSchema.parse(input);
  const clientId = createOpaqueCredential("pc_client");
  return prisma.mcpOAuthClient.create({
    data: {
      clientId,
      clientName: parsed.client_name,
      redirectUris: parsed.redirect_uris,
      tokenEndpointAuthMethod: "none",
    },
    select: { clientId: true, clientName: true, redirectUris: true, createdAt: true },
  });
}

export async function resolveAuthorizationRequest(input: unknown) {
  const request = authorizationRequestSchema.parse(input);
  const client = await prisma.mcpOAuthClient.findUnique({ where: { clientId: request.client_id } });
  const redirects = Array.isArray(client?.redirectUris) ? client.redirectUris : [];
  if (!client || !redirects.includes(request.redirect_uri)) throw new Error("invalid_client");
  const scopes = parseScopes(request.scope);
  return { request, client, scopes };
}

export async function issueAuthorizationCode(input: {
  userId: string;
  workspaceId: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: McpScope[];
}) {
  const [membership, client] = await Promise.all([
    prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId: input.workspaceId, userId: input.userId } },
      select: { role: true },
    }),
    prisma.mcpOAuthClient.findUnique({ where: { clientId: input.clientId } }),
  ]);
  if (!membership) throw new Error("workspace_not_authorized");
  if (!client) throw new Error("invalid_client");
  if ((input.scopes.includes("drafts:write") || input.scopes.includes("publishing:write")) && membership.role === "MEMBER") {
    throw new Error("insufficient_role");
  }
  const redirects = Array.isArray(client.redirectUris) ? client.redirectUris : [];
  if (!redirects.includes(input.redirectUri)) throw new Error("invalid_redirect_uri");

  const code = createOpaqueCredential("pc_code");
  await prisma.$transaction(async (tx) => {
    const grant = await tx.mcpGrant.create({
      data: {
        userId: input.userId,
        workspaceId: input.workspaceId,
        clientDbId: client.id,
        scopes: input.scopes,
      },
    });
    await tx.mcpAuthorizationCode.create({
      data: {
        codeHash: hashCredential(code),
        grantId: grant.id,
        redirectUri: input.redirectUri,
        codeChallenge: input.codeChallenge,
        expiresAt: new Date(Date.now() + MCP_AUTH_CODE_TTL_SECONDS * 1000),
      },
    });
  });
  return code;
}

export async function exchangeAuthorizationCode(input: {
  code: string;
  clientId: string;
  redirectUri: string;
  codeVerifier: string;
}) {
  return prisma.$transaction(async (tx) => {
    const record = await tx.mcpAuthorizationCode.findUnique({
      where: { codeHash: hashCredential(input.code) },
      include: { grant: { include: { client: true } } },
    });
    if (!record || record.consumedAt || record.expiresAt <= new Date()) throw new Error("invalid_grant");
    if (record.grant.revokedAt || record.grant.client.clientId !== input.clientId || record.redirectUri !== input.redirectUri) {
      throw new Error("invalid_grant");
    }
    if (!verifyPkce(input.codeVerifier, record.codeChallenge)) throw new Error("invalid_grant");
    const consumed = await tx.mcpAuthorizationCode.updateMany({
      where: { id: record.id, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    if (consumed.count !== 1) throw new Error("invalid_grant");

    const accessToken = createOpaqueCredential("pc_at");
    const refreshToken = createOpaqueCredential("pc_rt");
    await tx.mcpToken.create({
      data: {
        grantId: record.grantId,
        accessTokenHash: hashCredential(accessToken),
        refreshTokenHash: hashCredential(refreshToken),
        scopes: record.grant.scopes,
        accessExpiresAt: new Date(Date.now() + MCP_ACCESS_TOKEN_TTL_SECONDS * 1000),
        refreshExpiresAt: new Date(Date.now() + MCP_REFRESH_TOKEN_TTL_SECONDS * 1000),
      },
    });
    return { accessToken, refreshToken, scopes: record.grant.scopes };
  });
}

export async function authenticateMcpBearer(authorization: string | null): Promise<McpAuthContext | null> {
  const match = authorization?.match(/^Bearer ([A-Za-z0-9_-]{40,})$/);
  if (!match) return null;
  const token = await prisma.mcpToken.findUnique({
    where: { accessTokenHash: hashCredential(match[1]) },
    include: { grant: true },
  });
  if (!token || token.revokedAt || token.accessExpiresAt <= new Date() || token.grant.revokedAt) return null;
  const membership = await prisma.workspaceMember.findUnique({
    where: {
      workspaceId_userId: {
        workspaceId: token.grant.workspaceId,
        userId: token.grant.userId,
      },
    },
    select: { role: true },
  });
  if (!membership) return null;
  await prisma.mcpGrant.update({ where: { id: token.grantId }, data: { lastUsedAt: new Date() } });
  return {
    grantId: token.grantId,
    userId: token.grant.userId,
    workspaceId: token.grant.workspaceId,
    role: membership.role,
    scopes: new Set(token.scopes as McpScope[]),
  };
}

export async function exchangeRefreshToken(input: { refreshToken: string; clientId: string }) {
  return prisma.$transaction(async (tx) => {
    const previous = await tx.mcpToken.findUnique({
      where: { refreshTokenHash: hashCredential(input.refreshToken) },
      include: { grant: { include: { client: true } } },
    });
    if (!previous || previous.revokedAt || previous.grant.revokedAt ||
      !previous.refreshExpiresAt || previous.refreshExpiresAt <= new Date() ||
      previous.grant.client.clientId !== input.clientId) {
      throw new Error("invalid_grant");
    }
    const revoked = await tx.mcpToken.updateMany({
      where: { id: previous.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (revoked.count !== 1) throw new Error("invalid_grant");
    const accessToken = createOpaqueCredential("pc_at");
    const refreshToken = createOpaqueCredential("pc_rt");
    await tx.mcpToken.create({
      data: {
        grantId: previous.grantId,
        accessTokenHash: hashCredential(accessToken),
        refreshTokenHash: hashCredential(refreshToken),
        scopes: previous.scopes,
        accessExpiresAt: new Date(Date.now() + MCP_ACCESS_TOKEN_TTL_SECONDS * 1000),
        refreshExpiresAt: new Date(Date.now() + MCP_REFRESH_TOKEN_TTL_SECONDS * 1000),
      },
    });
    return { accessToken, refreshToken, scopes: previous.scopes };
  });
}

export async function revokeMcpToken(rawToken: string) {
  const hash = hashCredential(rawToken);
  await prisma.mcpToken.updateMany({
    where: {
      OR: [{ accessTokenHash: hash }, { refreshTokenHash: hash }],
      revokedAt: null,
    },
    data: { revokedAt: new Date() },
  });
}
