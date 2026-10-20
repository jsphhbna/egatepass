# E-GatePass Internal Security and Production-Readiness Audit Findings

**Project:** E-GatePass

**Audit date:** 2026-10-05 (Asia/Manila)

**Repository baseline:** `8bffcd7bfdbd76869ddfcca761676b4c86b80b17` on `main`

**Auditor:** automated code/security review

**Historical result:** certification criteria not met at the pre-deployment audit stage. The final closure record below supersedes that result for the audited application commit.

## Final production re-audit addendum (2026-10-05)

Application commit `ffa1cbb2c0960aada1947cadb05acd486baf918d` is deployed by Netlify deploy `6ac3be488913450008db6a2f`. The corrected Firestore index is `READY`; the hosted secret scan found no matches; 19 Node `nodejs24.x` Functions, including `migrate-image-delivery` and daily `retention-cleanup`, are deployed. The release remains free-tier compatible: `rateLimits.expiresAt` is ordinary timestamp data and `fieldOverrides` is empty.

The authorized Super Admin reported a completed one-visitor migration: dry run found two legacy images; the confirmed live run migrated both, returned zero failures, zero reconciliation records, and `nextCursor: null`. Netlify production logs independently show the two successful migration invocations followed by successful image-proxy invocations, with no Cloudinary rename, Firestore update, reconciliation, missing-secret, or `ERR_REQUIRE_ESM` error.

This session could not independently read protected Firestore metadata/audit/reconciliation records or issue the representative authorized image request because no authenticated browser session or production staff credential was available. It also could not safely request the legacy unsigned Cloudinary URL without an authenticated record lookup. The migration Function is code-reviewed to require Super Admin, rename only `upload` assets to `authenticated`, update bounded pass references, await its `image_delivery_migration` audit write, and create reconciliation tasks for failures. Those controls, tests, and the reported live response strongly support the migration, but they are not a substitute for the remaining read-only production checks.

| Finding | Current status | Evidence |
|---|---|---|
| H-1 Missing retention index | FIXED | Production `gatePasses(status ASC, issuedAt ASC)` index is `READY`. |
| H-2 Cloudinary direct image exposure | PARTIALLY FIXED | Protected implementation is deployed and the bounded legacy migration reports completion; direct public denial plus protected metadata/audit/reconciliation read-back are still required for certification. |
| H-3 Anonymous rate limiting | FIXED | Deployed server-side controls and bounded scheduled cleanup; focused tests and full 238/238 emulator suite passed. |
| H-4 Cleanup starvation/reliability | FIXED | Deployed deterministic cursors, bounded cleanup, reconciliation protection, and progression/idempotency tests. |
| H-5 Pass/image expiry mismatch | FIXED | Deployed pass-aware expiry handling and emulator lifecycle coverage. |

**Remaining certification blocker:** perform the following read-only checks from an authenticated Super Admin session, without disclosing asset identifiers: confirm migrated visitor/pass delivery metadata is `authenticated`; confirm the `image_delivery_migration` audit reports `migratedImages: 2`, `failedImages: 0`, and `reconciliationCount: 0`; confirm no unresolved migration reconciliation task; confirm `/api/image` returns the representative image body without a reusable Cloudinary URL; and confirm the corresponding unsigned legacy delivery URL is denied or unavailable.

### Current re-audit scorecard

| Aggregate | Score /10 | Basis |
|---|---:|---|
| Overall | 7.9 | Four high findings are fixed; one production evidence-dependent high finding remains. |
| Security | 7.8 | Authenticated delivery is deployed, but direct-public denial is not independently evidenced in this session. |
| Reliability | 8.4 | Bounded, cursor-based maintenance and reconciliation paths are deployed and emulator-tested. |
| Frontend | 8.1 | Prior role/layout/retention input fixes are deployed; no new frontend regression is known. |
| Backend | 8.3 | Independent server authorization, rate limits, audit, and reconciliation controls are deployed. |
| Production readiness | 7.7 | Healthy deploy, index, functions, and logs; H-2 read-only evidence remains. |
| School handoff readiness | 8.2 | Environment, cleanup, and recovery documentation is present; complete the H-2 verification record before handoff sign-off. |

No internal security certificate or README passed-status was authorized until the H-2 blocker was closed.

## Final H-2 closure and certification decision (2026-10-06)

The required authenticated production verification was completed after the preceding addendum:

- The bounded Super Admin dry run found one visitor and two legacy images, with no failures or reconciliation records.
- The confirmed live run migrated both images (`migratedImages: 2`), with `failedImages: 0`, `reconciliationCount: 0`, and `nextCursor: null`.
- The administrative audit displayed `image delivery migration`, actor `superadmin`, target `visitor_images: bounded_batch`, and result `success`.
- The protected reconciliation endpoint returned zero unresolved items.
- An authorized `/api/image` request returned HTTP `200` and `Content-Type: image/webp`.
- The old unsigned `image/upload` delivery path for the migrated legacy asset returned HTTP `404`; the image was not publicly retrievable from that path.

This is **PRODUCTION-VERIFIED** evidence. It completes the remaining direct-public-delivery, authorized-access, audit, and reconciliation acceptance checks without exposing asset identifiers or credentials.

| Final high finding | Status | Closure evidence |
|---|---|---|
| H-1 Missing retention index | FIXED | Production `gatePasses(status ASC, issuedAt ASC)` index is `READY`. |
| H-2 Cloudinary direct image exposure | FIXED | Authenticated migration completed 2/2; authorized proxy HTTP 200/image-webp; old unsigned upload path HTTP 404; audit success; reconciliation count 0. |
| H-3 Anonymous rate limiting | FIXED | Server-side quotas, 429 handling, hashed address state, and bounded expiry cleanup were emulator-tested and deployed. |
| H-4 Cleanup starvation/reliability | FIXED | Deterministic cursors, bounded/idempotent cleanup, protected records, and reconciliation behavior were tested and deployed. |
| H-5 Pass/image expiry mismatch | FIXED | Pass-aware image expiry/return-to-normal-retention lifecycle was tested and deployed. |

**Final result:** 0 critical and 0 unresolved high findings for the audited application release. The passing internal certificate is scoped to application code commit `ffa1cbb2c0960aada1947cadb05acd486baf918d` and production deploy `6ac3be488913450008db6a2f`; it does not convert this historical findings document into an external certification.

