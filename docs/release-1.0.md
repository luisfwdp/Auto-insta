# CRIA PING 1.0 — consolidated release candidate

Use PR #93 as the single integration package for PRs #80–#92. Do not merge the
individual PRs after their changes are incorporated. Close them as incorporated
only after a human merges the reviewed package and verifies the final main tree.
The PR description identifies the exact reviewed head and CI run.

## Release contents and compatibility

The package includes workspace invitation role/CAS protection, bounded webhook
diagnostics, publishing cancellation and recovery, immutable container content,
chronological Speed Post slots and atomic retry progress, Story text-reply UI,
and interactive Instagram account subscription fields. The latest automatic
signup and diagnostic timeout regressions are included, not only the older
composition. Next.js and eslint-config-next are pinned to 16.4.6; the existing
ESLint/minimatch security fix is retained.

Web and worker use Node 24 and the same lockfile. Prisma schema and migrations
are unchanged from the base: this package does not require a production database
migration. Do not execute historical migration instructions for this release.
OAuth, encrypted token storage and both provider signature verifiers are kept.

## Required gates

- Codex and Claude Code review of the actual package; specific human approval of
  authentication, Meta and queue/worker changes under AGENTS.md.
- Human merge only. Do not bypass main protection, approvals or failed checks.
- Current-head CI: typecheck, lint, tests, disposable PostgreSQL migrations/drift
  and build. Mocks and an empty production queue do not prove real delivery.
- Vercel preview/deployment availability. A build rate limit is an external
  blocker; do not purchase a plan or evade the quota to release.

## Deploy after human integration and applicable authorization

1. Fetch main and record its full commit SHA. Verify the final main tree matches
   the reviewed PR head; a different merge result needs fresh checks/review.
2. Save the current Vercel deployment ID and Fly image digest/release before any
   change. No secret values belong in logs, command arguments or the PR.
3. Let the approved main deploy on Vercel. Confirm its READY deployment points to
   the recorded main SHA. A previous deployment or successful local build is
   insufficient. Do not redeploy repeatedly while rate limited.
4. From that same clean checkout, deploy the existing worker only with applicable
   authorization using `flyctl deploy --app criaping-worker --config fly.toml`.
   Record the resulting image digest and release, associating them with the exact
   checkout SHA. The worker Dockerfile builds source plus Prisma with Node 24;
   it does not need runtime secrets during build. Do not create/scale services or
   alter credentials as part of this operation.
5. Compare hashes of package.json, package-lock.json, lib/queue/publishing-worker.ts,
   lib/queue/publishing.ts, lib/queue/publishing-batch-progress.ts, lib/queue/process-webhook.ts,
   lib/queue/webhook-diagnostics.ts and lib/meta/client.ts inside the deployed
   worker against the approved checkout. Heartbeat alone does not identify code.
6. Read /api/health, Fly/Vercel logs, heartbeat/canary and both queue counts.
   Confirm the existing Supabase/Redis/media-storage configuration without
   changing data or permissions. A steady canary proves consumer processing,
   not a real Meta publication.

## Real validation still required

Use authorized profiles and media only. Verify comment → webhook → public reply
→ received DM; inbound DM → webhook → received reply; supported Story text
reply; scheduled publication → confirmed Meta media; Speed Post execution with
order, captions, pause/resume/cancellation and no duplicate publication. Do not
use API acceptance alone as proof of a user's receipt.

PR #90 affects future connection/reconnection requests. Existing Instagram
accounts need an authorized reconnect or complete subscribed_fields update and
GET readback of comments,messages,messaging_postbacks,messaging_seen. App-level
fields are a separate requirement. Missing interactive account fields do not
prove the cause of a missing plain-text message webhook when messages is already
subscribed. App publication does not replace advanced-access approval for clients.

## Rollback

Publishing claim protection and orphan recovery (#81/#85) must remain coupled.
Do not selectively remove the claim guard while recovery stays active. Keep the
security dependency patch when reverting functional changes; an old vulnerable
Next.js lock is not an acceptable web rollback target. Use an explicitly approved
compatible rollback artifact, preserve database/Redis data, and validate both
services afterward. No rollback migration or automatic account unsubscription
is part of this package.
