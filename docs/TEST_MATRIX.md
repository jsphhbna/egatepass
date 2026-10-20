# Modernization Test Matrix

Status values: PASS, FAIL, BLOCKED, NOT TESTED, AWAITING OWNER. A lower-level PASS does not promote a higher-level gate.

| Boundary | Required evidence | Stage | Current status |
|---|---|---|---|
| Original routes/UI | Build plus browser routes and screenshots | S0/S1 | PASS locally; owner visual QA AWAITING OWNER |
| Supabase-only startup | Dev/preview browser, missing/malformed config, desktop/390px | P0 | PASS locally on exact feature commit; owner-machine QA AWAITING OWNER |
| Repository metadata/Vercel SPA config | Contract test, JSON inspection, build | S1 | PASS locally; deployed routing NOT TESTED |
| Migration chain | `supabase db reset` on clean disposable instance | S2 | Tests authored; BLOCKED: isolated Supabase/Postgres unavailable |
| RLS/grants/RPC denial matrix | Real Auth sessions and low-privilege Data API/SQL tests | S2/M1–M3 | 59 pgTAP assertions authored; BLOCKED: isolated Supabase unavailable |
| Private Storage | Real synthetic upload/read/list/delete tests | S2/S4 | Policies authored; BLOCKED: isolated Supabase unavailable |
| Shared staff/device login | Real Supabase Auth browser/API tests for all roles/states | S3 | IMPLEMENTED — NOT VERIFIED; Auth/database environment BLOCKED |
| Guard forced password/recovery | Real Auth email/session, Vercel endpoint, profile/audit/reconciliation checks | S3 | IMPLEMENTED — NOT VERIFIED; static/type/browser unavailable-state checks PASS |
| Portal/Kiosk evidence | Browser + real Storage + DB confirmation | S4 | IMPLEMENTED — NOT VERIFIED; static 7/7 PASS, live boundary BLOCKED |
| Pass lifecycle/races | Real DB/browser issue-entry-decision-exit plus concurrent negatives | S5 | IMPLEMENTED — NOT VERIFIED; lifecycle static 6/6 PASS, live boundary BLOCKED |
| Admin operations | Browser actions plus canonical DB/audit checks | S6 | NOT TESTED |
| Resend/Auth mail | Real approved test inbox and callback | S7 | NOT TESTED |
| QR-email local contract | Exported handler faults/replays/concurrency, adapter classification, static SQL, UI/build | S7 correction | PASS locally: focused 92/92; full safe suite 166/166; live DB/provider explicitly excluded |
| Retention/holds | Clock-safe DB plus physical Storage deletion | S7 | NOT TESTED |
| Accessibility/responsive | Automated checks plus owner keyboard/device walkthrough | S8 | NOT TESTED |
| Preview/deployment | Exact commit preview smoke and rollback rehearsal | S9 | BLOCKED pending authorization |

## S2 actor matrix

Each row requires a real Auth session and both positive and negative cases: anonymous guest, registered visitor, Guard, Admin, Super Admin, kiosk, entry scanner, exit scanner, suspended staff, and revoked device. Cross-owner reads/writes, direct REST bypass, forged role/source/gate, audit/event writes, last-Super-Admin changes, wrong scanner type/gate, and arbitrary Storage operations must be denied at the trusted boundary.

## QR-email live gates still pending

- Apply migrations 00100–01000 twice on a clean disposable Supabase/PostgreSQL environment.
- Run `supabase/tests/007_qr_email_security.test.sql`, including a genuine two-session parent-pass lock/rate-limit contention probe.
- Exercise real portal and kiosk Auth sessions through Data API/RPC boundaries and confirm PostgREST `bytea` serialization.
- With explicit owner authorization, use a non-production Resend sender/test inbox to distinguish provider acceptance from inbox receipt and inspect timeout/reconciliation operations.
- Owner manually verifies modal copy, touchscreen resend/close/new-visitor resets, and that Download, Print, Share, and Next Visitor remain unchanged. Status remains AWAITING OWNER until performed.