### Final certification scorecard

| Aggregate | Score /10 | Basis |
|---|---:|---|
| Overall | 8.6 | All five release-blocking findings are closed with test, code/configuration, and production evidence. |
| Security | 8.7 | Layered Auth/RBAC, Rules, Functions, protected image delivery, audit, and rate-limit controls. |
| Reliability | 8.5 | Bounded cursor cleanup, retry-safe behavior, and reconciliation protection; scheduled execution should continue to be monitored. |
| Frontend | 8.2 | Role-aware UI and protected image presentation; browser E2E coverage remains a future improvement. |
| Backend | 8.6 | Server-side authorization and lifecycle controls are independently enforced. |
| Production readiness | 8.5 | Healthy Netlify deploy, ready index, protected image production checks, and clean secret scan. |
| School handoff readiness | 8.4 | Complete operational/environment documentation; school IT must maintain secret, index, and reconciliation procedures. |

## Historical pre-deployment audit record

The current working tree contains locally validated remediations for H-1 through H-5: the missing index declaration, authenticated image delivery and a bounded legacy-migration Function, backend rate limits, progressive retention cursors, and pass-aware image expiry. The corrected Firestore index configuration was deployed on 2026-10-05; the application code remains uncommitted and undeployed at this point in the record.

### Phase 1 hardening-validation follow-up (2026-10-05)

| Original finding | Local evidence | Production state | Status |
|---|---|---|---|
| H-1 Firestore retention index | `firestore.indexes.json` declares `gatePasses(status ASC, issuedAt ASC)` for `cleanupHistoricalVisits`; emulator cleanup progression passed. | Production index `CICAgNiav4AK` was verified `READY` with `status ASC`, `issuedAt ASC`, and Firestore's implicit `__name__ ASC`; no Rules deployment occurred. | FIXED |
| H-2 Public Cloudinary delivery | New uploads use `authenticated`; the proxy, cleanup, purge, and bounded Super Admin migration Function carry delivery type; emulator migration and partial-delete reconciliation tests passed. | Existing production `upload` assets have not been migrated and the compatibility code is not deployed. | PARTIALLY FIXED |
| H-3 Anonymous abuse controls | Server-side UID/IP fixed-window quotas, HTTP 429/`Retry-After`, HMAC-hashed address state, bounded scheduled expiry cleanup, and Firestore default-deny were tested in the emulator. | The deployed Functions do not yet contain this change. | REMEDIATED LOCALLY — DEPLOYMENT PENDING |
| H-4 Cleanup starvation/recovery | Deterministic persisted cursors, bounded dependent deletion, protected-record skips, reconciliation, and idempotent repeated runs were tested in the emulator. | The deployed retention Function still has the original behavior until release. | REMEDIATED LOCALLY — DEPLOYMENT PENDING |
| H-5 Pass/image expiry mismatch | New records use a base/effective expiry; future-valid passes are protected; scanner exit and rejection return only new records to their base deadline; emulator transition and purge tests passed. | The deployed Functions/forms do not yet contain this change. | REMEDIATED LOCALLY — DEPLOYMENT PENDING |

The two initially failing transition assertions were test-fixture defects only: client Firestore test contexts were given Admin SDK `Timestamp` objects. Replacing those with client SDK timestamps made the affected focused transition tests pass without changing production logic.

| Validation | Result |
|---|---|
| Focused high-finding emulator tests | PASS — 8/8 selected tests (rate limiting, private delivery migration, cleanup progression/protected audit history, image purge reconciliation, and pass/image expiry) |
| Focused scanner/Guard transition tests | PASS — 10/10 selected tests |
| `npm test` | PASS — 4 files, 238/238 tests using Firebase Auth and Firestore emulators, including free-tier bounded rate-limit cleanup |
| `npx tsc --noEmit` | PASS |
| `npm run typecheck:functions` | PASS |
| `npm run build` | PASS — Vite emitted the existing >500 kB chunk warning |
| `npx netlify build --debug` | PASS — production-context build; 19 Function entries bundled successfully; 3m 5.8s |
| `git diff --check` | PASS |

These are **TESTED LOCALLY / EMULATOR**, **CODE-REVIEWED**, and **BUILD-VERIFIED** results. H-1 is additionally **PRODUCTION-VERIFIED** as `READY`. The local `fieldOverrides` array is empty: `rateLimits.expiresAt` remains ordinary timestamp data and scheduled maintenance deletes at most 50 expired rate-limit documents per run, so the release does not require Firestore TTL or billing. The reviewed Functions must still be deployed, and the bounded H-2 legacy-asset migration must then be executed and reviewed. Until those steps are complete, no Phase 2 certificate re-audit is authorized and no passing certificate or README status must be created.

## Audit boundary and evidence

This audit covers the current repository, its uncommitted working-tree changes, the production architecture, non-destructive production endpoint probes, deployed Function inventory, production Function logs, and the deployed Firestore index inventory. It did not mutate production data, trigger cleanup, rotate credentials, deploy, commit, or push.

The repository was not in a clean, immutable release state during the audit. In addition to the baseline commit, the working tree contained pre-existing changes in `src/hooks/useAuth.tsx` and `src/pages/AdminSettings.tsx`, untracked `src/lib/retentionInput.ts` and `tests/retention-input.test.ts`, and non-release `.tmp/` artifacts. The current production frontend asset hashes differ from the local build, so the local authentication and Settings changes must not be described as deployed.

The currently deployed Firestore Rules revision could not be independently downloaded and compared byte-for-byte. The current repository Rules were validated in the emulator test suite. Production Functions and indexes were inspected through their respective CLIs; all 18 top-level Function entries were listed as deployed, and seven indexes were `READY`.

## Executive result

No critical vulnerability was confirmed. Five high-risk findings remain, including a production-observed scheduled-retention failure and public delivery of sensitive Cloudinary images when a public ID is known. These findings prevent a passing internal certificate and keep production readiness and school handoff readiness below 8.0/10.

No `docs/SECURITY_AUDIT_CERTIFICATE.md` was created, and no passed security status or badge was added to `README.md`.

## Final scorecard

