# Owner Manual QA Runbook

Use fictional visitors only. Never place passwords, QR bearer values, ID images, or signed URLs in this repository. Record browser/device/version, commit SHA, timestamp, observed result, evidence location, reviewer, and one of PASS / FAIL / BLOCKED. The fields below are intentionally blank until the owner performs each case.

## Evidence record template

- Case:
- Environment/URL:
- Commit:
- Actor/device/browser:
- Preconditions:
- Observed result:
- Evidence stored securely at:
- Result: [ ] PASS [ ] FAIL [ ] BLOCKED
- Reviewer/date:

## S0 original-baseline capture (run now if safe legacy emulator accounts are available)

1. Start only the disposable Firebase Auth/Firestore emulators and local app. Confirm the host is `127.0.0.1`, not a production domain.
2. At 1440px and approximately 390px, capture `/` and type `/login` manually. Confirm public navigation contains only How it works, What you need, Privacy, FAQ, and Get Your Gate Pass; no staff/device links or V10/official-certification claims.
3. With synthetic emulator accounts, capture `/kiosk`, `/scan/entry`, `/scan/exit`, `/guard`, `/admin`, and every Admin tab. Do not use live accounts or real visitor data.
4. Record any overflow, unreadable text, missing route, modal/focus issue, or workflow difference. Current automated capture already shows phone landing horizontal clipping; confirm whether a real phone reproduces it.

## Modernized-system acceptance cases

1. **Landing parity:** desktop and phone preserve original sections/branding; no operational links/claims. Compare to `docs/evidence/s0-baseline/`.
2. **Shared login:** type `/login`; each Super Admin, Admin, Guard, Entry, Exit, and Kiosk synthetic account reaches only its exact route.
3. **Staff states:** unverified and suspended staff are blocked; resend/reset callbacks work; Guard must change first password before operations and can re-login.
4. **Guard invitation:** Admin invites a real test Guard; invite arrives and callback/login works; Admin→Admin/Super Admin creation is denied.
5. **Devices:** Super Admin creates real Kiosk/Entry/Exit identities; each logs in; revoke blocks next operation; rotation blocks old credential/session; delete removes assignment safely.
6. **Portal registration:** on a phone, exercise OCR Yes and No with synthetic ID/face; correct fields; consent; QR view/save; OCR failure falls back without duplicate ID capture.
7. **Kiosk registration:** portrait touchscreen Yes/No OCR; print QR; Next visitor clears all prior sensitive fields while kiosk stays signed in.
8. **Happy lifecycle:** Portal/Kiosk issue → Entry scan produces pending only → Guard compares photo/ID and approves → inside/emergency updates → Exit scan exits → replay denied.
9. **Rejection/expiry:** Guard supplies rejection reason; rejected, early, expired, invalid, and reused QR scans are refused with clear state.
10. **Peak Mode scopes:** test OFF/Kiosk/Portal/Both. Face photo remains required; only permitted source may omit ID; forged source/role is denied.
11. **Email:** QR remains optional; only verified recipient retrieval/delivery works; Resend failure is retryable and does not duplicate/revoke pass; invitation/reset callbacks work.
12. **Settings:** Super Admin working-hours change affects newly issued passes; Admin is denied; audit shows previous/new value.
13. **Records/audit:** filters, pagination, complete CSV, and print match a known synthetic dataset; visit/audit/reconciliation remain separate; reconciliation is Super Admin-only.
14. **Retention/hold:** clock-safe 7-day photo/ID and 30-day metadata cleanup; active visit/hold survives; release then purge; actual Storage object disappears; failures remain visible/retryable.
15. **Responsive/accessibility/offline:** mobile Admin sidebar, modal stacking, keyboard/focus, labels/status, reduced motion, scanner camera permissions, refresh persistence, offline/retry, logout confirmation.
16. **Backend denials:** wrong role/device/gate, revoked identity, false bearer, invalid/duplicate QR, forged role/source, and direct REST attempts are rejected independent of UI.
17. **Preview/live smoke (only after approval):** correct target repo/revision/domain, DNS mail records preserved, callbacks/camera/API/Storage/scheduler work. Do not run against live data without authorization.

No case may be pre-filled from a build, unit test, screenshot, or AI observation. Report any issue with its exact case number so a regression test can be added.

## Checkpoint sheet: S1 architecture/no-regression

Owner status: **AWAITING OWNER**.

1. From local commit `babb8c5` or later, start the documented legacy emulator/browser workflow with fictional data only.
2. Compare `/`, `/login`, `/kiosk`, `/scan/entry`, `/scan/exit`, `/guard`, `/admin`, and every Admin tab with `docs/evidence/s0-baseline/`.
3. Confirm no route, original action, copy section, role redirect, or visual identity was removed. Record the known 390px landing overflow separately; it is deferred to S8.
4. Confirm public navigation still has no staff/device link.
5. Fill one evidence record per discrepancy. Do not approve Supabase/Vercel behavior from this check; the runtime is still legacy.

## Checkpoint sheet: S2 database/security (only after isolated environment is available)

Owner status: **BLOCKED** — requires Docker-backed local Supabase or explicit authorization for a non-production hosted test project.

1. Confirm the test project/instance identity and that it contains no production or real visitor data.
2. Run the migration reset twice from clean state and `supabase test db`; attach complete sanitized outputs.
3. With fictional Auth accounts for every actor/state, attempt cross-owner reads, role/source forgery, direct writes, last-Super-Admin removal, wrong/revoked device actions, and reconciliation access.
4. Upload synthetic JPEG/PNG/WebP files through live intents. Attempt wrong path/bucket, expiry, list, overwrite, and delete. Confirm no real ID/face image is used.
5. Record actual results, environment identity (sanitized), commit, browser/client version, reviewer, and evidence locations. A SQL file or static-test PASS is not acceptable as the observed result.
