# Daily Operations & Administration Guide

This runbook guides system administrators, Super Admins, and security officers in the routine management, incident response, and governance of EARIST E-GatePass.

---

## 1. Identity & Access Management

E-GatePass separates human staff profiles from dedicated scanning devices. All administrative actions require authenticated Supabase sessions and DB-enforced roles.

```mermaid
flowchart TD
    SA[Super Admin]
    Admin[Admin]
    Guard[Guard]
    Device[Scanner Devices]

    SA -->|Create / Deactivate / Promote| Admin
    SA -->|Manage Institutional Settings| Settings[System Settings & Retention]
    Admin -->|Create / Deactivate| Guard
    Admin -->|Register / Revoke| Device
    Guard -->|Operational Review| Passes[Pass Approval / Rejection]
```

### 1.1 Staff Account Management

#### Creating a Staff User
1. Navigate to **Admin Dashboard > Staff Management** (`/admin/users`).
2. Click **Add Staff Member**.
3. Enter legal name, official EARIST email address, and select role (`guard` or `admin`).
4. The serverless route `POST /api/create-user` creates the Supabase Auth identity, inserts the `staff_profiles` row, and triggers an automated invite email via Resend.
5. **Password Onboarding Lifecycle**:
   - **New Guard via `create-user`**: Flagged with `must_change_password = true`.
   - **New Admin via `create-user`**: Flagged with `must_change_password = true`.
   - **Initial bootstrap Super Admin**: Flagged with `must_change_password = true` via `private.bootstrap_super_admin`.
   - **Existing onboarded Admin promoted to Super Admin**: Role updates through Staff Management (`POST /api/update-user` -> `api.update_staff_profile`). Promotion does NOT reset `must_change_password` for an account that has already completed onboarding.
   - Upon initial login for flagged accounts, staff are directed to the mandatory password replacement workflow (`/api/auth/complete-password-change`), which verifies current credentials, updates the password, and finalizes onboarding.

#### Staff Deactivation & Re-activation
- To suspend access, click **Deactivate** on the user row.
- The serverless route `POST /api/update-user` sets `staff_profiles.active = false`.
- Any subsequent API request by that user is immediately rejected with HTTP 403.
- Historical audit events and visit records remain attributed to the user.

#### Super Admin Promotion & Last Super Admin Safeguard
- Only an active Super Admin can promote an existing Admin to Super Admin.
- The system enforces a strict invariant across database and API layers: **The last active Super Admin can NEVER be deactivated or demoted**. This is guarded by the database trigger `private.protect_last_superadmin` on `public.staff_profiles`, enforced by `api.update_staff_profile`, and surfaced by `POST /api/update-user` as HTTP 409 `cannot_remove_last_superadmin` (translated in the Staff Management UI as *"Cannot demote or deactivate the last remaining Super Admin."*).

---

### 1.2 Device Account Management

Dedicated gate hardware (Kiosks, Entry Scanners, Exit Scanners) run authenticated device sessions bound to physical gates.

```mermaid
flowchart LR
    Admin["Admin"] -->|"POST /api/create-device"| API["Vercel API"]
    API -->|"Insert Record"| DB[("Supabase DB: devices")]
    DB -->|"Device Record"| Device["Physical Scanner / Tablet"]
    Admin -->|"DELETE /api/delete-device"| API
    API -->|"Set deleted_at = now()"| DB
```

#### Device Registration
1. In **Admin Dashboard > Device Management** (`/admin/devices`), click **Register New Device**.
2. Specify Device Name, Type (`entry`, `exit`, `kiosk`), and Gate identifier (e.g. `Main Gate`).
3. Note the generated device credentials.
4. On the physical device (e.g. tablet or scanner), log into `/device/login`.

#### Device Revocation
- If a device is lost, stolen, or decommissioned, an Admin clicks **Revoke**.
- The serverless endpoint `DELETE /api/delete-device` sets `deleted_at = now()` and updates status, instantly invalidating its session and preventing further scans.

---

## 2. Daily Visitor & Gate Workflows

