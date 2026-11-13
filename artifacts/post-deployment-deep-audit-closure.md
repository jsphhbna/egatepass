# Post-Deployment Deep Audit Closure & Final Reliability Remediation

**Repository:** `jsphhbna/egatepass`  
**Branch:** `main`  
**Production URL:** `https://egatepass.tech`  
**Audit Baseline Date:** November 14, 2026  
**Implementation Commits:** `88b97498` (audit remediation), `cbd44eb7` (test suite alignment)  
**Latest Remote Supabase Migration:** Migration 103 — `20261114000200_psgc_calaca_dacanlao_reconciliation_and_postal_retirement.sql`  
**Five-Stack Ecosystem Restrictions:** GitHub (Repo/CI), Vercel (Hobby Serverless), Supabase (Free-Tier Postgres/Storage), Resend (Transactional Email), Cloudflare (Turnstile). Zero synthetic rows; zero external infrastructure additions.

---

## Section A: Audit Baseline & Root Causes

An independent audit on November 14, 2026 identified several residual reliability, privacy, and data-integrity requirements following earlier releases:
1. **PSGC Nationwide Discrepancy & Calaca Stale Records:** Synthetic duplicate barangay records (e.g. San Rafael `0401007038` in City of Calaca) caused nationwide barangay totals to report 42,011 instead of official PSA Q3 2026 count of 42,010. Active postal code lookup rows (111 active mappings) persisted in `postal_code_reference`.
2. **Returning Biometric Privacy & Misleading Badges:** Legacy code queried `returning_face_templates` fallback, similarity scores were persisted to `returning_identity_attempts`, and provisional 1:1 match visitors saw ambiguous verified indicators instead of explicit instructions to present physical ID to gate guards.
3. **Postal-Code Decommissioning Incompleteness:** Postal codes remained in request/response contracts (`server/routes/passes/issue.ts`, `server/routes/passes/identify-returning.ts`), and profile hydration restored legacy postal codes.
4. **Pass Recovery Deep-Freeze Surface Flaws:** `visitorRegistration.ts` only performed a shallow `Object.freeze()`, leaving nested objects mutable. Exact replays did not fully guard against new upload intents.
5. **Camera Lifecycle Mount/Playback Race:** `useWebcam.ts` permitted `isActive = true` when `videoRef.current` was still null and swallowed `video.play()` rejections.
6. **OCR Timeout Cleanup & Overwriting:** `paddleOcr.ts` initialization timeout did not cancel or discard late-resolving PaddleOCR instances, polluting memory.
7. **Client Typecheck CI Omission:** GitHub Actions CI lacked a dedicated client TypeScript check (`typecheck:client`), allowing frontend type regressions to slip past CI.

All seven priorities were addressed at root cause and verified with automated test suites and live database inspections.

---

## Section B: Priority 0 — Nationwide PSGC & Calaca Reconciliation (Migration 103)

### 1. Database Reconciliation
Forward migration `20261114000200_psgc_calaca_dacanlao_reconciliation_and_postal_retirement.sql` (Migration 103) was generated and applied to the remote Supabase database (`npx supabase db push --remote --yes`).
- **San Rafael Deactivation:** Batangas -> City of Calaca (`0401007000`) -> Barangay San Rafael (`0401007038`) marked `is_active = false`.
- **Dacanlao Canonical Confirmation:** Canonical Barangay Dacanlao (`0401007019`) verified active under Calaca.
- **Postal Mappings Retired:** All active rows in `public.postal_code_reference` deactivated (`is_active = false`).
- **Legacy Function Dropped:** Dropped and revoked `api.enroll_returning_visitor_v1`.
- **Legacy Table Locked:** Revoked all public and authenticated permissions on `public.returning_face_templates`.

### 2. Live Database Verification Evidence
Direct query against remote Supabase confirmed:
- **Total active Philippine barangays:** exactly **42,010** (matching official PSA Q3 2026).
- **Total active NCR barangays:** exactly **1,715**.
- **City of Manila active barangays:** exactly **897**.
- **Municipality of Pateros active barangays:** exactly **10** (under canonical `1381701000`).
- **City of Calaca active barangays:** exactly **39** (San Rafael `0401007038` is `is_active: false`).
- **Active postal code reference rows:** exactly **0** (all 111 deactivated).
- Verification script `scripts/verify-and-report-ncr-psgc.mjs` outputs `allLgusVerifiedMatch: true`, status `RECONCILED_AND_CONFIRMED`.

---

## Section C: Priority 1 — Returning Biometric Privacy & Truthful Messaging

### 1. Zero Template Fallback & Ephemeral Comparison
- Removed `decryptFaceTemplate` import and all fallback logic querying `public.returning_face_templates` from `server/routes/passes/identify-returning.ts`.
- Removed `returning_face_templates` SELECT grant from `server/privilege-contract.ts` (verified via `tests/service-role-privilege-contract.test.ts` — 5/5 PASS).
- Stopped persisting biometric similarity scores: `best_score: null` is written to `returning_identity_attempts`.
- Removed raw similarity/threshold metrics from visitor-facing HTTP responses.