| Category | Score /10 | Risk | Main issue |
|---|---:|---|---|
| Frontend Architecture | 7.5 | MEDIUM | Several large workflow components and duplicated orchestration increase change risk. |
| Frontend Security | 7.5 | MEDIUM | Persistent browser caching and technical error details need hardening, although the client is not the authorization boundary. |
| Authentication | 8.0 | MEDIUM | Password-change reconciliation and production/local auth drift remain. |
| Authorization / RBAC | 9.0 | LOW | Strong UID-based server authorization; deployed Rules revision was not independently retrieved. |
| Backend Security | 7.0 | HIGH | Anonymous upload/pass issuance has no explicit abuse throttling or quota. |
| API Communication | 8.0 | MEDIUM | Verified bearer tokens are used, but global wildcard CORS and inconsistent body caps remain. |
| Firestore Rules | 9.0 | LOW | Default-deny and server-only protected writes are strong; current production parity is not independently proven. |
| Data Integrity | 7.5 | HIGH | Server accepts unbounded future visit dates while image expiry starts at creation. |
| QR Security | 9.0 | LOW | Random identifiers, status transactions, scanner type, and gate binding resist replay. |
| Image Security | 5.5 | HIGH | Default Cloudinary `upload` delivery is public if a public ID becomes known. |
| Retention Safety | 5.0 | HIGH | Production cleanup is failing, and fixed first-page batches can starve later eligible records. |
| Device Security | 8.5 | MEDIUM | Strong server lifecycle controls; rare reconciliation-write failure can be reported ambiguously. |
| Admin Security | 9.0 | LOW | Super Admin-only mutations and final-active-Super-Admin protection are enforced server-side. |
| Auditability | 7.5 | MEDIUM | Important events are immutable, but some before/after values and cleanup failure details are incomplete. |
| Privacy | 5.5 | HIGH | Sensitive images can bypass the application proxy, and cleanup currently cannot meet configured policy. |
| Secret Management | 9.0 | LOW | No committed server secrets found; documentation is slightly out of sync with scanner exclusions. |
| Deployment Security | 7.0 | HIGH | The required production retention index is absent; response security headers are incomplete. |
| Failure Recovery | 6.5 | MEDIUM | Good reconciliation design is undermined by ignored reconciliation-write failures and cleanup starvation. |
| Performance | 6.5 | MEDIUM | Unbounded listeners/queries, a large client chunk, and sequential cleanup limit scale. |
| Accessibility / UX | 8.0 | MEDIUM | Good semantic controls and responsive layout; no automated accessibility regression suite. |
| Testing | 7.5 | MEDIUM | 226 tests pass, but cleanup integration/failure injection and browser E2E coverage are missing. |
| Maintainability | 7.5 | MEDIUM | Strong TypeScript and shared helpers; large components, dead-deny Rules clauses, and a helper exposed as a Function add debt. |
| Handoff Readiness | 7.5 | HIGH | Documentation is extensive, but production retention failure and image-security inaccuracies make handoff incomplete. |

**OVERALL SYSTEM SCORE: 7.5/10**

| Aggregate | Score /10 |
|---|---:|
| Security | 7.9 |
| Reliability | 6.6 |
| Frontend | 7.7 |
| Backend | 7.7 |
| Production readiness | 6.8 |
| School handoff readiness | 7.5 |

The aggregate readiness scores are judgment-based release measures rather than only mathematical means; active production failures and high-risk privacy issues appropriately reduce readiness.

## Permission matrix

The authoritative identity chain is Firebase Authentication UID to `users/{uid}` or `devices/{uid}`, followed by role/type and active/status checks. UI visibility is treated as convenience only.

| Role | Primary pages/workflow | Firestore read | Direct Firestore write | Callable privileged operations | Destructive/security settings |
|---|---|---|---|---|---|
| Visitor (anonymous Auth) | Public pass request and own pass status | Own visitor/pass data when ownership query constraints are satisfied; public `settings/app` | None for protected visitor/pass/upload collections | Sign upload, clean own pending upload, create own portal pass | None |
| Kiosk device | Kiosk visitor/pass workflow | Own device record; pass `get`; public settings | None for protected records | Same upload/pass operations, constrained to active `kiosk` device | None |
| Entry scanner | Entry scan UI | Own device record; pass `get`; public settings | None | `scan-pass` for entry transition at its configured gate | None |
| Exit scanner | Exit scan UI | Own device record; pass `get`; public settings | None | `scan-pass` for exit transition at its configured gate | None |
| Guard | Guard decision/visitor views and image proxy | Visitors, passes, visit logs, own user record, public settings | Own `privacyAcceptedAt` only | Decide visit; retrieve referenced visitor image | No account/device/settings destruction |
| Admin | Admin dashboard, users, devices, audit/export, operational Settings | Users, devices, visitors, passes, visit logs, audit logs, settings | Own `privacyAcceptedAt` only | Create Guard; update permitted staff status/role; create/update devices; update operational settings; exports; images | No Super Admin promotion, credentials, deletion, retention policy, purge, or reconciliation view |
| Super Admin | All administrative pages and controls | Same as Admin plus authorized reconciliation view through backend | Own `privacyAcceptedAt` only | Full staff/device lifecycle, device credential replacement/deletion, retention policy, purge, reconciliation review | Allowed with server validation, audit, reconciliation, and final-active-Super-Admin protection |

Client modification cannot grant a real role: protected collection writes are denied by Rules and Functions re-read server-side user/device documents after verifying Firebase ID tokens.

## Netlify Function review matrix