### 2.1 Visitor Portal & Kiosk Registration
- **Online Visitors**: Access `https://egatepass.tech`, solve Turnstile, fill out personal and visit details manually or via optional browser-local OCR autofill, capture camera-only facial selfie and valid ID via rear camera or supported image upload (JPEG, PNG, WebP), obtain an issued pass with an EARIST-branded center logo QR code (error correction level H), and secure pass delivery through the verified email delivery gate (or intentionally continue without email after a 5-second timed warning).
- **Walk-in Visitors (Kiosk)**: Use the campus kiosk tablet. Rear camera captures the visitor's valid ID, local Tesseract OCR extracts information for review, front camera captures a selfie, and a QR pass is displayed with a manual "Print Pass" control. (Note: Thermal printer device integration is a planned hardware enhancement. Current kiosk printing relies on the browser/operating-system print path invoked via the Print Pass action).

### 2.2 Gate Entry, Guard Review, and Exit Sequence

```mermaid
sequenceDiagram
    participant V as Visitor
    participant E as Entry Device
    participant API as Vercel API
    participant DB as Supabase DB
    participant G as Guard Console
    participant X as Exit Device

    V->>E: Present QR Code
    E->>API: POST /api/scan-pass (mode: entry)
    API->>DB: RPC api.scan_pass (match token_digest & gate)
    DB-->>API: Valid issued pass
    API->>DB: Transition status -> pending
    API-->>E: Status: Pending Guard Review

    G->>DB: RPC api.guard_dashboard_page (fetch pending queue page)
    DB-->>G: Visitor details & evidence IDs
    G->>API: GET /api/evidence?id={evidence_id}
    API-->>G: Stream photo evidence securely
    G->>API: POST /api/decide-visit { passId, decision: 'approved' | 'rejected' }
    API->>DB: RPC api.decide_visit (atomic transition to inside/rejected)
    DB-->>G: Decision confirmed

    Note over V,G: Visitor completes on-campus business

    V->>X: Present QR Code at gate exit
    X->>API: POST /api/scan-pass (mode: exit)
    API->>DB: RPC api.scan_pass (verify status == inside)
    API->>DB: Atomic transition status -> exited
    DB-->>X: Exit verified. Gate opens.
```

---

## 3. Incident Holds & Evidence Preservation

In the event of an investigation, theft, or security incident on campus, security officers can place an **Incident Hold** on visitor records.

```mermaid
flowchart TD
    Incident["Security Incident Occurs"] --> Staff["Admin / Super Admin"]
    Staff -->|"Select Visitor / Pass"| HoldAction["Enable Incident Hold<br>POST /api/admin/holds"]
    HoldAction --> DB[("public.incident_holds Table")]
    DB --> HoldStatus["active = true"]

    RetentionEngine["Retention Maintenance<br>/api/admin/retention-maintenance"] --> CheckHold{"active hold exists?"}
    CheckHold -->|Yes| Skip["Retain Evidence Indefinitely"]
    CheckHold -->|No| Purge["Purge Storage Object & Mark purged_at"]

    Staff -->|"Investigation Closed"| ReleaseHold["Release Incident Hold<br>PATCH /api/admin/holds"]
    ReleaseHold --> CheckHold
```

1. Navigate to **Admin Dashboard > Visitor Records** or **Incident Holds** (`/admin/holds`).
2. Find the visitor or pass under investigation and click **Place Incident Hold**.
3. Enter the official incident case number and reason.
4. While the hold is active (`active = true`), retention maintenance is suspended for that visitor's records, photos, and ID evidence regardless of age.
5. When cleared, release the hold to return the record to standard retention rules.

---

## 4. Retention Maintenance Operations

Retention policies are designed to support data-minimization and retention practices relevant to the Philippine Data Privacy Act of 2012 (RA 10173).

### Configurable Retention Windows (Super Admin only):
- **Visitor Records**: Default 30 days (Range: 7 to 365 days).
- **Evidence Photos / IDs**: Default 7 days (Range: 1 to 90 days).
- **Standard Audit Logs**: Default 365 days (Range: 90 to 1095 days).
- **Resolved Reconciliation Tasks**: Default 90 days (Range: 30 to 365 days).

