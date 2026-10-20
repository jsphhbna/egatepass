# Vercel Preview Deployment Preflight Specification

Last updated: 2026-10-20 (Asia/Manila)
Target repository: `jsphhbna/egatepass` (lowercase only)
Branch: `feat/runtime-migration`
Baseline Commit: `1d281ff9e961d5e6f4628b991ed4bd9fb6f20962`
Execution Mode: Preview Deployment Preflight (READINESS ONLY — NOT A DEPLOYMENT AUTHORIZATION)

---

## 1. Project Configuration & Build Settings

| Setting | Value | Verification |
|---|---|---|
| **Framework Preset** | `Vite` | Verified in `vercel.json` (`"framework": "vite"`) |
| **Root Directory** | `./` | Verified in repository root |
| **Build Command** | `npm run build` (`tsc && vite build`) | Verified exit 0, transforms modules cleanly into `dist/` |
| **Output Directory** | `dist` | Verified standard Vite build target |
| **Node.js Runtime** | Node 20.x or 22.x / Serverless Functions (`api/**/*.ts`) | Standard Vercel Web Handlers returning `Response` |
| **Target Deployment Scope** | **Preview Only** | Production deployment is strictly unauthorized |
| **Regions** | `syd1` (Sydney) | Configured in `vercel.json` |

---

## 2. Environment Variable Scopes & Configuration Matrix

> [!IMPORTANT]
> Never expose server-side secret keys to browser `VITE_*` variables. Vercel project environment variables must be scoped accurately between Client (Browser) and Serverless Functions.

### A. Browser / Client Environment (Exposed to Vite bundle)

| Variable Name | Required Scope | Purpose | Safe Example Format |
|---|---|---|---|
| `VITE_SUPABASE_URL` | Preview & Production | Supabase project REST & Auth base endpoint | `https://<project-ref>.supabase.co` |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | Preview & Production | Supabase anonymous / public Data API key | Public JWT (`eyJhbGci...`) |

### B. Serverless Functions Environment (Server-Side Only)

| Variable Name | Required Scope | Purpose | Isolation Rule |
|---|---|---|---|
| `SUPABASE_URL` | Preview & Production | Internal API client endpoint | Server-only; identical to `VITE_SUPABASE_URL` |
| `SUPABASE_SECRET_KEY` | Preview & Production | Supabase Service Role key (bypasses RLS) | **STRICTLY SERVER-ONLY**; NEVER prefix with `VITE_` |
| `PASS_TOKEN_SECRET` | Preview & Production | HMAC-SHA256 secret for QR digest tokens | **STRICTLY SERVER-ONLY**; 64-character hex or 32+ bytes |
| `RESEND_API_KEY` | Optional / Preview | API key for transactional QR emails | Server-only; mock fallback logs reconciliation if absent |
| `RESEND_FROM_EMAIL` | Optional / Preview | Verified sender email for QR emails | e.g. `EARIST E-GatePass <gatepass@earist.edu.ph>` |

---

## 3. Routing & Static Asset Integrity

### A. Vercel Routing Pipeline (`vercel.json`)
```json
{
  "framework": "vite",
  "regions": ["syd1"],
  "rewrites": [
    { "source": "/((?!api/).*)", "destination": "/index.html" }
  ]
}
```
- **`/api/*`**: Negative lookahead prevents rewrite to `/index.html`. Requests are routed directly to serverless function handlers under `api/`.
- **Filesystem / Static Assets**: In Vercel, static assets in `dist/` take precedence over SPA fallback rewrites.
- **SPA Routes**: `/login`, `/get-pass`, `/kiosk`, `/admin`, `/scan/entry`, `/scan/exit` serve `index.html` with status 200.