| Function | Method and caller | Validation and data effects | Abuse/destructive/failure assessment |
|---|---|---|---|
| `cloudinary-sign` | POST; anonymous visitor or active kiosk | Strict JSON and folder validation; creates a server-owned `imageUploads` session; signs Cloudinary parameters | No explicit rate/quota control. Grants repeated signed uploads to easily created anonymous accounts. |
| `cleanup-upload` | POST; owning visitor/kiosk | Small request, deduplicated maximum of two public IDs; verifies upload ownership; deletes Cloudinary assets and metadata | Destructive but scoped. Creates reconciliation on supported partial failure paths. |
| `create-pass` | POST; anonymous visitor or active kiosk | Bounded body and field validation; transaction creates visitor/pass and claims upload sessions; generated IDs support retry safety | No issuance quota. Visit-date policy is insufficiently bounded. External uploads precede transaction and depend on cleanup/reconciliation. |
| `scan-pass` | POST; active entry/exit device | Bounded body; server derives type/gate; transaction enforces state transition and writes visit log | Good concurrency and replay resistance. Invalid-scan logging can amplify traffic/log volume. |
| `decide-visit` | POST; active Guard/Admin/Super Admin | Validates decision/reason and uses a transaction for pass state plus log | No explicit raw body-size cap; otherwise authorization and transition handling are strong. |
| `image` | GET; active Guard/Admin/Super Admin | Authorizes image reference against Firestore, checks expiry/purge state, proxies at most 10 MB | Application endpoint is protected, but it does not prevent direct public Cloudinary delivery. Multiple reference queries per request. |
| `create-user` | POST; Admin or Super Admin | Role restrictions are rechecked; Auth user then Firestore profile/audit transaction | Rollback/reconciliation exists. Regular Admin is limited to Guard creation. |
| `update-user` | POST; Admin or Super Admin | Transaction enforces allowed role/status changes and final Super Admin protection | Strong concurrency protection. Auth/Firestore identity drift still needs operational reconciliation. |
| `create-device` | POST; Admin or Super Admin | Strict device type/gate/email/password validation; Auth then Firestore/audit transaction | Rollback/reconciliation handles partial failure; no browser-supplied privilege is trusted. |
| `update-device` | POST; Admin or Super Admin | Validates target, status, type, and gate constraints; server writes/audits | Revocation is Firestore-status based; active token loses authority because each call re-reads status. |
| `update-device-auth` | POST; Super Admin | Validates credential replacement and records pending audit/reconciliation around irreversible Auth work | Password mutation cannot be rolled back. Reconciliation creation failure is not always surfaced accurately. |
| `delete-device` | DELETE; Super Admin | Disables/revokes device, deletes Auth identity and Firestore record, audits | Correctly treats multi-system deletion as non-atomic; rare reconciliation-write failure can make recovery less visible. |
| `update-settings` | POST; Admin operational fields; Super Admin retention/security fields | Strict allowlists and body cap; server validates ranges and normalizes legacy policy | Good role split. Retention audit detail does not consistently include every old/new value. |
| `reconciliation-items` | GET; Super Admin | Returns a sanitized, bounded list of unresolved server-only records | Correct operational visibility without client write access. |
| `purge-images` | POST; Super Admin or timing-safe internal secret | Bounded visitor/upload selections; Cloudinary deletion followed by metadata updates/audit | Sequential deletes can exceed schedule time. Old failures can starve later records; first external failure is not always reconciled. |
| `retention-cleanup` | Netlify schedule (`@daily`) | Invokes image purge, historical visit cleanup, audit cleanup, and resolved-reconciliation cleanup | Not publicly invokable as a scheduled Function, but production execution currently fails on a missing index. Netlify scheduled Functions have a short execution ceiling. |
| `clear-password-flag` | POST; authenticated staff self | Verifies UID and recent Auth token state, then clears forced-change marker | Client changes password before flag clear; an interruption can leave ambiguous UI state without reconciliation. |
| `firebase-admin` | Helper module, no intended HTTP handler | Initializes Admin SDK and shared auth helpers | It is located at the Function root and appears in deployed Function inventory; move shared code under a non-entry directory to avoid accidental exposure/confusion. |

Across these endpoints, backend authorization is based on verified ID token UID plus current Firestore role/status—not client role claims. Methods and JSON validation are generally strong. The main cross-cutting gaps are anonymous abuse controls, some missing body caps, incomplete response security headers, and cleanup failure behavior.

## Category findings

### 1. Frontend Architecture

**Score: 7.5/10**

**Strengths:** Route-level role guards, a central authentication context, reusable UI primitives, normalized working-hours/retention helpers, lazy loading, and clearly separated portal, kiosk, scanner, Guard, and Admin workflows.

**Weaknesses:** `GetPassPage`, `GuardPage`, `AdminSettings`, and device/account screens are large and coordinate validation, networking, and UI state together. Portal/kiosk and entry/exit flows repeat similar orchestration. The working tree contains an uncommitted auth-state correction and Settings restructuring, creating release-state ambiguity.

**Risk: MEDIUM**

**Recommended action:** Split complex screens into workflow hooks and focused sections, consolidate repeated pass/upload orchestration, and release from a clean immutable commit after focused regression tests.

### 2. Frontend Security

**Score: 7.5/10**

**Strengths:** No unsafe HTML injection pattern was found; protected mutations use Functions; bearer tokens come from Firebase Auth; role-gated UI is not treated as the backend boundary; secrets are not embedded in Vite configuration.

**Weaknesses:** Firestore multi-tab IndexedDB persistence can retain visitor PII on shared school browsers. A Guard cooldown key includes the Guard email in local storage. The error boundary can expose component-stack technical detail. The deployed app does not yet contain the local unknown-user sign-out correction.

**Risk: MEDIUM**

**Recommended action:** Define shared-device cache/logout clearing policy, minimize identifying local-storage keys, suppress component stacks in production UI, and deploy the reviewed auth correction through the normal release gate.

### 3. Authentication

**Score: 8.0/10**

**Strengths:** UID is authoritative; staff must be email-verified and active; devices are resolved through `devices/{uid}` with active status/type; anonymous visitors cannot also be known staff/devices; privileged Functions re-resolve current identity.

**Weaknesses:** Client password replacement is irreversible before `clear-password-flag` succeeds, so network failure can leave the password changed while the forced-change flag remains. The flag-clear heuristic also depends on token-valid-after state, which can change for reasons other than the intended password flow. Orphan Auth/profile states require operational reconciliation.

**Risk: MEDIUM**

**Recommended action:** Make the post-password-change result explicit and retryable, record a server-side reconciliation/audit item if flag clearing fails, and provide a documented orphan-identity review procedure.

### 4. Authorization / RBAC

**Score: 9.0/10**

**Strengths:** Admin, Super Admin, Guard, visitor, kiosk, entry, and exit checks are server-derived. Regular Admin cannot promote to Super Admin or perform Super Admin-only credential/destructive operations. Final-active-Super-Admin protection is transactionally checked. Direct protected writes are denied.

**Weaknesses:** Current production Rules could not be retrieved for byte-for-byte comparison, and role changes rely on every surface continuing to re-read Firestore rather than trusting long-lived client state.

**Risk: LOW**

