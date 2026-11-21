# EARIST E-GatePass: Campus Visitor Access Management System
## Architectural & Engineering System Diagrams Documentation

**Institution**: Eulogio "Amang" Rodriguez Institute of Science and Technology (EARIST)  
**College**: College of Computer Studies — Bachelor of Science in Information Technology  
**Proponents**: Mary Joy Cagande, Joseph Habana, Mon Gerald Lanon, Jeferson Tambis  
**Thesis Adviser**: Dhani San Jose  
**Date**: November 2026  
**Document Format**: Academic Thesis System Documentation Suite  

---

### Table of Contents
1. [Diagram 1: Data Flow Diagram — Context Diagram (Level 0)](#1-data-flow-diagram--context-diagram-level-0)
2. [Diagram 2: System Use Case Diagram](#2-system-use-case-diagram)
3. [Diagram 3: System Activity Flowchart (Lifecycle Workflow)](#3-system-activity-flowchart-lifecycle-workflow)
4. [Diagram 4: Data Flow Diagram (DFD Level 1 — Process Decomposition)](#4-data-flow-diagram-dfd-level-1--process-decomposition)
5. [Diagram 5: Architectural Framework (4-Tier Structural Architecture)](#5-architectural-framework-4-tier-structural-architecture)
6. [Diagram 6: Subsystem Block Diagram (Hardware & Software Modules)](#6-subsystem-block-diagram-hardware--software-modules)
7. [Diagram 7: Zero-Trust Network & Infrastructure Topology](#7-zero-trust-network--infrastructure-topology)
8. [Diagram 8: Conceptual Framework (Input-Process-Output Model)](#8-conceptual-framework-input-process-output-model)
9. [Diagram 9: Crow's Foot Entity Relationship Diagram (ERD)](#9-crows-foot-entity-relationship-diagram-erd)
10. [Diagram 10: Physical Database Schema (PostgreSQL 15 RLS Tables)](#10-physical-database-schema-postgresql-15-rls-tables)

---

### 1. Data Flow Diagram — Context Diagram (Level 0)
![Context Diagram Level 0](../diagram-output/egatepass-dfd-context-level-0.png)

#### Detailed Description
The Context Diagram defines the highest-level operational boundary of the EARIST E-GatePass System (Process 0). It illustrates all primary external human actors and external verification services that interface directly with the central platform.

- **Campus Visitor**: Submits pre-registration or walk-in registration details including personal identity attributes, PSGC-compliant residential address selections, vehicle declarations (plate number, type, model), captured physical government/institutional ID photos, and live portrait selfies. Receives interactive registration status, cryptographic HMAC-SHA256 QR gate passes, and pass revocation/expiry notifications.
- **Campus Security Personnel / Guard**: Scans visitor QR passes at physical gate terminals, views authenticated visitor profiles with real-time pass validity, records manual emergency checkpoints, overrides unauthorized entries, and inspects verified visitor history.
- **Institutional Administrator**: Manages campus visiting schedules, configures gate operational hours, sets visitor quotas per department, reviews immutable security audit trails, and audits campus security reports.
- **Resend Transactional Mailer**: Receives automated transactional email dispatch payloads containing branded visitor digital gate passes, receipt confirmations, and dynamic cancellation notices.
- **Cloudflare Turnstile**: Receives client cryptographic challenge verification tokens and returns bot-mitigation confidence scores, safeguarding public portal registration routes from automated credential stuffing and DDoS attacks.
- **PSA Philippine Standard Geographic Code (PSGC)**: Provides real-time cascading administrative geographic boundaries (Region, Province, City/Municipality, Barangay) preventing fraudulent or malformed residential data entry.
- **NHTSA Vehicle Identification Engine**: Validates declared vehicle specifications, auto-matching make, model, and vehicle class to prevent unauthorized vehicular campus ingress.

---

### 2. System Use Case Diagram
![Use Case Diagram](../diagram-output/egatepass-use-case-diagram.png)

#### Detailed Description
The Use Case Diagram defines the functional interactions between human and automated system actors and the EARIST E-GatePass core software application.

- **Visitor Actor Capabilities**:
  - `Pre-Register Online`: Visitors submit prospective visit details via web portal up to 7 days in advance.
  - `Walk-In Kiosk Registration`: Visitors utilize touch kiosks at campus entrances for on-the-spot registration with local OCR and portrait capture.
  - `Capture Live Portrait & ID`: Visitors provide identity evidence with client-side quality validation.
  - `Receive Digital QR Gate Pass`: Successful applicants obtain cryptographic QR passes with offline recovery payloads.
  - `Cancel Registration`: Visitors can abort registration at any point prior to issuance, triggering immediate purge of staged upload assets.
- **Campus Security Personnel (Guard) Capabilities**:
  - `Scan & Validate QR Gate Pass`: Guard terminals decode QR tokens, verifying digital signatures and temporal validity windows.
  - `Perform Visual Identity Verification`: Side-by-side verification of live visitor against stored government ID and live selfie.
  - `Execute Guard Gate Override / Offline Scan`: Emergency bypass and cached SQLite/IndexedDB pass validation during campus WAN disruptions.
- **Institutional Administrator Capabilities**:
  - `Manage Campus Operational Parameters`: Configures visiting hours, department quotas, and emergency blackout intervals.
  - `Monitor Real-Time Campus Ingress/Egress`: Live dashboard tracking active on-campus population counts.
  - `Audit Security Ledger & Incident Logs`: Access to tamper-evident audit logs with cryptographic hash chain verification.
- **Cloudflare Turnstile & Resend Services**:
  - `Verify Bot Defense Challenge`: Automatic validation of human presence before form submission.
  - `Deliver Digital Pass Email`: Automated multi-part email transmission with branded pass cards and thermal printer output.

---

### 3. System Activity Flowchart (Lifecycle Workflow)
![Activity Flowchart](../diagram-output/egatepass-activity-flowchart.png)

#### Detailed Description
The Activity Flowchart tracks the sequential, end-to-end operational lifecycle of a visitor's engagement with EARIST campus facilities.

1. **Initiation**: The visitor chooses between Pre-Registration (Online Portal) or Walk-in Registration (Touch Kiosk).
2. **Security & Privacy Gating**: Verification of Cloudflare Turnstile token followed by explicit Republic Act 10173 (Data Privacy Act of 2012) consent capture.
3. **Information & Identification Submission**: Entry of personal identity attributes, PSGC cascading address, destination office, visit purpose, and optional vehicle declaration.
4. **Biometric & Document Evidence Capture**: High-resolution ID document submission (with on-device PaddleOCR/Tesseract parsing) and live portrait selfie capture with oval guide validation.
5. **Pre-Issuance Cancellation Boundary**: If the visitor cancels or closes the session before completion, an immediate cleanup signal is dispatched to `/api/passes/abandon-intent`, executing database expiry and purging uncommitted storage files.
6. **Pass Generation & Cryptographic Issuance**: Server verifies business logic, schedules visit windows, generates HMAC-SHA256 encrypted QR tokens, and issues the digital gate pass.
7. **Gate Arrival & Optical Ingress Inspection**: Campus security scans the QR pass. The system validates signature integrity, temporal validity, and campus entry status. On approval, entry timestamp is logged.
8. **Campus Exit & Lifecycle Termination**: Visitor presents QR pass at exit turnstile. The system logs departure timestamp and permanently transitions the pass state to `completed`.

---

### 4. Data Flow Diagram (DFD Level 1 — Process Decomposition)
![DFD Level 1](../diagram-output/egatepass-dfd-level-1.png)

#### Detailed Description
Decomposes the core system into six major logical processing units and five persistent relational data stores:

- **Process 1.0 (Identity Intake & Pre-Registration)**: Ingests visitor personal info, performs Turnstile verification, and writes staged records to `D1: Upload Intents`.
- **Process 2.0 (Identity Verification & OCR Processing)**: Executes document quality inspection, extracts textual fields via OCR, validates live face capture, and cross-references `D2: Visitors & Returning Profiles`.
- **Process 3.0 (Gate Pass Generation & Token Issuance)**: Assembles validated registration payload, executes database transaction, generates HMAC QR tokens, and commits finalized records to `D3: Digital Passes & QR Registry`.
- **Process 4.0 (Optical Scanning & Access Control Enforcement)**: Intercepts camera QR scan feed, decodes encrypted payload, evaluates time window and blacklists, updates active campus headcount, and records ingress events in `D4: Entry / Exit Logs`.
- **Process 5.0 (Security Audit Logging & Real-Time Monitoring)**: Records all user actions, security overrides, and credential transitions into `D5: Security Audit Ledger`.
- **Process 6.0 (Automated Notification & Offline Synchronization)**: Manages outbound Resend email delivery and synchronizes cached offline gate scans upon WAN restoration.

---

### 5. Architectural Framework (4-Tier Structural Architecture)
![Architectural Framework](../diagram-output/egatepass-architectural-framework.png)

#### Detailed Description
Visualizes the multi-tier enterprise architecture of the EARIST E-GatePass platform:

- **Tier 1: Presentation Tier (Client Applications)**: React 19 SPA running Vite, Tailwind CSS, Lucide icons, HTML5-QRCode, and Web Audio API. Comprises Public Visitor Portal, Walk-In Touch Kiosk, Security Guard Scanner View, and Administrator Control Center.
- **Tier 2: Edge & Security Ingress Tier**: Cloudflare DNS, CDN edge caching, Turnstile CAPTCHA validation, and Vercel Edge Middleware handling request routing and security headers (CSP, HSTS, X-Content-Type-Options).
- **Tier 3: Application & Backend API Services Tier**: Node.js/Vite serverless functions and SSR API routes handling session verification, visitor registration workflows, pass issuance, thermal print formatting, and transactional email triggers.
- **Tier 4: Enterprise Data & Cloud Persistence Tier**: Supabase PostgreSQL 15 database engine with strict Row-Level Security (RLS), Supabase S3 Object Storage buckets (`id-documents`, `visitor-portraits`, `vehicle-evidence`), and local IndexedDB offline storage caches.

---

### 6. Subsystem Block Diagram (Hardware & Software Modules)
![Block Diagram](../diagram-output/egatepass-block-diagram.png)

#### Detailed Description
Maps the discrete functional hardware and software modules comprising the complete platform:

- **Visitor Intake Subsystem**: Handles browser webcam streams, file upload buffers, mobile responsive controls, and Turnstile challenge widgets.
- **Verification & OCR Engine Subsystem**: Manages client-side PaddleOCR/Tesseract.js WebAssembly workers, facial bounding box geometry analyzers, and PSGC address cascading matchers.
- **Access Control & Scanner Subsystem**: Interfaces with gate cameras, html5-qrcode video decoding buffers, continuous autofocus controllers, and audio chime synthesizers.
- **Reporting & Administration Subsystem**: Generates administrative reports, manages real-time population gauges, tracks active vehicle slots, and audits security events.
- **Hardware Peripherals & Physical Layer**: Incorporates USB HD Webcams, 80mm ESC/POS thermal receipt printers, QR barcode scanners, and touchscreen tablet displays.

---

### 7. Zero-Trust Network & Infrastructure Topology
![Network Diagram](../diagram-output/egatepass-network-diagram.png)

#### Detailed Description
Illustrates the physical and logical network segmentation, encryption boundaries, and protocol safeguards across all zones:

- **Untrusted Public Internet Zone**: Personal visitor mobile devices, desktop browsers, and kiosk hardware communicating strictly over TLS 1.3 / HTTPS (Port 443).
- **Edge Security & Routing Perimeter**: Cloudflare DDoS mitigation, WAF inspection, and Vercel Global Edge network terminating client SSL connections.
- **Campus Intranet & Gate Security Enclave**: Dedicated EARIST physical security network, isolating gate guard scanning terminals and local thermal printing bridges.
- **Protected Cloud Backend & Database VPC**: Supabase PostgreSQL database cluster protected by database firewalls, role-based database privileges, encrypted S3 storage buckets, and encrypted REST APIs.

---

### 8. Conceptual Framework (Input-Process-Output Model)
![Conceptual Framework](../diagram-output/egatepass-conceptual-framework.png)

#### Detailed Description
Outlines the research paradigm following the classic Input-Process-Output (IPO) methodology:

- **Input (System Requirements & Information Inputs)**: Republic Act 10173 Data Privacy compliance guidelines, EARIST institutional visiting policies, visitor registration information, physical ID documents, facial selfies, and vehicle records.
- **Process (System Transformations & Engineering Operations)**: Edge security verification, OCR parsing, facial bounding box validation, cryptographic HMAC QR token generation, gate scanning validation, and automated email dispatching.
- **Output (Measurable System Artifacts & Institutional Benefits)**: Digitally verified single-use gate passes, accelerated gate ingress (< 3 seconds per visitor), real-time campus population counts, verifiable vehicle records, and immutable security audit logs.

---

### 9. Crow's Foot Entity Relationship Diagram (ERD)
![Entity Relationship Diagram](../diagram-output/egatepass-entity-relationship-diagram.png)

#### Detailed Description
Defines the conceptual and logical relational data model governing the database:

- **VISITORS (1) ───< (M) PASSES**: One visitor can possess multiple historical digital gate passes across different visit dates.
- **PASSES (1) ───< (M) ENTRY_EXIT_LOGS**: Each pass is linked to one or more physical gate ingress/egress checkpoint scans.
- **PASSES (1) ─── 0..1 VISIT_VEHICLE_DECLARATIONS**: A pass may optionally be associated with exactly one vehicular declaration.
- **VISITORS (1) ───< (M) UPLOAD_INTENTS**: Staged document uploads are tracked under visitor ownership for audit and lifecycle management.
- **USERS (1) ───< (M) AUDIT_LOGS**: System security guards and administrators generate audit trail records for all privileged operations.

---

### 10. Physical Database Schema (PostgreSQL 15 RLS Tables)
![Database Schema](../diagram-output/egatepass-database-schema.png)

#### Detailed Description
Details the physical relational table structures, column definitions, data types, primary/foreign keys, and constraints implemented in Supabase PostgreSQL:

- **`visitors`**: `id` (UUID PK), `first_name` (VARCHAR), `last_name` (VARCHAR), `email` (VARCHAR), `contact_number` (VARCHAR), `barangay` (VARCHAR), `city_municipality` (VARCHAR), `province` (VARCHAR), `region` (VARCHAR), `created_at` (TIMESTAMPTZ).
- **`passes`**: `id` (UUID PK), `visitor_id` (UUID FK), `visit_date` (DATE), `purpose` (VARCHAR), `status` (VARCHAR), `entry_time` (TIMESTAMPTZ), `exit_time` (TIMESTAMPTZ), `qr_code_hash` (TEXT), `created_at` (TIMESTAMPTZ).
- **`entry_exit_logs`**: `id` (UUID PK), `pass_id` (UUID FK), `scan_type` (VARCHAR: `entry` | `exit`), `scanned_by` (UUID FK), `gate_number` (VARCHAR), `timestamp` (TIMESTAMPTZ), `offline_synced` (BOOLEAN).
- **`visit_vehicle_declarations`**: `id` (UUID PK), `pass_id` (UUID FK UNIQUE), `vehicle_type` (VARCHAR), `plate_number` (VARCHAR), `make_model` (VARCHAR), `color` (VARCHAR).
- **`upload_intents`**: `id` (UUID PK), `owner_id` (UUID), `kind` (VARCHAR), `status` (VARCHAR: `pending` | `claimed` | `expired`), `bucket_id` (VARCHAR), `object_path` (TEXT), `created_at` (TIMESTAMPTZ).
- **`audit_logs`**: `id` (UUID PK), `actor_id` (UUID FK), `action` (VARCHAR), `target_entity` (VARCHAR), `target_id` (UUID), `ip_address` (INET), `created_at` (TIMESTAMPTZ).

---
*Generated for the EARIST E-GatePass Capstone Project, November 2026.*
