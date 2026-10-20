# Evidence Ledger

Revision under test: `f2f1a2b58ef19808c1be83865ee8537073b0dada`

Date/time zone: 2026-10-20, Asia/Manila

| ID | Class | Command / artifact | Result | Scope and limitation |
|---|---|---|---|---|
| EV-S0-001 | STATIC / GIT | `git remote -v`; branch/status/HEAD checks; `git ls-remote` for both main refs | PASS | Lowercase target only is configured; backup queried read-only |
| EV-S0-002 | STATIC / GIT | `git ls-tree` and `git diff --name-only HEAD 6906b91...` | PASS: 126 files each, zero differences | Tracked Git tree only; untracked/ignored developer tools excluded |
| EV-S0-003 | ENVIRONMENT | PowerShell `Get-Command` plus version commands | PASS inventory | Docker/Supabase/Vercel/Playwright absent is an observed blocker, not product failure |
| EV-S0-004 | ENVIRONMENT / SECRET HYGIENE | `git check-ignore .env.local`; names/status/URI validation script | PARTIAL | Ignore/names PASS; both Supabase URLs invalid; values never printed |
| EV-S0-005 | STATIC BUILD | `npm run build` | PASS, exit 0 | TypeScript + Vite build only; 500 kB chunk warning remains |
| EV-S0-006 | STATIC BUILD | `npm run typecheck:functions` | PASS, exit 0 | Legacy Netlify function TypeScript only |
| EV-S0-007 | STATIC | `git diff --check` | PASS, exit 0 with CRLF warning for pre-existing `.env.example` | Whitespace check only |
| EV-S0-008 | DEPENDENCY AUDIT | `npm audit --json` summarized without package payloads | FAIL: 24 total, 22 high, 2 moderate, 0 critical | Findings not remediated in S0 |
| EV-S0-009 | UNIT + LIVE LOCAL EMULATOR | Firebase CLI 13.10.0 Auth/Firestore `emulators:exec` running Vitest JSON reporter | PASS: 22/22 suites; 238/238 tests; 0 failed/pending | Legacy Firebase baseline only; not Supabase, production, or browser E2E |
| EV-S0-010 | BROWSER RENDER | Edge 155 headless against local Vite; screenshots under `docs/evidence/s0-baseline/` | PARTIAL | Landing desktop/login PASS visually; 390px landing exposes clipping |
| EV-S0-013 | BROWSER E2E / LIVE LOCAL EMULATORS | Playwright 1.64.1 with installed Edge 155, Firebase Auth/Firestore emulators, synthetic in-process credentials | PASS: 9 listed tests, `.last-run.json` passed with zero failed IDs | Proves original role route rendering/public-nav absence/wrong-role redirect/Admin tab rendering locally; not production/provider proof |
| EV-S0-011 | USER MANUAL | `docs/MANUAL_QA_RUNBOOK.md` | AWAITING OWNER | Actual/observed/evidence/signoff fields intentionally blank |
| EV-S0-012 | PROVIDER | Supabase/Vercel/Resend remote identity/config | BLOCKED / NOT TESTED | Malformed URL and missing CLIs/link; no provider mutation attempted |

## Baseline command notes

- `npm ci`: PASS; installed 1,314 packages and audited 1,316 packages.
- Java emulator runtime: 25.0.4.1 LTS.
- The first emulator run downloaded the pinned Firebase CLI/emulator assets. Subsequent runs reproduced an orphaned Firestore emulator process; only the verified local emulator PID was stopped.
- Generated Firebase debug logs containing synthetic emulator action links were removed and are ignored by Git.
- The first E2E run failed diagnostically on an ambiguous Password locator. The regression uses `#login-password` and semantic role-page headings; the complete rerun passed.

Evidence is tied to the working-tree baseline plus S0 documentation/screenshots. It does not establish deployment, real email, camera, Supabase RLS, Storage deletion, or production readiness.

## S1 architecture checkpoint

| ID | Class | Command / artifact | Result | Scope and limitation |
|---|---|---|---|---|
| EV-S1-001 | ENVIRONMENT / SECRET HYGIENE | private `.env.local` URL validation; `git check-ignore -v .env.local` | PASS for syntax/match/ignore | Two matching HTTPS URL entries; no values printed; connectivity/project identity NOT TESTED |
| EV-S1-002 | UNIT / CONFIG CONTRACT | `npm run test:architecture` | PASS: 1 file, 2 tests | Lowercase repository metadata and local `vercel.json` structure only |
| EV-S1-003 | STATIC BUILD | `npm run build` | PASS | React/TypeScript/Vite build; existing >500 kB chunk warning remains |
| EV-S1-004 | STATIC BUILD | `npm run typecheck:functions` | PASS | Unchanged legacy Netlify function source only |
| EV-S1-005 | BROWSER E2E / LIVE LOCAL EMULATORS | `npm run test:e2e:legacy`; Playwright `.last-run.json` | PASS: status passed, 0 failed; existing 9-case suite | Preserved local legacy routes/roles/Admin tabs; not target Supabase/Vercel proof |
| EV-S1-006 | STATIC | `git diff --check` | PASS with expected pre-existing `.env.example` line-ending warning | Working tree whitespace only |
| EV-S1-007 | DOCUMENTATION AUTHORITY | Supabase RLS/functions/Storage and Vercel Vite/Functions/config docs reviewed 2026-10-20 | REVIEWED | Establishes expected design, not runtime/project behavior |

User manual S1 screen comparison remains AWAITING OWNER. Supabase clean migration/RLS/Storage integration remains BLOCKED pending an isolated executable environment.