### Running Retention Maintenance
- **Execution**: The endpoint `GET/POST /api/admin/retention-maintenance` supports invocation with `Authorization: Bearer <CRON_SECRET>` or an authorized Super Admin session.
- **Manual Execution via Terminal**:
  ```bash
  curl -X POST https://egatepass.tech/api/admin/retention-maintenance \
    -H "Authorization: Bearer <CRON_SECRET>" \
    -H "Content-Type: application/json" \
    -d '{"batchSize": 50, "dryRun": false}'
  ```
- **Safety Invariants**:
  - Passes in status `pending` or `inside` are NEVER purged.
  - Active passes that have not expired are NEVER purged.
  - Any record with an active row in `public.incident_holds` is NEVER purged.
  - Protected audit events are NEVER automatically purged:
    - **Current Canonical Actions**:
      `superadmin.bootstrap`, `staff.create`, `staff.update`,
      `device.create`, `device.update`, `device.retire`, `device.password_update`,
      `settings_updated`, `maintenance.retention_run`,
      `security_hold_created`, `incident_hold.released`
    - Backward-Compatible Legacy Aliases (preserved for historical databases):
      `initial_superadmin_bootstrapped`, `superadmin_created`, `admin_created`, `admin_deleted`,
      `device_registered`, `device_deleted`, `device_credentials_updated`,
      `user_role_and_status_changed`, `user_role_changed`, `user_reactivated`, `user_deactivated`,
      `security_hold_released`
  - **Anonymous Auth Cleanup**:
    - Anonymous Auth cleanup conservatively targets orphan anonymous identities older than 24 hours.
    - Auth users are enumerated with server-side pagination beyond 1,000 users.
    - Destructive candidate deletion strictly respects the configured `batchSize` ceiling per run.
    - Protection lookups (`visitors`, `upload_intents`, `staff_profiles`, `devices`) fail closed: any lookup failure immediately aborts candidate deletion for the entire run, deleting zero users.

---

## 5. Cross-System Reconciliation

When an operation touches multiple external boundaries (e.g. Supabase Auth, Storage, Resend email) and fails midway, a reconciliation task is logged to prevent silent state drift.

```mermaid
flowchart TD
    Err["Partial Failure Detected"] --> Record["Insert into reconciliation_tasks"]
    Record --> SAView["Super Admin Reconciliation View<br>GET, PATCH /api/reconciliation-items"]
    SAView --> Inspect["Inspect Error Details"]
    Inspect --> Action{"Resolution Method"}
    Action -->|Retry Action| Retry["Re-execute Task"]
    Action -->|Compensate| Comp["Revert Local State"]
    Action -->|Manual Fix| Manual["Acknowledge & Mark Resolved"]
```

1. Open **Super Admin Dashboard > Reconciliation**.
2. Review pending or failed tasks via `GET /api/reconciliation-items` and update task status via `PATCH /api/reconciliation-items`.
3. Click **Details** to see the service boundary, payload reference, and error trace.
4. Choose **Retry** to re-dispatch the external call, or **Resolve** once manual corrections are in place.

---

## 6. Email Delivery & Webhook Operations

The platform operates two separate, dedicated webhook flows:
- **Outbound Auth Email Hook** (`POST /api/auth/send-email-hook`): Invoked by Supabase Auth to send transactional emails via React Email and Resend API.
- **Inbound Delivery Observability Webhook** (`POST /api/webhooks/resend`): Invoked by Resend to notify E-GatePass of delivery status (`sent`, `delivered`, `delayed`, `bounced`, `complained`, `failed`).
  - **Provider webhook/signature chain**: Verified operational (historical `email.sent` and `email.delivered` provider events observed in production).
  - **Transactional webhook RPC (`api.record_resend_delivery_event`)**: Deployed, database/test verified, and production-verified with signed delivery events (including historical `email.sent` and `email.delivered` events). Operators should repeat the verification procedure after infrastructure migration.
  - **Atomic Transaction & Replay**: Executed via transactional RPC `api.record_resend_delivery_event` (Migrations `20261023140000` and `20261023160000`). Replays return HTTP 200 `already_processed`. If audit logging fails, transaction rolls back so provider retry can reprocess the event.
