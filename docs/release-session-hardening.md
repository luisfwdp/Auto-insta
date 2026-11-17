# Session confidentiality and publishing accessibility

A local end-to-end test with a real Auth.js database session reproduced the
session endpoint exposing its own database bearer token and internal adapter
fields. No production credential was read or included in the test. The existing
custom callback returned the whole adapter session, replacing Auth.js's default
public-field filter. The callback now constructs a fresh allowlisted DTO:
expires and user.id/name/email/image. Server workspace guards retain user.id.
No session is deleted, no schema changes and no authentication bypass is added.

Auth.js documents that the session callback return value is exposed to clients:
https://authjs.dev/reference/core#callbacks

A real HTTP/database recovery test also found a resumed batch retaining its old
failed-item count and completion timestamp. HTTP and MCP now clear those fields
in the same transaction that resets failed children, preserving published items
and idempotency keys. Disposable PostgreSQL regressions cover both paths.

The same browser test found an unlabeled file input, a calendar scroll region
that could not receive keyboard focus, and a generic element with a prohibited
aria-label used for progress. The input now has the existing translated upload
label; the calendar is a named keyboard-focusable region; progress uses a named
progressbar with numeric bounds/value. Layout and publishing behavior are unchanged.

Validation includes callback regression tests plus a local browser → real HTTP
→ Prisma → disposable PostgreSQL flow with valid fixture sessions and READY media
metadata. It checks scheduling/timezone/month boundary/edit/cancel, 100-item
batches and the101-item cap, captions, pause/resume/cancel, workspace/RBAC/Origin
rejections, session JSON and mobile accessibility. These fixtures do not prove
media upload, real Meta delivery or execution of a production worker.

Rollback is a reviewed code revert with no migration. Retain the session DTO
security fix and dependency patches when reverting unrelated UI behavior.
Authentication changes require specific human approval under AGENTS.md.

The analytics SDK also accepts the concrete pathname, even when its route is
normalized. The client beforeSend hook now drops invitation URLs entirely and
strips all query parameters/fragments on other page views and custom events;
malformed or credential-bearing URLs are dropped. No external analytics capture
or prior compromise is claimed. Tests use fake markers only. Official hook:
https://vercel.com/docs/analytics/package#beforesend