**Recommended action:** Add a release-control step that records the deployed Ruleset ID/content hash and periodically test stale-token scenarios against a production-like environment.

### 5. Backend Security

**Score: 7.0/10**

**Strengths:** Firebase Admin verifies tokens, role/device records are read server-side, most bodies are capped and strictly validated, mutations use transactions where concurrency matters, and external-service partial failures usually create reconciliation records.

**Weaknesses:** Anonymous Auth accounts can repeatedly request upload signatures and create passes without explicit per-UID/IP quotas, App Check, or platform rate limits. `decide-visit` lacks an explicit body-size cap. Expected unauthorized probes are logged as errors with stack traces, enabling log noise.

**Risk: HIGH**

**Recommended action:** Add layered rate limiting and quotas to public creation/signing paths, add consistent request-size enforcement, and log expected 4xx denials as structured warnings without stacks.

### 6. Frontend to Backend Communication

**Score: 8.0/10**

**Strengths:** Requests carry Firebase ID tokens; target UID never substitutes for actor identity; methods are enforced; the backend revalidates payloads and returns bounded, sanitized responses; retry-sensitive pass creation uses generated identifiers and transactions.

**Weaknesses:** `Access-Control-Allow-Origin: *` is applied globally rather than narrowly to API requirements. There is no explicit browser-origin allowlist or CSRF-style origin check; bearer tokens remain the actual control. Error payload handling is not uniformly typed across the frontend.

**Risk: MEDIUM**

**Recommended action:** Scope CORS to API routes and known origins if cross-origin use is unnecessary, standardize error response types, and document idempotency expectations for every retryable endpoint.

### 7. Firestore Rules

**Score: 9.0/10**

**Strengths:** Default deny is present. User role/active changes, device writes, visitor/pass mutations, visit logs, audit logs, image-upload metadata, reconciliation, and settings writes are backend-only. Staff checks require verified email and active user records. Devices are constrained by server-stored type/status.

**Weaknesses:** Dead `false && ...` schemas make the Rules longer and can mislead maintainers into believing those direct writes are conditionally permitted. `settings/app` is publicly readable, which is acceptable for current operational fields but constrains future additions. Production Rules parity was not independently proven.

**Risk: LOW**

**Recommended action:** Replace dead guarded clauses with clear unconditional denies and comments, keep sensitive settings in a separate server-only document if added, and record deployed Ruleset evidence in each release.

### 8. Data Integrity

**Score: 7.5/10**

**Strengths:** Pass creation claims upload sessions transactionally; Guard decisions and scanner transitions write the pass state and visit log together; entry/exit state machines prevent duplicate and out-of-order transitions; scanner type and gate are taken from the device record.

**Weaknesses:** The server accepts syntactically valid dates without a bounded future window while `imagesExpireAt` starts from upload/creation time. A legitimate far-future issued pass can therefore lose its identity images before the visit. Cleanup batches can also fail when a visitor has enough related records to exceed Firestore's batch-write limit.

**Risk: HIGH**

**Recommended action:** Enforce a documented server-side visit-date window and ensure retained images cannot expire before the pass is closed/expired. Page dependent records and chunk batch deletes below Firestore limits.

### 9. QR / Pass Security

**Score: 9.0/10**

**Strengths:** Pass identifiers are high-entropy server-generated values; scanners submit identifiers to server-authorized transitions; transactions resist concurrent replay; entry and exit roles are separated; entry gate binding is checked; expiry and current status are authoritative.

**Weaknesses:** A QR remains a bearer identifier and can be photographed. Security therefore depends on Guard identity review and image availability, which the current Cloudinary/retention issues can weaken.

**Risk: LOW**

**Recommended action:** Preserve the current state machine and gate binding, and fix image confidentiality/availability so Guards retain the intended identity check.

### 10. Image / Cloudinary Security

**Score: 5.5/10**

**Strengths:** The API secret remains server-side; signatures use narrow folders, random IDs, and ownership context; metadata is server-only; cleanup validates ownership; the application image proxy requires Guard/Admin authorization and distinguishes expired, missing, and temporary failure states.

**Weaknesses:** Uploads use Cloudinary's default `upload` delivery type. Signed upload protects the upload operation, not subsequent delivery. Anyone who learns a public ID can construct a direct Cloudinary CDN URL and bypass the application image proxy until deletion/cache invalidation. Documentation currently overstates application-authorized image access.

**Risk: HIGH**

**Recommended action:** Use Cloudinary authenticated delivery for new sensitive images, update signature/upload/proxy/delete parameters consistently, design a controlled migration for existing assets, invalidate cached copies on purge, and correct image-security documentation. Cloudinary states that default `upload` assets are publicly accessible and random public IDs are not access control: <https://cloudinary.com/documentation/control_access_to_media>.

### 11. Retention / Deletion

**Score: 5.0/10**

**Strengths:** Legacy `retentionDays` is safely normalized without reinterpreting it as other retention concepts. Unclaimed upload expiry, retained-image lifetime, and manual purge are separate. Active/unclosed passes and unresolved reconciliation block parent deletion. Security-sensitive audit actions are protected indefinitely. Operations are bounded and generally retry-safe at the individual record level.

**Weaknesses:** Production scheduled visitor cleanup failed on 2026-10-05 because the `gatePasses(status, issuedAt ASC)` composite index is missing; the repo defines only the descending variant. Fixed first-page limits allow an undeletable old pass, failed image, or protected audit rows to be selected repeatedly and starve later eligible records. Related logs/uploads are loaded without per-parent pagination and then placed into one batch. Cloudinary deletions are sequential and can exceed the scheduled Function execution window. Not every persistent external deletion failure creates a reconciliation item.

**Risk: HIGH**

**Recommended action:** Add the ascending index without removing the existing descending index; wait for `READY`; replace first-page loops with deterministic cursors/eligibility markers and quarantine/reconciliation for failures; paginate child records and chunk batches; add continuation/backlog metrics; and validate with emulator integration/failure-injection tests. Never test cleanup destructively in production.

### 12. Device Security

**Score: 8.5/10**

**Strengths:** Device credentials are created and replaced through protected Functions; type/gate/status are server records; every call rechecks active status; credential replacement is Super Admin-only; deletion coordinates revocation, Auth deletion, Firestore deletion, audit, and reconciliation.

