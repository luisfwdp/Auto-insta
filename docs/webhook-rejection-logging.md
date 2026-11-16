# Invalid webhook signature diagnostics

Every invalid or missing Meta webhook signature still receives HTTP 401 and is
never processed. Diagnostic database writes are coalesced to at most one event
per 60 seconds per warm application instance. Varying the body or signature does
not bypass this fixed reporting bucket. A failed diagnostic write also consumes
the window so an unavailable database cannot trigger repeated writes.

The first rejection retains its existing content-free correlation hash, length
and signature-presence flag. No token or raw body is persisted. Valid signed
webhooks are unaffected; this change does not modify signature verification.

This is a process-local limit, not a global ingress rate limit. Multiple warm
instances or cold starts can each record an event. It bounds amplification within
each instance without adding a Redis/database lookup to unauthenticated traffic.
Instance-wide ingress controls remain an infrastructure concern. Rollback is a
code revert; no database migration or data deletion is required.