- **Webhook Table Retention**: Classified as `OPTIONAL HARDENING — retention period requires explicit policy`. `public.resend_webhook_events` volume is minimal and append-only deduplication remains active.
- **Legacy SMTP Key Cleanup**:
  > [!IMPORTANT]
  > **MANUAL OWNER ACTION REQUIRED**
  > - **Provider**: Resend
  > - **Resource**: API key named `egatepass-supabase-smtp`
  > - **Action**: Revoke/delete the legacy key in Resend dashboard after verifying no SMTP fallback is intentionally retained.
  > - **Impact**: Current Send Email Hook + Resend REST API architecture remains unaffected.

> **CRITICAL NOTICE**: Neither webhook is an inbound email mailbox or interactive reply processor. `notifications@egatepass.tech` is a non-monitored transactional sender identity.

If a staff member or visitor reports non-receipt of an email:

1. **Verify Sender & Domain Status**:
   - In Resend Dashboard, verify `egatepass.tech` domain is verified with DKIM and SPF.
2. **Inspect Outbound Send Email Hook Logs**:
   - In Vercel Logs, filter by `/api/auth/send-email-hook`. Ensure HTTP 200 responses.
3. **Inspect Inbound Resend Webhook Logs**:
   - In Vercel Logs, filter by `/api/webhooks/resend`. Ensure incoming delivery events return HTTP 200.
4. **Resend Delivery Activity**:
   - Inspect the Resend dashboard Logs tab to view delivery status (`Delivered`, `Bounced`, or `Complained`).

---

## 7. MXW01 Thermal Printing Operations

The kiosk station operates a single dedicated **MXW01 Bluetooth thermal receipt printer** (384px print width) for printing paper passes for walk-in visitors:

### 7.1 Single Printer Architecture
- **Kiosk-Only Ownership**: The single physical MXW01 printer is paired and controlled exclusively by the **kiosk tablet browser** via Web Bluetooth.
- **No Guard Printer**: Gate guards do not maintain physical printers. All printed passes originate at the kiosk station.

### 7.2 Initial Setup & Pairing Procedure
1. Power on the MXW01 printer (hold power button until blue LED flashes).
2. On the kiosk tablet, open the `/kiosk` page.
3. Tap the **Gear Icon** in the top-right corner to open **Device Settings**.
4. Enter the Kiosk Operator PIN (default `123456`).
5. In the Thermal Printer section, tap **Connect MXW01**.
6. The Chromium Bluetooth device picker will appear. Select the MXW01 / PeriPage device and tap **Pair**.
7. Confirm status changes to **Connected** (Green badge).
8. Tap **Test Print** to verify paper alignment, darkness, and cutter feed.

### 7.3 Daily Operation & Maintenance
- **Auto-Print**: When enabled, the kiosk automatically sends the 384px raster print job to the printer immediately upon successful pass creation.
- **Fail-Safe Invariant**: If the printer disconnects, runs out of paper, or suffers a Bluetooth timeout, the pass is **NOT** cancelled or rolled back. The visitor is presented with a clear notice, and the operator or visitor can tap **Print Again** or **Browser Print** (falling back to the standard system print dialog).
- **Paper Roll Replacement**: Use standard 57mm × 30mm thermal receipt rolls. Ensure the thermal-coated side faces the thermal head (paper feeds from underneath).

---

## 8. Super Admin Thermal Template Management

Super Admins configure and publish the visual layout of printed thermal tickets via the built-in layout editor at `/admin/templates`:

### 8.1 Authorization & Access Control
- **Super Admin Exclusive**: Only users with the `superadmin` role may create, edit, publish, or restore thermal templates.
- **Guards and Admins**: Have zero access to template editing.
- **Kiosk Devices**: Only retrieve the active published template for rendering.

### 8.2 Template Invariants & Validation
- **Canvas Width**: Fixed at native 384 pixels.
- **Mandatory Elements**: The template schema enforces the permanent existence of:
  - Institution Logo (`institution_logo`)
  - Institution Name (`institution_name`)
  - Visitor Full Name (`visitor_name`)
  - Visit Date (`visit_date`)
  - Opaque Pass QR Code (`qr_code`)
  - Pass Reference (`pass_reference`)
