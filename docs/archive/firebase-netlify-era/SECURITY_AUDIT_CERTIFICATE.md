# E-GatePass Internal Security Audit Certificate

**Project:** E-GatePass

**Audit date:** 2026-10-06 (Asia/Manila)

**Auditor:** automated code/security review

**Audited application commit:** `ffa1cbb2c0960aada1947cadb05acd486baf918d`

**Production deploy:** `6ac3be488913450008db6a2f`
**Certificate scope:** the application implementation at the audited commit and the production-safe evidence recorded below.

## Result

E-GatePass passed the defined application security and production-readiness audit criteria for the inspected release.

| Measure | Score /10 |
|---|---:|
| Overall system | 8.6 |
| Security | 8.7 |
| Reliability | 8.5 |
| Frontend | 8.2 |
| Backend | 8.6 |
| Production readiness | 8.5 |
| School handoff readiness | 8.4 |

**Critical findings remaining:** 0

**Unresolved high findings remaining:** 0

## Final release findings

| Finding | Result | Evidence summary |
|---|---|---|
| H-1 Missing retention index | PASS / FIXED | `gatePasses(status ASC, issuedAt ASC)` was deployed and verified `READY`. |
| H-2 Cloudinary direct image exposure | PASS / FIXED | Super Admin migration completed 2/2 legacy images; authorized `/api/image` returned HTTP 200/image-webp; old unsigned upload URL returned HTTP 404; audit succeeded; reconciliation count was 0. |
| H-3 Anonymous rate limiting | PASS / FIXED | Server-side UID/IP-bucket controls, 429 handling, hashed address state, and bounded expiry cleanup passed focused and emulator tests. |
| H-4 Cleanup starvation/reliability | PASS / FIXED | Persisted deterministic cursors, bounded/idempotent pages, protected-record checks, and reconciliation paths passed tests. |
| H-5 Pass/image expiry mismatch | PASS / FIXED | Pass-aware expiry protects active/future-valid passes and returns closed passes to ordinary retention; lifecycle tests passed. |

## Evidence snapshot

### TESTED

- `npm test`: **238/238** Firebase Auth and Firestore emulator tests passed across four files.
- `tests/firestore.rules.test.ts` covers Firestore Rules, staff/device authorization, server-only collections, scanner/Guard behavior, rate limits, cleanup progression/idempotency, authenticated image migration/proxy, partial-delete reconciliation, and pass-aware image expiry.
- Focused high-finding tests passed: 8/8; focused scanner/Guard transition tests passed: 10/10.
- Relevant implementation/test references: `tests/firestore.rules.test.ts`, `tests/retention-input.test.ts`, `netlify/functions/utils/rate-limit.ts`, `netlify/functions/utils/retention-maintenance.ts`.

### BUILD-VERIFIED

- `npx tsc --noEmit`: passed.
- `npm run typecheck:functions`: passed.
- `npm run build`: passed; the existing Vite chunk-size warning is non-blocking.
- `npx netlify build --debug`: passed; 19 Functions bundled for the production-equivalent build.
- `git diff --check`: passed before the audited release.

### CONFIGURATION-REVIEWED

- `firestore.rules` defaults to deny and keeps audit, reconciliation, rate-limit, maintenance, upload, and privileged mutations server-authored.
- `firestore.indexes.json` declares the deployed `gatePasses(status ASC, issuedAt ASC)` index and has an empty `fieldOverrides` array; Firestore TTL is not required.
- `netlify.toml` configures `nodejs24.x`, `NODE_OPTIONS=--experimental-require-module`, API routing, and narrow public Firebase/Project-ID secret-scan omissions only.
- `.env.example` lists placeholders only and classifies Firebase Admin, Cloudinary, and `CRON_SECRET` values as server-side.
- `netlify/functions/retention-cleanup.ts` is deployed with the `@daily` schedule; its schedule was registered in production.

### CODE-REVIEWED