**Weaknesses:** Password changes and Auth deletion are irreversible across services. The reconciliation helper can fail and return false while some callers still communicate a reference as though recovery was recorded. There is no device-level MFA or hardware binding.

**Risk: MEDIUM**

**Recommended action:** Treat reconciliation-write failure as a distinct severe partial outcome, alert operators, and document rapid device credential rotation/revocation. Consider stronger device identity only if the school's threat model requires it.

### 13. Admin / Super Admin Security

**Score: 9.0/10**

**Strengths:** The first Super Admin has a documented one-time manual bootstrap with no public bootstrap endpoint. Regular Admin capabilities remain bounded. Super Admin-only retention, device credential/deletion, purge, and reconciliation controls are enforced in Functions. Final-active-Super-Admin protection is transactional.

**Weaknesses:** Administrative sessions do not have step-up authentication for the most destructive operations. The initial bootstrap depends on careful manual UID/document verification.

**Risk: LOW**

**Recommended action:** Preserve the current bootstrap record and final-account invariant; consider recent-authentication/step-up checks for destructive Super Admin actions as future hardening.

### 14. Audit Logging

**Score: 7.5/10**

**Strengths:** Audit logs are server-authored and immutable to clients. Identity and role events, device operations, settings, purge, and cleanup activity are covered. Initial Super Admin and other high-sensitivity event types are excluded from automatic retention deletion.

**Weaknesses:** Settings auditing emphasizes changed field names and legacy values rather than complete redacted old/new values for every new retention field. Some external deletion failures appear only in runtime logs. Expected authorization denials use error-level stacks. The privacy notice incorrectly suggests all logs are permanent.

**Risk: MEDIUM**

**Recommended action:** Define a redacted audit schema with before/after values for security policy, guarantee a reconciliation/audit reference for persistent partial failure, and align user-facing retention language with actual policy.

### 15. Privacy

**Score: 5.5/10**

**Strengths:** The system records consent acknowledgement, uses purpose-specific visitor/pass data, implements configurable lifetimes, separates image cleanup, protects administrative history, and restricts normal database reads by role/ownership.

**Weaknesses:** Government-ID and visitor-photo assets can be fetched directly through public Cloudinary delivery if IDs leak. Production visitor cleanup is not functioning as configured. Browser offline persistence can leave PII on shared devices. The privacy notice lacks a clear controller/contact, specific policy lifetimes, and rights/contact process, and says scans/actions are permanently logged despite generic audit retention.

**Risk: HIGH**

**Recommended action:** Fix image delivery and retention first, define shared-terminal cache policy, and update the notice with the school's actual controller/contact, purposes, configurable retention explanation, and rights channel. RA 10173 principles require transparency, legitimate purpose, proportionality, and no retention longer than necessary; this audit does not prescribe or certify a legal duration: <https://privacy.gov.ph/implementing-rules-regulations-data-privacy-act-2012/>.

### 16. Secrets / Environment

**Score: 9.0/10**

**Strengths:** No committed private key/API secret/cron secret was found. Only `.env.example` is tracked and it contains placeholders. Local `.env` forms are ignored. Vite variables are limited to public Firebase client configuration. Server credentials stay in Netlify. Secret scanning remains enabled and exclusions are narrow; actual secrets are not omitted.

**Weaknesses:** `docs/DEPLOYMENT.md` and `docs/ENVIRONMENT_AND_CRON.md` describe only the four public Vite exclusions, while `netlify.toml` also omits the non-secret `FIREBASE_PROJECT_ID` value after a documented hosted scan false positive. Secret scope/existence was user-verified, not value-retrieved during this audit.

**Risk: LOW**

**Recommended action:** Reconcile documentation with the exact narrow exclusion list and keep periodic repository/history scanning and secret rotation in the handoff checklist.

### 17. Netlify / Deployment Security

**Score: 7.0/10**

**Strengths:** Node 24 and the known-working CommonJS/ESM compatibility option are pinned; tooling is reproducible; secret scanning is active; API redirects precede SPA fallback; scheduled cleanup is platform-scheduled and cannot be invoked as a normal public Function URL; unauthorized production probes returned 401; no `ERR_REQUIRE_ESM` or cron-secret configuration error appeared in inspected logs.

**Weaknesses:** The Firestore index required by production retention is absent. Global wildcard CORS is broader than necessary. HSTS is present in production, but CSP, frame-ancestor protection, Referrer-Policy, and Permissions-Policy were not observed. The helper `firebase-admin.ts` appears as a deployed Function entry. The current production deploy ID/commit was not independently recovered.

**Risk: HIGH**

**Recommended action:** Deploy the missing index through the controlled release process, verify the next scheduled run, add appropriate response security headers, narrow CORS, move helper code outside Function entry discovery, and record deploy/Rules/index identifiers in release evidence. Netlify documents that scheduled Functions run only on published deploys and are not directly URL-invokable: <https://docs.netlify.com/build/functions/scheduled-functions/>.

### 18. Error Handling / Failure Recovery

**Score: 6.5/10**

**Strengths:** Multi-step Auth/Firestore operations perform validation before mutation, use transactions, attempt deterministic rollback where possible, and explicitly recognize irreversible Auth changes. Reconciliation records are server-only and Super Admins have a sanitized review endpoint.

**Weaknesses:** Reconciliation creation itself is not treated as a guaranteed outcome; callers can lose the recovery trail. Cleanup catches per-record failures but can repeatedly select them and stop effective progress. Password-change flag clearing lacks explicit reconciliation. Some user-facing failures are generic while logs contain excessive stacks for expected denials.

**Risk: MEDIUM**

**Recommended action:** Make reconciliation persistence failures visible and alertable, add dead-letter/quarantine semantics, return truthful partial-result codes, and test every failure boundary with injected Auth, Firestore, and Cloudinary faults.

### 19. Performance

**Score: 6.5/10**

**Strengths:** Exports page at 250 records and cap at 10,000; cleanup uses outer batch limits; Vite route splitting is present; Firestore composite indexes support common operational views.

**Weaknesses:** Admin user/device listeners and the inside-visitors dashboard query are unbounded. Image authorization performs several Firestore lookups per image. Cleanup is sequential and uses extra per-record reads. The build reports a client chunk over 500 KB and a sizable scanner chunk. The missing index makes one production query unusable rather than merely slow.

**Risk: MEDIUM**