- Mandatory elements cannot be deleted from a publishable template.
- **Security Validation**: All template layouts are validated against a strict server-side Zod schema. Remote URLs, scripts, and arbitrary HTML are rejected.
- **Bundled Fallback**: If network connectivity fails or remote template data cannot be parsed, the kiosk automatically falls back to an embedded known-good default template.

---

## 9. Guard Visitor Recovery Operations

When a registered visitor arrives at the gate but cannot present their QR code (e.g. lost phone, dead battery, misplaced email):

### 9.1 Recovery Search Scope
1. On the **Guard Console** (`/guard`), tap the **Visitor Recovery** tab.
2. The search scope is strictly bounded to **today's date in Asia/Manila** and active passes (`issued`, `pending`, `inside`).
3. Search by **Visitor Full Name**, **Contact Number**, or **Pass Reference** (`EG-XXXXXXXX`).

### 9.2 Identity Verification & Evidence Review
1. Tap on the matching visitor record to expand details.
2. Review the visitor's registration photo selfie and captured valid ID streamed securely via `GET /api/evidence?id=<evidence_id>`.
3. Require the visitor to present a physical government ID and physically verify identity against the displayed evidence.

### 9.3 Manual Operational Actions
- **Approve Entry**: If the visitor is in `issued` or `pending` status and identity is verified, tap **Approve Entry**. The pass status transitions to `inside` and the audit event records `action = 'approve_entry'`, `source = 'visitor_recovery'`.
- **Reject Entry**: If identity or credentials fail physical verification, tap **Reject Entry** and record the reason.
- **Record Exit**: If an un-exited visitor is leaving and cannot present their QR code, the Guard verifies the record and taps **Record Exit** to transition the pass to `exited`.

---

## 10. Guard Offline Operations & Connectivity Outage Procedures

In the event of an institutional network outage, fiber cut, or cloud service disruption:

### 10.1 System-Wide Fail-Closed Invariants
- **Kiosk Station**: Immediately disables visitor registration. The screen displays:
  ```text
  SERVICE TEMPORARILY UNAVAILABLE
  Visitor registration is currently unavailable.
  Please proceed directly to the Guard for registration and verification.
  ```
- **Entry & Exit Scanners**: Scan submissions fail closed. The scanner displays a prominent network failure notice directing the visitor to the Guard. The scanner does **NOT** falsely report the QR code as invalid, expired, or forged.

### 10.2 Guard Operational Fallback
The Guard tablet serves as the sole operational access authority during an outage:
1. **Offline Banner**: When the backend cannot be reached, the Guard Console displays a yellow/red offline banner indicating offline operation and the count of un-synchronized outbox records.
2. **Offline Recovery of Existing Visitors**:
   - The Guard searches the local IndexedDB cache (automatically populated with today's operational passes while online).
   - The Guard performs physical identity verification using cached visitor evidence.
   - Guard taps **Approve Entry** or **Record Exit**.
   - The action is appended to the local IndexedDB event outbox with an immutable UUID `eventId`.
3. **Offline Walk-in Intake**:
   - For unregistered walk-in visitors, the Guard opens the **Offline Registration** tab.
   - The Guard physically inspects the visitor's physical government ID.
   - The Guard enters visitor name, contact, purpose, and captures a live facial photo and valid ID photo using the tablet camera.
   - The Guard taps **Approve Entry** (recording Time-In automatically) or **Reject Entry**.
   - An immutable UUID `offlineRegistrationId` is stamped, and the record is stored locally in IndexedDB.

### 10.3 Automatic Reconnection Synchronization
When cloud connectivity returns:
1. The Guard Console detects connectivity and initiates background synchronization via `guardSyncManager.ts`.
2. Offline walk-in registrations synchronize first via `api.sync_offline_registration` (uploading evidence photos, creating canonical visitor and pass records).
3. Queued lifecycle events synchronize via `api.sync_offline_event` (evaluating prior state, locking rows with `FOR UPDATE`, and transitioning pass status).
4. Synchronized entries are acknowledged and safely purged from the local device store.
5. In the rare event of a state conflict (e.g. visitor was already rejected online prior to outage), a reconciliation record is logged in `public.reconciliation_tasks` for administrative review without overwriting data.

