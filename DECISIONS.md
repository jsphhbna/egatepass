# E-GatePass Decision Log

## ADR-0001 — Original-first modernization

- Date: 2026-10-20
- Status: accepted by owner instruction
- Decision: preserve the tracked original application, routes, content structure, visual identity, and workflows. Replace infrastructure in gated vertical slices; do not import or cherry-pick the rejected greenfield V10 build.
- Consequence: no visual redesign or broad folder reshuffle can precede parity evidence.

## ADR-0002 — Repository and production isolation

- Date: 2026-10-20
- Status: accepted
- Decision: configure only the lowercase target as a remote. Access the uppercase backup only through read-only Git queries. Make no production provider mutations without separate approval.
- Evidence: `origin` points only to lowercase target; target/reference tree diff is zero; local checkpoint branch created.

## ADR-0003 — Evidence vocabulary and maturity separation

- Date: 2026-10-20
- Status: accepted
- Decision: record STATIC, UNIT, MOCKED, LIVE LOCAL DATABASE, BROWSER E2E, USER-MANUAL, and DEPLOYMENT SMOKE independently. Code existence is `IMPLEMENTED — NOT VERIFIED`; it is not PASS.

## ADR-0004 — Preserve the pre-existing `.env.example` edit

- Date: 2026-10-20
- Status: accepted for S0
- Decision: do not overwrite or commit the user's dirty `.env.example` change during S0. It contains only empty values by inspection, but its ownership/history is separate from S0.

## ADR-0005 — Synthetic-only baseline browser configuration

- Date: 2026-10-20
- Status: accepted for local evidence
- Decision: public screenshots may use process-scoped synthetic Firebase identifiers because public pages do not need provider data. This evidence proves rendering only, not authentication or provider connectivity.

## Pending decisions

- Supabase local-test execution route (Docker Desktop versus owner-approved isolated hosted test project).
- Vercel Functions versus narrowly granted Supabase Edge/RPC placement per endpoint; decide in S1 from trust/race/operational needs.
- Optional registered visitor accounts remain pending until anonymous ownership and RLS tests pass; guest registration stays first-class.
