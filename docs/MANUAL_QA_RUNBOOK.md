# Owner Manual QA Runbook

Use fictional visitors only. Never place passwords, QR bearer values, ID images, or signed URLs in this repository. Record browser/device/version, commit SHA, timestamp, observed result, evidence location, reviewer, and one of PASS / FAIL / BLOCKED. The fields below are intentionally blank until the owner performs each case.

## P0 owner white-screen confirmation — AWAITING OWNER

1. On the feature branch/commit supplied in the milestone report, run `npm ci` and `npm run dev -- --host 127.0.0.1`.
2. Open the exact URL printed by Vite in a normal browser window and a 390px-wide phone/device view.
3. Confirm the original E-GatePass landing page, hero, sections, footer, and **Get Your Gate Pass** actions appear with no horizontal clipping.
4. Open `/login`; confirm the original staff/device sign-in layout appears. Do not use production credentials.
5. If the page is still white, securely attach only the first red console error and failed request path with tokens/query strings removed. Report whether `VITE_FIREBASE_*` names exist as yes/no; never send values.

- Environment/URL:
- Browser/phone:
- Commit:
- Observed result:
- Evidence path:
- Reviewer/date:
- Result: [ ] PASS [ ] FAIL [ ] BLOCKED

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
4. Record any overflow, unreadable text, missing route, modal/focus issue, or workflow difference. The historical S0 capture raised a clipping concern; the P0 390px browser assertion now passes, but owner-device confirmation remains required.

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
5. Fill one evidence record per discrepancy. This is historical S1 guidance; on the migration branch, shared startup/Auth is now Supabase while operational feature chunks remain legacy.

## Checkpoint sheet: M1 shared identity — BLOCKED / AWAITING OWNER

Provider execution is BLOCKED until a disposable local Supabase or explicitly authorized non-production project is available. Once available, use fictional accounts only:

1. Record environment identity, feature commit, browser, and reviewer. Confirm migrations execute twice and pgTAP passes before creating users.
2. Sign in through `/login` as active Super Admin, Admin, Guard, Kiosk, Entry, and Exit identities; record exact redirects, refresh persistence, logout, and wrong-role denial.
3. Verify unconfirmed and suspended staff, revoked and wrong-type devices, and an Auth user with no profile/device row cannot obtain operational access.
4. Enter a device alias (not its internal email) and confirm only the provisioned matching device authenticates. Try malformed aliases and arbitrary email mappings.
5. Exercise Guard forced password change with wrong current password, weak/same password, success, and injected finalization failure. Confirm no password/token appears in logs and reconciliation is created only for the partial-failure case.
6. Exercise forgot-password and verification-resend emails only through an approved synthetic inbox; confirm expired/used callbacks fail safely and no account enumeration appears for unknown email submissions.
7. Revoke or suspend an already signed-in actor and confirm the next protected database/API operation fails even if the browser still holds an unexpired token.

- Result: [ ] PASS [ ] FAIL [ ] BLOCKED

## Checkpoint sheet: S2 database/security (only after isolated environment is available)

Owner status: **BLOCKED** — requires Docker-backed local Supabase or explicit authorization for a non-production hosted test project.

1. Confirm the test project/instance identity and that it contains no production or real visitor data.
2. Run the migration reset twice from clean state and `supabase test db`; attach complete sanitized outputs.
3. With fictional Auth accounts for every actor/state, attempt cross-owner reads, role/source forgery, direct writes, last-Super-Admin removal, wrong/revoked device actions, and reconciliation access.
4. Upload synthetic JPEG/PNG/WebP files through live intents. Attempt wrong path/bucket, expiry, list, overwrite, and delete. Confirm no real ID/face image is used.
5. Record actual results, environment identity (sanitized), commit, browser/client version, reviewer, and evidence locations. A SQL file or static-test PASS is not acceptable as the observed result.

## Checkpoint sheet: M2 portal/kiosk registration — BLOCKED / AWAITING OWNER

Run only after the isolated Supabase migrations and pgTAP suite pass. Use fictional images/details and never capture a real ID or face.

1. Portal: open `/get-pass` at desktop and 390px, complete manual details, webcam photo, ID preview, consent, date/purpose, QR success, download and share. Confirm no staff/device session is changed.
2. Kiosk: sign in as an active kiosk, complete the same flow, print, then select Next Visitor. Confirm all prior data/images/QR clear while the kiosk remains signed in.
3. Test Peak Mode OFF/Portal/Kiosk/Both. Photo must always be required; ID omission must succeed only for the selected source scope.
4. Attempt files over 5 MiB, fake image bytes with an allowed extension/MIME, expired/reused/cross-owner intents, wrong bucket/path, overwrite/list/delete, portal-as-kiosk source forgery, and a revoked kiosk. All must fail without a pass.
5. Interrupt after upload and retry with the same request. Confirm at most one pass/visitor is issued, the recovered QR is identical, and unclaimed objects remain eligible for cleanup rather than becoming evidence.
6. Inspect the database: one visitor, required evidence with verified size/SHA-256, claimed intents, one pass with only a 32-byte digest, one audit event, correct Asia/Manila validity window, and no caller-selected lifecycle fields.

- Environment/URL:
- Browser/phone/kiosk:
- Commit:
- Observed result:
- Evidence path:
- Reviewer/date:
- Result: [ ] PASS [ ] FAIL [ ] BLOCKED

## Checkpoint sheet: M3 scanner and Guard lifecycle — BLOCKED / AWAITING OWNER

After M2 succeeds in the isolated environment, use the issued fictional QR and distinct provisioned Entry, Exit, and Guard accounts.

1. Entry: scan once at its assigned gate. Confirm UI reports pending, not admitted; Guard queue shows one visitor with correct face/ID, purpose, time, validity, and gate.
2. Guard: compare evidence, approve, and confirm inside state/event. Repeat with a second pass and a required rejection reason; confirm no later entry/exit is possible.
3. Exit: scan the approved pass at the matching gate and confirm exited. Try another gate, entry/exit device type mismatch, revoked device, pending/rejected/expired/early/forged/replayed QR, and concurrent duplicate scans.
4. Confirm every denial leaves pass version/state unchanged except legitimate expiry, while invalid attempts append sanitized operational events without raw QR data.
5. Suspend/revoke actors with sessions still open; the next API/RPC call must fail. A Guard who has not completed password/privacy requirements must not see queue/evidence or decide.
6. Temporarily interrupt Realtime. Confirm the bounded polling recovery refreshes the queue without duplicates and the UI presents an understandable error while unavailable.

- Environment/URL:
- Entry/Exit/Guard devices and browsers:
- Commit:
- Observed result:
- Evidence path:
- Reviewer/date:
- Result: [ ] PASS [ ] FAIL [ ] BLOCKED