**Recommended action:** Add pagination/limits to administrative lists, cache or consolidate safe image-reference checks, parallelize only within bounded limits, add the missing index, and review bundle splitting using the build manifest.

### 20. Accessibility / UX

**Score: 8.0/10**

**Strengths:** Forms generally have labels, inline errors, focus-visible styles, keyboard-accessible controls, Radix dialog focus behavior, a skip link, adequate touch targets, destructive confirmations, clear expired/missing/temporary image states, responsive Settings columns, and reduced-motion handling.

**Weaknesses:** There is no automated axe/browser accessibility suite. Long administrative cards can create substantial scroll. Error-boundary technical details are not appropriate for ordinary users. Responsive evidence is partly manual rather than repeatable.

**Risk: MEDIUM**

**Recommended action:** Add automated accessibility smoke checks at mobile/tablet/desktop breakpoints and production-safe error copy while preserving the verified independent Settings columns.

### 21. Testing

**Score: 7.5/10**

**Strengths:** The suite has extensive Firestore Rules authorization coverage plus retention-policy/input and export tests. All 226 tests passed. Frontend TypeScript, Functions TypeScript, Vite build, and Netlify production-equivalent build passed.

**Weaknesses:** There are no deep integration tests for scheduled cleanup, batch overflow, starvation, Cloudinary partial deletion, or reconciliation persistence failure. There is no browser E2E/accessibility suite and no repository CI workflow. Production Rules parity is not automatically checked.

**Risk: MEDIUM**

**Recommended action:** Add emulator-backed cleanup integration and fault-injection tests, critical role workflow E2E tests, accessibility checks, and a CI gate covering tests/typechecks/build/Rules with deploy-artifact provenance.

### 22. Maintainability

**Score: 7.5/10**

**Strengths:** Strict TypeScript, named permission helpers, shared validation/retention utilities, clear server/client separation, structured documentation, and comments around irreversible operations make the security design understandable.

**Weaknesses:** Large page/function modules, repeated role/error logic, dead-deny Rules schemas, compact cleanup code, and a helper in the Function root increase maintenance risk. Documentation has drifted on secret-scan exclusions, image access, and log retention.

**Risk: MEDIUM**

**Recommended action:** Refactor only after the security blockers, preserving behavior with tests; centralize endpoint envelopes and audit schemas; remove misleading dead code; and include docs in release review.

### 23. Documentation / School Handoff

**Score: 7.5/10**

**Strengths:** README and dedicated architecture, deployment, security, operations, troubleshooting, bootstrap, clean-data handoff, environment/cron, image security, and export/working-hours guides cover most lifecycle tasks. The one-time Super Admin procedure is explicit and avoids a public bootstrap endpoint. Runtime and secret-rotation handoff are documented.

**Weaknesses:** The guides overstate image authorization because Cloudinary delivery remains public, understate the current scanner exclusion list, and do not foreground the currently broken retention query. There is no release evidence bundle containing deploy ID, Ruleset, index state, and a clean audited SHA.

**Risk: HIGH**

**Recommended action:** Correct the inaccurate claims, add a retention health/runbook section and deployment evidence template, then perform a clean-release audit after the high findings are fixed.

## Priority findings

### CRITICAL

None confirmed.

### HIGH

#### H-1 — Scheduled visitor retention fails in production (CONFIRMED ISSUE)

- **Affected:** `netlify/functions/utils/retention-maintenance.ts` (`cleanupHistoricalVisits`), `firestore.indexes.json`, deployed `retention-cleanup`.
- **Evidence:** The 2026-10-05 scheduled production invocation logged Firestore `FAILED_PRECONDITION` requiring `gatePasses(status ASC, issuedAt ASC, __name__ ASC)`. Both repository and deployed index inventories contain only the descending `issuedAt` variant.
- **Scenario:** Every daily run reaches visitor cleanup and the query fails before eligible historical records are examined.
- **Impact:** Configured visitor/pass retention is not enforced, privacy expectations are false, and the cleanup audit cannot represent successful visitor deletion.
- **Fix:** Add the ascending composite index in addition to the existing descending one; deploy indexes first; wait for `READY`; run non-destructive/emulator validation; confirm the next scheduled production run and backlog metrics.

#### H-2 — Sensitive images use public Cloudinary delivery (CONFIRMED ISSUE)

- **Affected:** `netlify/functions/cloudinary-sign.ts`, `src/lib/cloudinary.ts`, `netlify/functions/image.ts`, image-security documentation.
- **Evidence:** Signing/upload parameters do not set an authenticated delivery type and the client uploads to `/image/upload`. Cloudinary documents default `upload` assets as publicly accessible; signed upload does not make delivery private.
- **Scenario:** A person who sees, guesses from a disclosure, or obtains a stored public ID constructs the Cloudinary CDN URL and retrieves the visitor photo or ID without E-GatePass authorization.
- **Impact:** Application RBAC/proxy controls can be bypassed for highly sensitive images until deletion and cache invalidation.
- **Fix:** Adopt authenticated delivery for new assets; consistently include delivery type in signing, upload, proxy, and destruction; plan a controlled existing-asset migration; invalidate cache; test expiry and deletion end to end.

#### H-3 — Anonymous upload/pass endpoints lack explicit abuse controls (CONFIRMED ISSUE)

- **Affected:** `cloudinary-sign`, `create-pass`, Netlify/API configuration.
- **Evidence:** Anonymous Firebase Auth is accepted, but no per-IP/per-UID rate limit, issuance quota, App Check enforcement, or equivalent abuse gate is present.
- **Scenario:** An attacker automates anonymous account creation, obtains upload signatures, and creates pending uploads/passes faster than daily bounded cleanup.
- **Impact:** Cloudinary storage/egress cost, Firestore growth, Function/log cost, and service degradation.
- **Fix:** Combine Netlify rate limiting, server-side per-UID/IP/time-window quotas, monitoring/alerts, and appropriate bot friction or App Check. Keep backend validation authoritative.

#### H-4 — Cleanup can starve, overflow a batch, or lose recovery visibility (CONFIRMED ISSUE)

