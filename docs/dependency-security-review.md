# Dependency security review — 2026-11-16

The original ESLint/minimatch lockfile remediation is retained. A fresh public-lock audit identified GHSA-mfr8-8qww-v76h (CVE-2026-119790), affecting Next.js 16.3.0 through 16.4.4. Next.js and eslint-config-next are now pinned to the official 16.4.6 patch; no application APIs or security gates are changed.

Official advisory: https://github.com/vercel/next.js/security/advisories/GHSA-mfr8-8qww-v76h
Release: https://github.com/vercel/next.js/releases/tag/v16.4.6

The advisory concerns a use-cache function nested inside unstable_cache across root params. That pattern was not found in application code; exploitation in CRIA PING has not been established. The dependency is updated regardless.

Validation: anonymous npm audit of the public manifests after the patch reports zero vulnerabilities. Typecheck, lint, regression tests and production build must be recorded at the new commit. Earlier successful CI at Next.js 16.4.3 does not validate this patch. Rollback should retain the security patch; do not restore a vulnerable lockfile in production.
