# Dependency Audit Triage

Reviewed: 2026-10-20. No forced upgrade or downgrade was applied.

`npm audit --json` reports 24 findings: 22 high, 2 moderate, 0 critical. `npm audit --omit=dev --json` reports four high findings, all in the legacy Firebase client chain. These counts are advisory aggregation, not 24 independently reachable application exploits.

| Chain | Scope/reachability | Assessment and action |
|---|---|---|
| `firebase` → Firestore → `@grpc/grpc-js@1.9.16` | Legacy browser dependency; audit advisories concern gRPC server certificate/error behavior. E-GatePass is not a gRPC server. | Not demonstrated exploitable in this browser path; keep under review and remove after verified Supabase cutover. Audit proposes an unsafe major downgrade to Firebase 9.14.0, so no forced fix. |
| `@firebase/rules-unit-testing` | Legacy emulator test-only dependency | No deployed runtime reach. Remove only after Supabase tests replace Firebase baseline evidence. Suggested major downgrade is rejected. |
| `netlify-cli` → `sharp`, `node-forge`, `micromatch`/`braces` | Development CLI and legacy Netlify local tooling | Not shipped in the Vite browser bundle. Avoid processing untrusted local assets; remove after Vercel replacement is verified. No untested downgrade to Netlify CLI 2.x. |
| `firebase-admin` → `gaxios` → `uuid@9` | Legacy Netlify server path | Moderate advisory requires a caller-supplied buffer in UUID helpers; application does not call that API directly. Retain until server cutover, then remove. |
| Tailwind/Vite/Netlify tooling → `source-map-js@1.2.1` | Build-time source-map parsing | Inputs are repository/dependency source maps, not visitor data. Update through tested parent releases; do not override blindly. |

`npm outdated --long` shows newer patch/minor releases and major upgrades, but version availability alone is not remediation evidence. Upgrade candidates will be separated into: required target-stack additions, safe patch updates with full regression, and legacy removals after replacement. Re-run both full and production-only audits at every checkpoint.
