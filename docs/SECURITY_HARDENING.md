# Security hardening baseline

This document records the controls applied to the PING CHAT web application.

## Authentication abuse

- Magic-link requests are limited independently by client IP and normalized
  email address in a 15-minute Redis window.
- Rate-limit keys contain HMAC fingerprints, not raw IP addresses or emails.
- Unknown and blocked email addresses receive the same browser response as an
  allowed address, preventing account/allowlist enumeration.
- Redis failure fails the sign-in request closed instead of silently disabling
  the control.

## Browser and cross-origin controls

- Browser-originated API writes accept only the deployment's explicit origin.
  Server-to-server webhooks remain supported because they do not send an
  `Origin` header and are authenticated by their signature.
- The application never reflects arbitrary origins into CORS response headers.
- Global headers deny framing with both CSP `frame-ancestors 'none'` and
  `X-Frame-Options: DENY`, and also enable HSTS, `nosniff`, a restrictive
  permissions policy, and a safe referrer policy.

## Data minimization and tenant isolation

- Workspace-member responses use explicit field selection. Raw invitation
  tokens are never serialized, and pending invitation data is visible only to
  owners and administrators.
- Tenant-owned records continue to be selected with the server-derived
  `workspaceId`; client-supplied IDs are combined with that workspace scope.
- SQL uses Prisma's parameterized APIs/tagged templates. Unsafe raw query APIs
  are not used in the application.

## Session model

- PING CHAT has no password authentication and stores no password hashes.
- Auth.js uses opaque database sessions in secure cookies, not JWTs in URLs.
- Logout uses Auth.js `signOut`, which deletes the database session and clears
  the session cookie.
- URL tokens that remain are purpose-specific opaque invitation, verification,
  or analytics tokens; they are not authenticated session JWTs.

## Verification

The security regression suite covers rate limiting by both dimensions,
cross-origin write rejection without origin reflection, global response
headers, and invitation-token minimization. The existing workspace-isolation
tests cover cross-tenant reads and mutations.