### 2. Capabilities Endpoint Truthfulness
- `server/routes/passes/capabilities.ts` reports:
  - `returningEnrollmentAvailable: false`
  - `biometricStorageRetired: true`
  - Dynamic `turnstileConfigured` without hardcoded booleans.

### 3. Truthful UI Badging (`GetPassPage.tsx`)
- **Calibrated Matches:** Renders green "Biometric Identity Verified" badge.
- **Provisional (Uncalibrated) Matches:** Renders amber "Face Comparison Completed" badge accompanied by explicit requirement: *"Please present your physical ID to the security guard upon arrival for gate verification."* with "ID Required" pill.
- **Historical ID Preview:** Clear warning that physical ID must be inspected by security at the gate.

---

## Section D: Priority 2 — Complete Postal-Code Decommissioning & Legacy Safety

### 1. Server Route Hardening (`server/routes/passes/issue.ts`)
- Explicitly forwards `requested_postal_code: null` and `requested_postal_code_source: null` to RPC `issue_online_pass_v6`.
- Omitted writing postal codes to `returning_visitors` profile updates (`profileUpdate.postal_code` removed).
- Removed `postal_code` from existing visitor replay query. Replay validation only verifies administrative hierarchy (Region, Province, City, Barangay) and street/building, preserving valid replays of historical passes that carried legacy postal codes.

### 2. Frontend Postal Removal
- `src/lib/returningAddressHydration.ts`: Hydration never restores postal codes (`postalCode: ''`, `selectedPsgc.postalCode: undefined`).
- `src/components/AddressCascadingSelector.tsx`: `onSelect` emits only administrative hierarchy (`version`, `region`, `province`, `city`, `barangay`). Zero postal inputs or badges rendered.
- `src/components/StructuredAddressField.tsx` and `src/pages/GetPassPage.tsx`: Zero postal code fields or postal badges.

### 3. Automated Regression Protection
- Added `tests/postal-code-decommissioning.test.ts` (6/6 tests PASS) verifying that locality selection triggers no postal lookup, new issuance omits postal values, and legacy replay is safe.

---

## Section E: Priority 3 — Immutable Deep Freeze & Replay Idempotency

### 1. Recursive Deep Freeze Helper
- Implemented `export function deepFreeze<T>(obj: T): Readonly<T>` in `src/services/visitorRegistration.ts`.
- Deeply freezes `transaction.submittedPayload` including `visitor`, `wirePayload`, `psgc`, `vehicle`, `officeId`, `requestId`, `actorId`, and `returning` references. Modifying any nested property throws `TypeError`.

### 2. Replay Intent Reuse Without New Uploads
- When replaying in `ambiguous`, `dispatched`, or `existing_pass_conflict` phases, `createPass` extracts `photoIntentId`, `idIntentId`, and `vehiclePhotoIntentId` directly from the frozen snapshot and skips all upload operations.
- `shouldReuseUploadedIntentForIssue` extended to return `true` for `existing_pass_conflict` and `dispatched` phases.

### 3. Guard Recovery Over Unsafe Resets
- Replaced dangerous "Start New Pass" button in `existing_pass_conflict` with "Ask Guard for Assistance" (`handleAmbiguousCancelAndAskGuard`).
- If a visitor encounters an ambiguous outcome or existing pass conflict, casual reset (`handleStartOver`) is intercepted and safely directs the visitor to Guard Station assistance.

---

## Section F: Priority 4 — Camera Lifecycle, Mount/Stream Race Elimination & Live-Face Reliability

### 1. Mount & Playback Verification in `src/hooks/useWebcam.ts`
- Implemented reactive ref setter for `videoRef` that resolves mount races between React state transitions and asynchronous `getUserMedia()`.
- Stream is attached to `video.srcObject` and the hook awaits `loadedmetadata` / `canplay` (`video.readyState >= 2`).
- Awaits `video.play()` without swallowing errors. If playback rejects (e.g. autoplay restriction, device busy), the error is caught, stream tracks are terminated, `error` state is set, and `isActive` remains `false`.
- `isActive = true` is set strictly after playback is confirmed.

### 2. Track Teardown & Device Disconnect
- Listens to `track.onended` on media tracks to detect unplugged/disconnected cameras and reset `isActive = false` with visitor-friendly error.
- All tracks are stopped upon unmount, camera stop, camera switch, or error.

---

## Section G: Priority 5 — OCR Timeouts, Generation Tracking & Non-Blocking UX

### 1. Generation-Aware PaddleOCR Lifecycle (`src/lib/paddleOcr.ts`)
- Added generation counters `currentInitGeneration` and `currentPredictionGeneration`.
- If Paddle initialization times out after 15s, `currentInitGeneration` increments. A late-resolving initialization detects generation mismatch, invokes `.terminate()` / `.destroy()` on the late instance, and leaves the cache null.
- `cancelPendingPaddleOcr()` invalidates active predictions when ID images are retaken or replaced.

