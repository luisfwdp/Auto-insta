# Workspace invitations and membership roles

Inviting or accepting an invitation creates a missing membership with the invited
role. It preserves every existing member's current role, including `OWNER`.
Role changes use the existing member management action, which refuses owner
changes. This prevents administrators from bypassing owner protection through
the invitation endpoint and prevents stale invitations from changing later roles.

Acceptance consumes a still-pending, unexpired invitation inside the same
transaction as membership creation. A concurrent acceptance or revocation cannot
grant membership from a stale read. No schema or production data migration is
needed. Rollback is a code revert; it does not undo legitimate memberships.

Regression coverage: `workspace-invitation-rbac.test.ts` exercises role
preservation, authorization and stale acceptance. `workspace-isolation.db.test.ts`
also verifies the owner attack and concurrent acceptance against disposable
Postgres via `TEST_DATABASE_URL`.