### B. Self-Hosted Tesseract OCR Static Assets
Verified present in `public/tesseract/` and output to `dist/tesseract/`:
- `/tesseract/worker.min.js` (JavaScript worker)
- `/tesseract/tesseract-core.wasm` (WASM binary)
- `/tesseract/tesseract-core.wasm.js` (WASM glue)
- `/tesseract/tesseract-core-simd-lstm.wasm` (SIMD WASM)
- `/tesseract/tesseract-core-simd-lstm.wasm.js` (SIMD WASM glue)
- `/tesseract/tesseract-core-lstm.wasm` (LSTM WASM)
- `/tesseract/tesseract-core-lstm.wasm.js` (LSTM WASM glue)
- `/tesseract/eng.traineddata.gz` (Pre-compressed trained language model)

All assets are served statically with appropriate MIME types and without HTML SPA rewrite interference.

---

## 4. Preflight Endpoint Smoke Test Matrix

Verified against local Vercel-equivalent dev runner:

| Route / Method | Expected Status | Expected Content-Type | Role / Protection | Result |
|---|---|---|---|---|
| `GET /` | `200 OK` | `text/html` | Public landing page | **PASS** |
| `GET /login` | `200 OK` | `text/html` | Public login interface | **PASS** |
| `GET /get-pass` | `200 OK` | `text/html` | Public visitor pass registration | **PASS** |
| `GET /kiosk` | `200 OK` | `text/html` | Kiosk route (protected by client Auth guard) | **PASS** |
| `GET /tesseract/worker.min.js` | `200 OK` | `application/javascript` | Static offline OCR worker | **PASS** |
| `GET /tesseract/eng.traineddata.gz` | `200 OK` | `application/gzip` / binary | Static language model | **PASS** |
| `POST /api/passes/issue` | `401 Unauthorized` | `application/json` | Protected pass issuance endpoint | **PASS** |
| `POST /api/passes/email` | `401 Unauthorized` | `application/json` | Protected QR email delivery endpoint | **PASS** |
| `GET /api/admin/users` | `401 Unauthorized` | `application/json` | Protected admin staff endpoint | **PASS** |
| `POST /api/purge-images` | `401 Unauthorized` | `application/json` | Protected superadmin purge endpoint | **PASS** |
| `GET /api/nonexistent` | `404 Not Found` | `application/json` | Fallback for unknown API route | **PASS** |

---

## 5. egatepass-dev Database State & Deployment Readiness Verdict

> [!WARNING]
> **Hosted Supabase Status**: The existing `egatepass-dev` database (`nhoawvkfqblsgutdffie`) currently returns `HTTP 404 / PGRST205` (`Could not find the table 'public.app_settings' in the schema cache`). Migrations 000100 through 001200 have **NOT** yet been executed on that instance.

### Three-Level Deployment Verdict:

1. **Level A: Safe for Frontend-Only Vercel Preview (READY)**
   - The React frontend, routing, EARIST visual identity, offline OCR asset loading, and fallback defaults are verified.
   - Public pages (`/`, `/login`, `/get-pass`) render correctly.
   - If accessed before database migrations are run, `/get-pass` displays an explicit diagnostic log and gracefully falls back to standard operating hours and visitor purpose defaults.

2. **Level B: Safe for Functional Preview with Auth & Pass Lifecycle (PENDING MIGRATION APPROVAL)**
   - Requires separate, explicit owner authorization to execute the migration chain (000100–001200) on `egatepass-dev`.
   - Once applied, staff login, device authentication, pass issuance, QR scanning, and email delivery can be end-to-end verified.
   - Role guards on `/kiosk` and `/admin` MUST NOT be circumvented to simulate functionality.

3. **Level C: Production Cutover (BLOCKED)**
   - Production deployment, DNS modification, or database migration is strictly unauthorized.
   - Production readiness requires live RLS, Storage policies, Resend inbox confirmation, and owner-signed QA runbooks.

---

## 6. Rollback Procedure

If a Preview deployment exhibits unexpected behavior:
1. Delete the Preview deployment in the Vercel dashboard.
2. In Git, revert any checkpoint commit on `feat/runtime-migration`:
   ```bash
   git revert HEAD
   git push origin feat/runtime-migration
   ```
3. Never modify the `main` branch or the backup repository `jsphhbna/E-GATEPASS`.