### 2. Overarching 25-Second Timeout (`src/lib/ocr.ts`)
- Wrapped `recognizeIdImage` in an overarching 25s timeout across the combined PaddleOCR + Tesseract pipeline (`OVERARCHING_OCR_TIMEOUT_MS = 25000`).
- OCR failure or timeout never erases `idBlob` or `idIntentId`. The selected image remains preserved for gate inspection.
- Manual entry is never blocked while OCR is scanning, and late OCR results never overwrite visitor-entered fields (`!currentValues.fieldName?.trim()`).

---

## Section H: Priority 6 — Superadmin Records & Dashboard Verification

### 1. Superadmin Records (`server/routes/admin/records.ts`)
- Verified all queries utilize the canonical database columns: `psgc_region_name`, `psgc_province_name`, `psgc_city_municipality_name`, `psgc_barangay_name`.
- Preserved keyset pagination, date filtering, status filtering, and CSV export without PII leakage.

### 2. Admin Dashboard Aggregates (`server/routes/admin/dashboard.ts`)
- Queries execute RPCs `api.dashboard_calendar_counts` and `api.dashboard_today_insights`.
- Fails closed with honest 503 `service_unavailable` rather than computing inaccurate fallback aggregates.
- Verified with `tests/admin-dashboard-polling.test.ts` (7/7 PASS).

---

## Section I: Priority 7 — Client Typecheck, CI Pipeline & Build Optimization

### 1. Dedicated Client Typecheck Script
- Added `"typecheck:client": "tsc --noEmit"` to `package.json`.
- Added `Typecheck Client & Frontend` step to `.github/workflows/ci.yml`.
- Both `npm run typecheck:api` and `npm run typecheck:client` exit with code 0 (zero TypeScript errors).

### 2. Production Build Verification
- Production build (`npm run build`) completed cleanly with Vite:
  - Asset synchronization confirmed for Tesseract, PaddleOCR worker, and OpenCV assets.
  - Zero chunk budget warnings; all vendor chunks split appropriately.
  - Vercel `includeFiles` scoped strictly to `api/passes.ts`.

---

## Section J: Acceptance Criteria Checklist

| Priority | Requirement | Verification Method | Status |
|---|---|---|---|
| **Priority 0** | Nationwide PSGC count exactly 42,010 | Remote DB query & `scripts/verify-and-report-ncr-psgc.mjs` | **CONFIRMED PASS** |
| **Priority 0** | Calaca San Rafael `0401007038` deactivated | Migration 103 applied to Supabase | **CONFIRMED PASS** |
| **Priority 0** | Postal lookup table deactivated (0 active) | Remote DB query (`is_active = false`) | **CONFIRMED PASS** |
| **Priority 1** | Zero template fallback queries | `privilege-contract.test.ts` (5/5) | **CONFIRMED PASS** |
| **Priority 1** | Truthful provisional badging in GetPassPage | `returning-workflow-separation.test.ts` (26/26) | **CONFIRMED PASS** |
| **Priority 2** | No postal code collected, displayed, or autofilled | `postal-code-decommissioning.test.ts` (6/6) | **CONFIRMED PASS** |
| **Priority 2** | Historical pass replay preserves validity | `issue.ts` regression tests | **CONFIRMED PASS** |
| **Priority 3** | Recursive deep-freeze of submitted payload | `deep-freeze-and-idempotency.test.ts` (3/3) | **CONFIRMED PASS** |
| **Priority 3** | Replays reuse exact intents without uploads | `visitorRegistration.ts` unit tests | **CONFIRMED PASS** |
| **Priority 3** | Guard recovery instead of casual conflict reset | `GetPassPage.tsx` button audit | **CONFIRMED PASS** |
| **Priority 4** | `isActive` set only when playback confirmed | `use-webcam-race.test.ts` & camera tests | **CONFIRMED PASS** |
| **Priority 4** | `video.play()` rejection handled without swallow | `useWebcam.ts` error classification | **CONFIRMED PASS** |
| **Priority 5** | Paddle late initialization cleanly terminated | `paddleOcr.ts` generation tracking | **CONFIRMED PASS** |
| **Priority 5** | 25s overarching OCR pipeline timeout | `ocr.ts` pipeline timeout | **CONFIRMED PASS** |
| **Priority 5** | ID image preserved on OCR timeout/failure | `GetPassPage.tsx` state inspection | **CONFIRMED PASS** |
| **Priority 6** | Superadmin records & dashboard use live schema | `admin-dashboard-polling.test.ts` (7/7) | **CONFIRMED PASS** |
| **Priority 7** | Client TypeScript check in CI | `npm run typecheck:client` & `ci.yml` | **CONFIRMED PASS** |
| **Priority 7** | Clean production build | `npm run build` exits code 0 | **CONFIRMED PASS** |