- Authentication/RBAC: `src/hooks/useAuth.tsx`, `netlify/functions/utils/auth.ts`, and `netlify/functions/update-user.ts` resolve current UID, active state, and role server-side; Super Admin transitions and final-active-Super-Admin protection are enforced in transactions.
- Firestore and protected Functions: `firestore.rules`, `netlify/functions/create-pass.ts`, `netlify/functions/decide-visit.ts`, and `netlify/functions/scan-pass.ts` keep sensitive mutations server-side and preserve the pass/scanner lifecycle.
- Image delivery: `netlify/functions/cloudinary-sign.ts`, `netlify/functions/image.ts`, `netlify/functions/utils/image-security.ts`, and `netlify/functions/utils/image-lifecycle.ts` require application authorization, select authenticated delivery, and proxy image bytes without returning a reusable Cloudinary URL.
- Legacy migration: `netlify/functions/migrate-image-delivery.ts` requires Super Admin, limits each batch, requires exact live confirmation, renames only legacy `upload` assets to `authenticated`, updates bounded pass references, audits success, and creates reconciliation work on failure.
- Rate limiting and retention: `netlify/functions/utils/rate-limit.ts`, `netlify/functions/retention-cleanup.ts`, and `netlify/functions/utils/retention-maintenance.ts` use bounded server-side state, cursor progression, active-pass protection, and retry-safe reconciliation handling.
- Device security: `netlify/functions/delete-device.ts` and `netlify/functions/update-device-auth.ts` authorize server-side, revoke credentials where applicable, and record/reconcile multi-system failure states.

### PRODUCTION-VERIFIED

- The audited application commit is deployed as Netlify deploy `6ac3be488913450008db6a2f`.
- Hosted Netlify secret scanning passed with no reported matches; 19 Functions deployed on `nodejs24.x`.
- The Firestore index for `gatePasses(status ASC, issuedAt ASC)` is `READY`.
- `retention-cleanup` is registered at `@daily`; no Firestore TTL or billing dependency was introduced.
- Protected endpoint probes returned expected unauthenticated denials and production logs showed no `ERR_REQUIRE_ESM`, missing-secret, Cloudinary, migration, Firestore-update, retention, or reconciliation configuration error for the reviewed release.
- Authenticated Super Admin migration evidence: dry-run found one visitor/two legacy images; live run migrated two images with zero failures, zero reconciliation, and no continuation cursor.
- Authorized `/api/image` returned HTTP 200 with `Content-Type: image/webp`; the old unsigned `image/upload` path for the migrated asset returned HTTP 404.
- The migration administrative audit recorded success and the protected reconciliation endpoint returned `{ "items": [], "count": 0, "limit": 50, "readOnly": true }`.

## Evidence and References

