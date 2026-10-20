# DevKit Findings

Status terms: OPEN, MITIGATED — NOT VERIFIED, VERIFIED, ACCEPTED RISK, DEFERRED, REQUIRES SPECIALIST REVIEW.

| ID | Severity | Finding | Evidence | State / next action |
|---|---|---|---|---|
| S0-REPO-001 | Critical boundary | Wrong-repository writes would destroy the backup invariant. | Remote/tree verification in EV-S0-001/002 | VERIFIED locally; recheck before every push/deploy |
| S0-ENV-001 | High blocker | `VITE_SUPABASE_URL` and `SUPABASE_URL` are present but fail HTTPS URI validation; they match each other. | Names/status-only validation, EV-S0-004 | OPEN; owner corrects private local values |
| S0-DB-001 | High blocker | No Docker or Supabase CLI/config is available, so migrations/RLS/storage cannot yet be executed on a disposable local Supabase instance. | Tool inventory, EV-S0-003 | OPEN; resolve before S2 promotion |
| S0-VERCEL-001 | Medium blocker | No Vercel CLI or local project link exists; repository connection cannot be verified locally. | Tool inventory | OPEN; read-only provider verification later, mutation requires approval |
| S0-DEPS-001 | High | `npm audit` reports 24 advisories: 22 high, 2 moderate, 0 critical. | EV-S0-008 | OPEN; identify direct/transitive production exposure before controlled upgrades |
| S0-BUILD-001 | Low | Production build contains a minified chunk over 500 kB. | EV-S0-005 | OPEN; measure route/runtime impact before optimization |
| S0-TEST-001 | Medium reliability | Firebase CLI 13.10.0 leaves the Firestore emulator Java process listening on ports 8080/9150 after a successful `emulators:exec` run in this environment. | Reproduced after multiple runs; process identity checked before termination | OPEN; add bounded cleanup/test wrapper in S1 |
| S0-UI-001 | Medium UX | 390×844 landing capture horizontally clips hero content/card; desktop capture is intact. | `docs/evidence/s0-baseline/landing-phone.png` | OPEN; preserve as baseline and fix with before/after proof in S8 |
| S0-UI-002 | Evidence blocker | Kiosk, scanner, Guard, and Admin original screenshots initially lacked isolated authenticated accounts. | Playwright synthetic emulator identities and `docs/evidence/s0-baseline/authenticated/` | VERIFIED locally; real hardware/camera interaction remains USER-MANUAL |
| S0-E2E-001 | Medium test quality | The first browser locator treated the Password label as both the input and show-password button; a URL-only assertion also captured pre-render pages. | Failed Playwright trace, then semantic heading waits | VERIFIED regression fix; 9/9 rerun passed |
| S0-ROUTE-001 | Medium parity | No catch-all/404 route appears in `src/App.tsx`. | Static route inspection | OPEN; implement and test during auth/routing work |
| S0-META-001 | Medium repository | `package.json` repository/bugs/homepage still point to uppercase backup. | Static manifest inspection | OPEN; correct in S1 without changing backup |
| S0-SECRET-001 | High control | `.env.local` is ignored and all required names are present; values were not printed. `.env.example` contains empty values only. An initial synthetic E2E password passed through Firebase CLI environment debug output; generated logs were immediately removed and the harness now generates credentials in-process. | `git check-ignore`; names/status-only inspection; E2E regression | VERIFIED for current working tree; repeat before commit/push |
| S0-DOC-001 | High truthfulness | Current active docs describe Firebase/Netlify/Cloudinary and include an audit “certificate”; they cannot represent the future Supabase target as current. | Existing docs inventory | OPEN; archive/rewrite only after replacement behavior exists |

No legal-compliance certification is inferred. School privacy/retention policy and Data Privacy Act interpretation require owner/institutional review before live personal-data processing.
