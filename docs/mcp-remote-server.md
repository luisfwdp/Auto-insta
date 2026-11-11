# PING CHAT remote MCP server

The remote MCP endpoint lets ChatGPT, Claude, and other compatible hosts manage PING CHAT
campaign drafts, scheduled publications, and Speed Post batches without receiving Instagram
passwords or Meta access tokens.

## Production URLs

- MCP Streamable HTTP: `https://auto-insta-pi.vercel.app/api/mcp`
- Protected resource metadata: `https://auto-insta-pi.vercel.app/.well-known/oauth-protected-resource/mcp`
- Authorization server metadata: `https://auto-insta-pi.vercel.app/.well-known/oauth-authorization-server`

The deployment URL is derived from `NEXTAUTH_URL`; use the matching host in staging.

## Authentication and isolation

The server implements OAuth Authorization Code with PKCE `S256`, dynamic client
registration, rotating refresh tokens, and revocation. Access and refresh credentials are
opaque; only SHA-256 hashes are stored. During consent, the signed-in PING CHAT user chooses
one workspace. Every tool then derives `workspaceId` from the grant and revalidates current
membership and role before serving the request.

Available scopes:

| Scope | Access |
| --- | --- |
| `accounts:read` | List Instagram accounts in the selected workspace |
| `campaigns:read` | List campaign drafts and campaigns |
| `drafts:write` | Create and preview inactive campaign drafts (ADMIN/OWNER) |
| `publishing:read` | List private media, scheduled posts, history, and batches |
| `publishing:write` | Create posts/batches and manage batches (ADMIN/OWNER) |

Removing a membership or downgrading it to `MEMBER` removes write tools on the next call.
Revoked and expired grants/tokens return `401` with RFC 9728 resource metadata discovery.

## ChatGPT

In ChatGPT Plugins, add a custom MCP server and enter the `/api/mcp` URL. Choose OAuth when
prompted. ChatGPT discovers the authorization server, registers its public client, redirects
to PING CHAT for login/workspace consent, and completes PKCE. Keep approval enabled for every
write tool.

Reference: [OpenAI remote MCP documentation](https://developers.openai.com/api/docs/mcp).

## Claude

In Claude, open **Customize → Connectors → Add custom connector**, enter the `/api/mcp` URL,
and use the detected OAuth configuration. Each user signs in and chooses their own workspace;
do not configure a shared API-key header.

Reference: [Claude custom connector documentation](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp).

## Safety properties

- The MCP never exposes Meta tokens, media signed URLs, contact PII, or database credentials.
- Campaign creation persists an inactive draft and returns a PING CHAT approval URL.
- Publishing and Speed Post tools are declared as write actions; the host should request user
  approval before calling them.
- Trial Reels remain conditional on actual Meta/account eligibility.
- Inputs use the same Zod schemas and limits as the web application.
- Registration and token endpoints are rate-limited by IP through Redis.

## Validation before rollout

1. Apply the additive `20261111110000_add_mcp_oauth` migration through the reviewed production
   database workflow. Do not use `prisma db push`.
2. Verify both metadata endpoints and an unauthenticated `/api/mcp` response (`401` plus
   `WWW-Authenticate`).
3. Connect a PING CHAT test workspace in ChatGPT and Claude.
4. Confirm a read-only grant does not list write tools.
5. Create a campaign draft and verify it remains inactive.
6. Create one future scheduled publication and one Speed Post batch with authorized media.
7. Revoke the connector and confirm the following MCP call returns `401`.