| Control / Area | Result | Evidence Type | Evidence | Reference |
|---|---|---|---|---|
| Authentication | PASS | TESTED, CODE-REVIEWED | Emulator suite; UID and active-role resolution | `src/hooks/useAuth.tsx`, `netlify/functions/utils/auth.ts`, [Firebase Authentication](https://firebase.google.com/docs/auth) |
| RBAC | PASS | TESTED, CODE-REVIEWED | Role tests; backend re-reads current role and status | `netlify/functions/update-user.ts`, `tests/firestore.rules.test.ts` |
| Firestore Rules | PASS | TESTED, CONFIGURATION-REVIEWED | Rules emulator coverage; default deny/server-only collections | `firestore.rules`, `tests/firestore.rules.test.ts`, [Firestore Security Rules](https://firebase.google.com/docs/firestore/security/get-started) |
| Super Admin safeguards | PASS | TESTED, CODE-REVIEWED | Restricted role transitions, credential/destructive operations, final-admin protection | `netlify/functions/update-user.ts`, `netlify/functions/utils/auth.ts` |
| Device security | PASS | TESTED, CODE-REVIEWED | Server-authorized lifecycle, revocation, audit/reconciliation | `netlify/functions/delete-device.ts`, `netlify/functions/update-device-auth.ts` |
| Image security | PASS | TESTED, CODE-REVIEWED, PRODUCTION-VERIFIED | Authenticated delivery and proxy; HTTP 200 authorized image; old unsigned path HTTP 404 | `netlify/functions/cloudinary-sign.ts`, `netlify/functions/image.ts`, [Cloudinary media access control](https://cloudinary.com/documentation/control_access_to_media) |
| Legacy image migration | PASS | TESTED, CODE-REVIEWED, PRODUCTION-VERIFIED | Live 2/2 migration, success audit, zero reconciliation, no cursor | `netlify/functions/migrate-image-delivery.ts`, `tests/firestore.rules.test.ts` |
| Rate limiting | PASS | TESTED, CODE-REVIEWED | 429 behavior, HMAC address bucket, bounded rate-limit cleanup | `netlify/functions/utils/rate-limit.ts`, `netlify/functions/utils/retention-maintenance.ts`, `tests/firestore.rules.test.ts` |
| Retention | PASS | TESTED, CODE-REVIEWED, CONFIGURATION-REVIEWED | Protected categories/pass state, free-tier ordinary timestamps, daily schedule | `netlify/functions/retention-cleanup.ts`, `netlify/functions/utils/retention-maintenance.ts`, `firestore.indexes.json`, [Netlify Scheduled Functions](https://docs.netlify.com/build/functions/scheduled-functions/) |
| Cleanup reliability | PASS | TESTED, CODE-REVIEWED | Cursor progression, bounded batches, idempotent repeat execution | `netlify/functions/utils/retention-maintenance.ts`, `tests/firestore.rules.test.ts` |
| Pass/image lifecycle | PASS | TESTED, CODE-REVIEWED | Active/future-valid pass protection and normal retention after closure | `netlify/functions/utils/image-lifecycle.ts`, `netlify/functions/create-pass.ts`, `tests/firestore.rules.test.ts` |
| Reconciliation | PASS | TESTED, CODE-REVIEWED, PRODUCTION-VERIFIED | Server-only task records; Super Admin read-only list; count zero after migration | `firestore.rules`, `netlify/functions/reconciliation-items.ts`, `netlify/functions/utils/reconciliation.ts` |
| Secrets | PASS | CONFIGURATION-REVIEWED, PRODUCTION-VERIFIED | Server-only template/configuration and clean hosted scan | `.env.example`, `netlify.toml`, [Netlify Functions overview](https://docs.netlify.com/build/functions/overview/) |
| Deployment | PASS | BUILD-VERIFIED, PRODUCTION-VERIFIED | Production-equivalent build, ready deploy, Node 24, 19 Functions | `netlify.toml`, Netlify deploy `6ac3be488913450008db6a2f`, [Netlify Functions configuration](https://docs.netlify.com/build/functions/configuration/) |
| Privacy design context | REVIEWED | DOCUMENTATION-BASED | Minimized exposure, access control, retention, and audit support privacy objectives | [National Privacy Commission IRR for RA 10173](https://privacy.gov.ph/implementing-rules-regulations-data-privacy-act-2012/) |

## Known accepted limitations

- `npm audit` previously reported 23 advisories (21 high, 2 moderate, 0 critical). They were reviewed as accepted dependency risk for this release: production findings are transitive/upstream chains and other findings primarily affect development tooling; no confirmed exploitable application path was identified. Compatible upstream fixes should be monitored. No forced upgrade, downgrade, or runtime-chain change was made.
- The existing Vite bundle-size warning remains non-blocking and should be monitored as the application grows.
- This review uses automated tests, code/configuration inspection, and production-safe checks. It is not a substitute for ongoing monitoring, dependency review, staff training, or future browser accessibility/E2E coverage.
- Scheduled cleanup is registered and code-tested; operations should continue to monitor its daily logs and bounded execution results.

## Certificate boundary

This certificate reflects the inspected commit/configuration only. It does not claim zero vulnerabilities, legal compliance certification, external penetration testing, government certification, ISO certification, or SOC 2 certification.

“This internal certificate is based on source-code review, automated tests, configuration inspection, production-safe validation, and authoritative platform documentation for the referenced commit. It does not represent an external penetration test, legal certification, ISO certification, SOC 2 certification, or government certification.”

**Audited commit:** `ffa1cbb2c0960aada1947cadb05acd486baf918d`

**Production deploy:** `6ac3be488913450008db6a2f`

**Audit date:** 2026-10-06 (Asia/Manila)

**Evidence snapshot:** 238/238 emulator tests; frontend and Functions TypeScript; Vite; production-equivalent Netlify build; diff check; READY Firestore index; clean hosted secret scan; 19 Node 24 Functions; authenticated migration 2/2; authorized image HTTP 200/image-webp; old unsigned path HTTP 404; reconciliation count 0; audit success.
