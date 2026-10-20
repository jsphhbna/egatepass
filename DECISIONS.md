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

## ADR-0006 — Staged runtime replacement

- Date: 2026-10-20
- Status: accepted
- Decision: preserve the current source layout and legacy adapters until replacement vertical slices pass their gates. Add `api/`, `supabase/`, and email modules alongside them; remove Firebase/Netlify/Cloudinary files only after executable parity and rollback evidence.
- Consequence: S1 is deliberately a no-runtime-switch change.

## ADR-0007 — Vercel Vite routing and region

- Date: 2026-10-20
- Status: accepted, deployment unverified
- Decision: use the official Vite SPA catch-all in `vercel.json` and Vercel filesystem precedence for future `/api/*` function files. Select `syd1` near the declared Sydney Supabase region.
- Authority: Vercel Vite and project-configuration documentation reviewed 2026-10-20. Local contract/build tests are project evidence; deployed routing is not.

## ADR-0008 — Database-owned authorization

- Date: 2026-10-20
- Status: accepted for S2 implementation
- Decision: roles and device attributes come from protected database rows keyed by `auth.uid()`, not user-editable JWT metadata. RLS and explicit grants default-deny direct access; `SECURITY DEFINER` helpers live outside exposed schemas, use an empty `search_path`, schema-qualified names, caller/resource checks, and narrow execute grants.
- Consequence: S2 cannot be promoted from SQL review alone; real low-privilege positive/negative tests are mandatory.

## ADR-0009 — Relational model and exposed API boundary

- Date: 2026-10-20
- Status: accepted, runtime verification blocked
- Decision: normalize identities, visitors, evidence, passes, visit events, audit events, reconciliation, holds, and maintenance state. Expose RLS tables plus a small `api` RPC schema; keep policy helpers and bootstrap in unexposed `private`.
- Alternatives rejected: one wide JSON document model weakens constraints/query evidence; placing roles in JWT user metadata creates stale/self-editable authority; routing every read through service-role functions expands bypass risk.

## ADR-0010 — Evidence upload intent

- Date: 2026-10-20
- Status: accepted, runtime verification blocked
- Decision: a caller-specific RPC creates a 15-minute, owner/source/kind/bucket/path/MIME-bound intent. Storage permits insert/select only through intent/reference authorization and has no client update/delete policy. Bucket policy limits are 5 MiB for JPEG/PNG/WebP; server content inspection remains mandatory before claim/pass issue.
- Consequence: a successful upload alone can never issue a pass or prove file content.

## ADR-0011 — No audit-driven dependency downgrade

- Date: 2026-10-20
- Status: accepted
- Decision: do not run `npm audit fix --force`. Triage by dependency chain and reachable usage, regression-test safe parent upgrades, and remove legacy Firebase/Netlify chains only after verified replacements.
- Evidence: `docs/DEPENDENCY_AUDIT.md`; full audit 24 findings, production-only audit 4 high in the legacy Firebase chain.