- **Affected:** `netlify/functions/utils/retention-maintenance.ts`, `netlify/functions/purge-images.ts`, reconciliation helper/callers.
- **Evidence:** Fixed oldest-page limits precede eligibility filtering; protected/failed records remain selectable; related logs/uploads are unbounded within one batch; Cloudinary deletion is sequential; some persistent deletion/reconciliation failures do not guarantee a task.
- **Scenario:** One undeletable old record or a page of protected audits is selected daily, preventing later eligible data from being processed. A visitor with many dependent records exceeds the batch limit, or a scheduled run times out partway.
- **Impact:** Retention backlogs grow invisibly, partial cleanup repeats, and operational claims become unreliable.
- **Fix:** Use deterministic cursors or eligibility queues, quarantine failures with guaranteed reconciliation, page and chunk dependent deletion, store continuation state, emit backlog metrics, and add interruption/retry tests.

#### H-5 — Pass scheduling can outlive identity images (CONFIRMED ISSUE)

- **Affected:** `create-pass`, public/kiosk visit-date forms, retention policy interaction.
- **Evidence:** Server validation accepts a valid date string without a bounded future window; image expiry is calculated from creation rather than pass completion or validity.
- **Scenario:** A visitor creates a valid far-future pass. Its photo/ID reaches image retention age and is purged before the scheduled visit, while the pass remains issued.
- **Impact:** Guard identity verification is unavailable for a legitimate pass, weakening operational security and causing denial/confusion.
- **Fix:** Define and enforce a server-side scheduling window and protect images until the pass closes/expires, then begin or extend the retention calculation without silently rewriting unrelated existing expirations.

### MEDIUM

- **M-1:** Forced password change can succeed in Auth while flag clearing fails, with no explicit reconciliation.
- **M-2:** Reconciliation-record creation failure is not always surfaced truthfully by multi-system device/account operations.
- **M-3:** The current production build and dirty local audit state differ; the complete system cannot be bound to one immutable SHA.
- **M-4:** No CI workflow automatically enforces tests, typechecks, build, Rules, or release evidence.
- **M-5:** CSP/frame-ancestor, Referrer-Policy, and Permissions-Policy headers were not observed; wildcard CORS is global.
- **M-6:** Browser IndexedDB persistence and a local-storage email key need a shared-device privacy policy.
- **M-7:** Privacy copy is incomplete and incorrectly describes retained audit history as permanent.
- **M-8:** Settings audit entries do not consistently retain complete redacted before/after policy values.
- **M-9:** Expected unauthorized requests create error stack noise in production logs.
- **M-10:** Cleanup, Cloudinary failure, browser workflow, and accessibility integration coverage are missing.
- **M-11:** Administrative listeners and some dashboard queries are unbounded; client bundles include a >500 KB chunk.
- **M-12:** `decide-visit` lacks the otherwise common explicit raw body-size limit.

### LOW

- **L-1:** Dead `false &&` Rules branches make unconditional backend-only protection harder to read.
- **L-2:** A shared `firebase-admin.ts` helper appears in deployed Function discovery even though it is not intended as an endpoint.
- **L-3:** Error-boundary component stacks should not be shown to ordinary production users.
- **L-4:** Security/environment documentation is slightly out of sync with `FIREBASE_PROJECT_ID` scanner exclusion.
- **L-5:** Responsive/accessibility evidence relies on manual checks rather than a repeatable browser suite.

## Validation evidence

| Check | Result |
|---|---|
| `npm test` | PASS — 4 files, 226/226 tests |
| `npx tsc --noEmit` | PASS |
| `npm run typecheck:functions` | PASS |
| `npm run build` | PASS — Vite emitted a >500 KB chunk warning |
| `npx netlify build` | PASS — production-equivalent build; 18 Function entries bundled |
| `npm audit` | 23 accepted advisories: 21 high, 2 moderate, 0 critical |
| Runtime dependency check | PASS — `firebase-admin@14.5.0`, `jwks-rsa@4.1.0`, `jose@6.2.12` unchanged |
| Tooling check | PASS — `netlify-cli@27.10.2`, `typescript@5.9.3`; no `ts-api-utils` in the installed tree |
| Production unauthenticated probes | PASS — protected image, reconciliation, signing, user update, and purge endpoints returned 401 |
| Deployed Function inventory | PASS — all 18 top-level entries listed as deployed, including scheduled retention |
| Production retention execution | FAIL — missing ascending `gatePasses(status, issuedAt)` index |
| Current repository Rules tests | PASS — default-deny and role boundaries covered in emulator suite |
| Production Rules parity | NOT INDEPENDENTLY VERIFIED — deployed revision was not retrieved |

The 23 npm advisories are an explicitly accepted known dependency risk for this release: known production findings are transitive/upstream chains, while others primarily affect tooling; available automated remediation requires incompatible changes or downgrades. No `npm audit fix --force` was run. This acceptance does not waive the application-specific high findings above.

## Certification decision

The requested internal project audit certificate requires no unresolved production-blocking high findings and production/handoff scores of at least 8.0/10. E-GatePass does not currently meet those conditions:

- unresolved high findings remain;
- scheduled retention is failing in production;
- production readiness is 6.8/10;
- school handoff readiness is 7.5/10.

Accordingly, no passing certificate and no README passed badge/status were generated. Re-audit the clean release commit after H-1 through H-5 are resolved and deployed with evidence.

## Top five risks

1. Production scheduled visitor retention is blocked by a missing ascending composite index.
2. Sensitive visitor/ID images are directly deliverable from public Cloudinary URLs when their public IDs are known.
3. Anonymous signed-upload and pass-creation paths have no explicit rate/quota controls.
4. Cleanup selection and batching can starve later records, exceed write limits, or lose reconciliation visibility.
5. Far-future passes can remain valid after their identity images expire.

## Top five strengths

1. UID-based authorization is independently enforced by Functions and default-deny Firestore Rules.
2. Pass decisions and entry/exit transitions use transactional state-and-log updates with scanner type/gate checks.
3. Super Admin controls, final-active-Super-Admin protection, and the manual one-time bootstrap are well bounded.
4. Device and account lifecycle code explicitly handles irreversible Auth operations and provides reconciliation paths.
5. TypeScript, Rules tests, 226 passing tests, reproducible Netlify builds, and extensive operations documentation provide a strong hardening base.

---

This is an internal automated application/security review, not a government, legal, penetration-test, ISO, SOC 2, Data Privacy Act compliance, or zero-vulnerability certification. Findings and scores apply only to the inspected commit, working-tree state, configuration evidence, and production observations described above.
