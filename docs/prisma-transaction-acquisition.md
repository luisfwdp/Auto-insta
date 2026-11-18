# Prisma transaction acquisition rollback

A disposable PostgreSQL regression reproduced the installed client/adapter7.8.0
returning a connection with a late BEGIN still open after maxWait expiration.
The earlier SELECT1 check did not detect an idle un-aborted transaction. The
regression now rejects both idle-in-transaction states on the single pooled
connection after late acquisition. No timeout is relaxed.

Prisma fixed discarded transaction rollback in official PR29727, released in7.9.0.
Client, adapter-pg and CLI are aligned/pinned to7.10.1 (the CLI was already7.10.1).
No schema or migration changes; do not run a production migration for this patch.

https://github.com/prisma/orm/pull/29727
https://github.com/prisma/orm/releases/tag/7.9.0
https://github.com/prisma/orm/releases/tag/7.10.1

The dependency commit is shared by PRs95/96 to avoid duplicate dependency commits.
Keep the corrected runtime and regression when reverting unrelated UI changes.
Validate clean npm ci, Prisma generation, native pool/lock tests and full build.
