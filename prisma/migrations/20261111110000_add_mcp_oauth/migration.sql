-- OAuth persistence for the remote PING CHAT MCP resource server.
-- All bearer credentials are stored as SHA-256 hashes, never plaintext.
CREATE TABLE "McpOAuthClient" (
  "id" TEXT NOT NULL,
  "clientId" TEXT NOT NULL,
  "clientName" TEXT NOT NULL,
  "redirectUris" JSONB NOT NULL,
  "tokenEndpointAuthMethod" TEXT NOT NULL DEFAULT 'none',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "McpOAuthClient_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "McpGrant" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "clientDbId" TEXT NOT NULL,
  "scopes" TEXT[],
  "revokedAt" TIMESTAMP(3),
  "lastUsedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "McpGrant_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "McpAuthorizationCode" (
  "id" TEXT NOT NULL,
  "codeHash" TEXT NOT NULL,
  "grantId" TEXT NOT NULL,
  "redirectUri" TEXT NOT NULL,
  "codeChallenge" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "McpAuthorizationCode_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "McpToken" (
  "id" TEXT NOT NULL,
  "grantId" TEXT NOT NULL,
  "accessTokenHash" TEXT NOT NULL,
  "refreshTokenHash" TEXT,
  "scopes" TEXT[],
  "accessExpiresAt" TIMESTAMP(3) NOT NULL,
  "refreshExpiresAt" TIMESTAMP(3),
  "revokedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "McpToken_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "McpOAuthClient_clientId_key" ON "McpOAuthClient"("clientId");
CREATE INDEX "McpGrant_userId_revokedAt_idx" ON "McpGrant"("userId", "revokedAt");
CREATE INDEX "McpGrant_workspaceId_revokedAt_idx" ON "McpGrant"("workspaceId", "revokedAt");
CREATE INDEX "McpGrant_clientDbId_revokedAt_idx" ON "McpGrant"("clientDbId", "revokedAt");
CREATE UNIQUE INDEX "McpAuthorizationCode_codeHash_key" ON "McpAuthorizationCode"("codeHash");
CREATE INDEX "McpAuthorizationCode_grantId_expiresAt_idx" ON "McpAuthorizationCode"("grantId", "expiresAt");
CREATE UNIQUE INDEX "McpToken_accessTokenHash_key" ON "McpToken"("accessTokenHash");
CREATE UNIQUE INDEX "McpToken_refreshTokenHash_key" ON "McpToken"("refreshTokenHash");
CREATE INDEX "McpToken_grantId_revokedAt_idx" ON "McpToken"("grantId", "revokedAt");
CREATE INDEX "McpToken_accessExpiresAt_idx" ON "McpToken"("accessExpiresAt");
CREATE INDEX "McpToken_refreshExpiresAt_idx" ON "McpToken"("refreshExpiresAt");

ALTER TABLE "McpGrant" ADD CONSTRAINT "McpGrant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "McpGrant" ADD CONSTRAINT "McpGrant_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "McpGrant" ADD CONSTRAINT "McpGrant_clientDbId_fkey" FOREIGN KEY ("clientDbId") REFERENCES "McpOAuthClient"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "McpAuthorizationCode" ADD CONSTRAINT "McpAuthorizationCode_grantId_fkey" FOREIGN KEY ("grantId") REFERENCES "McpGrant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "McpToken" ADD CONSTRAINT "McpToken_grantId_fkey" FOREIGN KEY ("grantId") REFERENCES "McpGrant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
