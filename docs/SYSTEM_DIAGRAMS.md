# EARIST E-GatePass — System Architecture & Engineering Diagrams Documentation

### Eulogio "Amang" Rodriguez Institute of Science and Technology
**College of Engineering / College of Computer Studies**  
**Capstone Project Technical Documentation**

---

- **Project:** EARIST E-GatePass Visitor Access Management System
- **Repository:** `jsphhbna/egatepass`
- **Production Domain:** [https://egatepass.tech](https://egatepass.tech)
- **Capstone Proponents:** Mary Joy Cagande, Joseph Habana, Mon Gerald Lanon, and Jeferson Tambis
- **Capstone Adviser:** Dhani San Jose
- **Academic Year:** 2026–2027 | November 2026
- **Word Document (.docx) Deliverable:** [`diagram-output/EARIST_E-GatePass_System_Diagrams_Documentation.docx`](file:///C:/Users/Administrator/Downloads/egatepass/diagram-output/EARIST_E-GatePass_System_Diagrams_Documentation.docx)

---

## Deliverables Summary

All 10 system diagrams are rendered strictly according to the **Academic Black and White Standard** (`#000000` text, lines, borders on a `#FFFFFF` canvas) at **300-DPI equivalent High-Resolution Print Quality**. Each diagram is available as a High-Res PNG, Scalable Vector Graphic (SVG), and editable Draw.io XML (`.drawio`) file in [`diagram-output/`](file:///C:/Users/Administrator/Downloads/egatepass/diagram-output):

1. **Figure 1: Context Diagram (Level 0 DFD)** — Gane & Sarson / Yourdon & DeMarco Notation
2. **Figure 2: Use Case Diagram** — UML 2.5 Use Case Specification
3. **Figure 3: Activity Flow Chart** — UML 2.5 Swimlane Activity Model
4. **Figure 4: Data Flow Diagram (Level 1 Decomposition)** — DFD Level 1
5. **Figure 5: Multi-Tier Architectural Framework** — 5-Tier Layered Software Architecture
6. **Figure 6: System Block Diagram** — IEEE Subsystem Interconnection Model
7. **Figure 7: Physical & Logical Network Topology Diagram** — Campus Network & Cloud Infrastructure
8. **Figure 8: Conceptual Framework (IPO Model)** — Input-Process-Output Research Paradigm
9. **Figure 9: Entity Relationship Diagram (ERD)** — Crow's Foot Relational Data Model
10. **Figure 10: Physical Database Schema Diagram** — PostgreSQL 15 Physical Schema

---

## 1. Context Diagram (Data Flow Diagram Level 0)

![Figure 1: Context Diagram](file:///C:/Users/Administrator/Downloads/egatepass/diagram-output/egatepass-dfd-context-level-0.png)

- **Deliverables:** [PNG](file:///C:/Users/Administrator/Downloads/egatepass/diagram-output/egatepass-dfd-context-level-0.png) | [SVG](file:///C:/Users/Administrator/Downloads/egatepass/diagram-output/egatepass-dfd-context-level-0.svg) | [Draw.io](file:///C:/Users/Administrator/Downloads/egatepass/diagram-output/egatepass-dfd-context-level-0.drawio)
- **Standard / Model Notation:** Gane & Sarson / Yourdon & DeMarco DFD Notation
- **Architectural Scope & Boundary:**
  - **Process 0 (Central System):** Encapsulates the complete E-GatePass application, including the Next.js frontend, Vercel serverless function runtime, PostgreSQL database, and Supabase Object Storage.
  - **Human Actors:**
    - `Visitor`: Submits personal registration information, ID document snapshots, and live webcam portraits via `/get-pass` or `/kiosk`; receives dynamic QR passes and email confirmations.
    - `Security Personnel / Guard`: Scans visitor QR passes via optical turnstile cameras; receives visitor validation dossiers (photo, ID snapshot, destination, vehicle details) and live campus occupancy headcounts.
    - `Campus Office Personnel`: Reviews appointment requests via `/office`; approves, rejects, or reschedules visits.
    - `System Administrator`: Configures campus calendar closures, manages staff accounts, and oversees security audit logs via `/admin/*`.
  - **Verified External Cloud Services:**
    - `Cloudflare Turnstile`: Validates cryptographic bot mitigation tokens (`challenges.cloudflare.com/turnstile/v0/siteverify`).
    - `Resend Email Service`: Dispatches transactional HTML pass receipts and office approval alerts (`api.resend.com/emails`).
    - `NHTSA vPIC API`: Decodes vehicle VIN and model catalog information (`vpic.nhtsa.dot.gov/api/vehicles/`).
  - **Internalized Datastores:** PostgreSQL/Supabase and Vercel hosting are modeled inside the system boundary. PSA PSGC data is internalized into database table `psgc_locations` and bundled datasets; Geoapify is inactive.

---

## 2. Use Case Diagram

![Figure 2: Use Case Diagram](file:///C:/Users/Administrator/Downloads/egatepass/diagram-output/egatepass-use-case-diagram.png)

- **Deliverables:** [PNG](file:///C:/Users/Administrator/Downloads/egatepass/diagram-output/egatepass-use-case-diagram.png) | [SVG](file:///C:/Users/Administrator/Downloads/egatepass/diagram-output/egatepass-use-case-diagram.svg) | [Draw.io](file:///C:/Users/Administrator/Downloads/egatepass/diagram-output/egatepass-use-case-diagram.drawio)
- **Standard / Model Notation:** UML 2.5 Use Case Specification Standard
- **Architectural Scope & Boundary:**
  - **Primary Human Actors:** Visitor, Returning Visitor, Security Guard, Campus Office Staff, and System Administrator.
  - **Supporting External Actors:** Cloudflare Turnstile (Bot Engine), NHTSA vPIC (Vehicle Registry), and Resend (Email Engine).
  - **`<<include>>` Dependencies:**
    - `UC1 (Online Pre-Registration)` and `UC2 (Kiosk Walk-In)` unconditionally include `UC5 (Capture & Verify ID Document via OCR)` and `UC6 (Capture Live Biometric Facial Portrait)`.
    - `UC1` includes `UC7 (Verify Humanity via Turnstile Challenge)`.
    - Registration flows include `UC9 (Issue Digital Gate Pass)`, which in turn includes `UC10 (Dispatch Pass Email)`.
    - Gate Scanning (`UC12`) includes `UC13 (Inspect Visitor Details)` and `UC14 (Authorize / Deny Physical Campus Access)`.
  - **`<<extend>>` Dependencies:**
    - `UC3 (Re-Identify Visitor via Facial Vector / Phone)` extends registration when recurring visitor history exists.
    - `UC8 (Declare Vehicle)` extends registration conditionally when vehicular entry is required.
    - `UC19 (Emergency Lockdown)` conditionally overrides `UC14 (Authorize Access)` to enforce an immediate gate freeze.

---

## 3. Activity Flow Chart (UML Swimlane Model)

![Figure 3: Activity Flow Chart](file:///C:/Users/Administrator/Downloads/egatepass/diagram-output/egatepass-activity-flowchart.png)

- **Deliverables:** [PNG](file:///C:/Users/Administrator/Downloads/egatepass/diagram-output/egatepass-activity-flowchart.png) | [SVG](file:///C:/Users/Administrator/Downloads/egatepass/diagram-output/egatepass-activity-flowchart.svg) | [Draw.io](file:///C:/Users/Administrator/Downloads/egatepass/diagram-output/egatepass-activity-flowchart.drawio)
- **Standard / Model Notation:** UML 2.5 Activity Diagram with Swimlane Partitioning
- **Swimlane Execution Architecture:**
  - **1. Visitor (Mobile / Kiosk):** Selects registration type (Pre-Registration or Walk-in), inputs required biological sex, contact, purpose, and PSGC address, captures ID and live webcam selfie, receives dynamic QR pass, presents pass to gate scanner, and departs campus.
  - **2. Frontend Client (React 19 SPA):** Runs client-side form validation, Tesseract.js WebAssembly OCR text extraction, live webcam liveness and blur checking, camera unmirroring calibration, and transient buffer purging upon cancellation.
  - **3. Backend Services & Edge APIs:** Evaluates Turnstile challenge tokens, queries returning visitor history, normalizes vehicle information, invokes atomic pass issuance (`api.issue_pass`), and dispatches transactional confirmation emails via Resend.
  - **4. PostgreSQL & Supabase Storage:** Enforces Row Level Security (RLS), commits transactional records, verifies 32-byte SHA-256 token digests, logs timestamped `visit_events`, and tracks real-time occupancy.
  - **5. Campus Security & Office Host:** Host offices review restricted visit requests on `/office`; security guards inspect visitor dossiers on `/guard` and authorize physical barrier unlocking.

---

## 4. Data Flow Diagram — Level 1 Decomposition

![Figure 4: Data Flow Diagram Level 1](file:///C:/Users/Administrator/Downloads/egatepass/diagram-output/egatepass-dfd-level-1.png)

- **Deliverables:** [PNG](file:///C:/Users/Administrator/Downloads/egatepass/diagram-output/egatepass-dfd-level-1.png) | [SVG](file:///C:/Users/Administrator/Downloads/egatepass/diagram-output/egatepass-dfd-level-1.svg) | [Draw.io](file:///C:/Users/Administrator/Downloads/egatepass/diagram-output/egatepass-dfd-level-1.drawio)
- **Standard / Model Notation:** Gane & Sarson DFD Level 1 Functional Decomposition
- **Functional Decomposition:**
  - `1.0 Visitor Registration & Biometric Verification`: Ingests personal registration info, validates PSGC locations against `D4`, processes ID card images via OCR, captures live webcam portraits, and validates Turnstile siteverify tokens.
  - `2.0 Campus Office Visit Request Governance`: Routes visit requests to host departments, checks office working hours and calendar closures in `D3`, and records approval/rejection decisions.
  - `3.0 Gate Pass Issuance & QR Token Cryptography`: Generates 32-byte SHA-256 HMAC token digests, executes atomic `api.issue_pass` commits to `D1` and `D2`, and triggers Resend confirmation emails.
  - `4.0 Physical Gate Access Scanning & Validation`: Ingests optical QR video frames from guards, validates token digests against `D2`, checks calendar closures in `D3`, updates pass status, and logs gate entry/exit events to `D5`.
  - `5.0 Security Monitoring, Audit Logging & Administration`: Ingests administrative configuration, logs system events to `D5`, aggregates live occupancy headcounts, and enforces instant gate lockdowns.
- **Relational Data Stores:**
  - `D1`: Visitors & Returning Profiles (`visitors`, `returning_visitor_profiles`)
  - `D2`: Digital Gate Passes (`passes`)
  - `D3`: Campus Directory & Closures (`campus_offices`, `campus_calendar_closures`)
  - `D4`: Philippine PSGC Locations (`psgc_locations`)
  - `D5`: Security Audit Ledger & Events (`audit_events`, `visit_events`)
  - `D6`: Evidence Storage & Uploads (`upload_intents`, Supabase Storage buckets)

---

## 5. Multi-Tier Architectural Framework

![Figure 5: Architectural Framework](file:///C:/Users/Administrator/Downloads/egatepass/diagram-output/egatepass-architectural-framework.png)

- **Deliverables:** [PNG](file:///C:/Users/Administrator/Downloads/egatepass/diagram-output/egatepass-architectural-framework.png) | [SVG](file:///C:/Users/Administrator/Downloads/egatepass/diagram-output/egatepass-architectural-framework.svg) | [Draw.io](file:///C:/Users/Administrator/Downloads/egatepass/diagram-output/egatepass-architectural-framework.drawio)
- **Standard / Model Notation:** 5-Tier Layered Software Architecture Model
- **Architectural Layers:**
  - **Tier 1 (Presentation Layer):** Responsive visitor web portal (`/get-pass`, `/track`), self-service kiosk PWA (`/kiosk`), dual-camera scanner terminal (`/guard`, `/scan/*`), office portal (`/office`), and admin dashboard (`/admin/*`).
  - **Tier 2 (Edge Security Layer):** Cloudflare Anycast CDN, DDoS scrubbing, Turnstile bot challenges, strict Content Security Policy (CSP), HSTS preload, and Vercel edge routing middleware with client-side transient memory sandboxing.
  - **Tier 3 (Application & Business Logic Layer):** Vercel Node.js 20 serverless API execution runtime, client Tesseract.js OCR worker, facial quality and transient vector comparator, QR matrix generator, and Resend email dispatcher.
  - **Tier 4 (Data Persistence Layer):** Supabase PostgreSQL 15 database, Row Level Security (RLS) policies, PgBouncer transaction connection pooler (Port 6543), append-only audit ledgers, and encrypted S3 object storage buckets.
  - **Tier 5 (External Services Layer):** Resend transactional email infrastructure, NHTSA vPIC automotive API, and PSA Philippine Standard Geographic Code (PSGC) reference dataset.

---

## 6. System Block Diagram

![Figure 6: System Block Diagram](file:///C:/Users/Administrator/Downloads/egatepass/diagram-output/egatepass-block-diagram.png)

- **Deliverables:** [PNG](file:///C:/Users/Administrator/Downloads/egatepass/diagram-output/egatepass-block-diagram.png) | [SVG](file:///C:/Users/Administrator/Downloads/egatepass/diagram-output/egatepass-block-diagram.svg) | [Draw.io](file:///C:/Users/Administrator/Downloads/egatepass/diagram-output/egatepass-block-diagram.drawio)
- **Standard / Model Notation:** IEEE Standard Subsystem Block Interconnection Model
- **Modular Subsystems:**
  - `Block 1: User Interaction & Terminals`: Mobile web clients, all-in-one touchscreen kiosks, Esc/POS thermal printers, optical scanning webcams, and guard Toughbook tablets.
  - `Block 2: Edge Security & Perimeter Defense`: Cloudflare Anycast DNS, Layer 3/4/7 DDoS mitigation, Turnstile bot defense, Vercel edge routing, and transient memory session cleanup.
  - `Block 3: Optical Capture & Biometrics`: Webcam MediaStream controllers, dynamic unmirroring viewports, Tesseract.js OCR engine, and facial liveness/vector comparison.
  - `Block 4: Pass Management & Cryptography`: Atomic pass issuance controllers, SHA-256 HMAC cryptographic token generation, finite state machine evaluators, and office review queues.
  - `Block 5: Physical Gate Control & Audit`: ZXing optical QR decoders, guard visual dossiers, turnstile barrier unlock triggers, append-only visit ledgers, and emergency lockdown relays.
  - `Block 6: Cloud Data & External Services`: Supabase PostgreSQL 15, Row Level Security, PgBouncer pooler, S3 storage buckets, Supabase Realtime WebSocket engine, Resend, and NHTSA APIs.

---

## 7. Physical & Logical Network Topology Diagram

![Figure 7: Network Topology Diagram](file:///C:/Users/Administrator/Downloads/egatepass/diagram-output/egatepass-network-diagram.png)

- **Deliverables:** [PNG](file:///C:/Users/Administrator/Downloads/egatepass/diagram-output/egatepass-network-diagram.png) | [SVG](file:///C:/Users/Administrator/Downloads/egatepass/diagram-output/egatepass-network-diagram.svg) | [Draw.io](file:///C:/Users/Administrator/Downloads/egatepass/diagram-output/egatepass-network-diagram.drawio)
- **Standard / Model Notation:** OSI Layered Network & Cloud Infrastructure Topology Model
- **Network Segmentation & Protocols:**
  - `Zone 1: Client Network Edge & Campus VLANs`: Public cellular/Wi-Fi for mobile visitors, Campus VLAN 20 (`192.168.20.0/24` - Kiosk Stations), Campus VLAN 30 (`192.168.30.0/24` - Turnstiles and Guard Toughbooks), and Campus VLAN 10 (`192.168.10.0/24` - Admin and Office Terminals). All outbound traffic uses HTTPS / Port 443.
  - `Zone 2: Cloudflare Perimeter Network`: Global Anycast BGP IP ranges (`104.21.x.x`), terminating TLS 1.3, mitigating DDoS attacks, running Turnstile challenges, and proxying requests to Vercel compute.
  - `Zone 3: Vercel Serverless Compute Cloud`: Global serverless microVM network executing API routes (`/api/scan/entry`, `/api/scan/exit`, `/api/turnstile/verify`) with sub-15ms edge routing and zero persistent local storage.
  - `Zone 4: Supabase Managed Cloud VPC`: AWS Singapore region (`ap-southeast-1`), PgBouncer connection pooler on Port 6543 (Transaction Mode), PostgreSQL database on Port 5432, S3 Storage and Realtime WebSockets on Port 443.
  - `Zone 5: External SaaS Endpoints`: Resend API (`api.resend.com:443`) for transactional notifications and NHTSA vPIC API (`vpic.nhtsa.dot.gov:443`) for vehicle decoding.

---

## 8. Conceptual Framework (IPO Model)

![Figure 8: Conceptual Framework](file:///C:/Users/Administrator/Downloads/egatepass/diagram-output/egatepass-conceptual-framework.png)

- **Deliverables:** [PNG](file:///C:/Users/Administrator/Downloads/egatepass/diagram-output/egatepass-conceptual-framework.png) | [SVG](file:///C:/Users/Administrator/Downloads/egatepass/diagram-output/egatepass-conceptual-framework.svg) | [Draw.io](file:///C:/Users/Administrator/Downloads/egatepass/diagram-output/egatepass-conceptual-framework.drawio)
- **Standard / Model Notation:** Academic Thesis Input - Process - Output (IPO) Model
- **Research Paradigm Structure:**
  - `INPUT (Independent Variables)`: Visitor demographic records, mandatory biological sex, residential PSGC codes, scanned government/student ID images, live webcam facial portraits, vehicle license details, destination office parameters, Turnstile bot tokens, and optical camera streams.
  - `PROCESS (Throughput & Transformations)`: Client-side form sanitization, Tesseract.js OCR text extraction, facial liveness analysis, Turnstile siteverify validation, atomic `api.issue_pass` RPC commit, SHA-256 HMAC cryptographic token generation, Resend email dispatch, optical QR token decoding (<500ms), pass state machine evaluation, guard visual cross-verification, and append-only audit logging.
  - `OUTPUT (Dependent Variables)`: Cryptographically signed digital gate passes with dynamic QR matrix, printed thermal kiosk badge slips, transactional confirmation emails, electronic turnstile barrier unlocks (green indicator), guard station visual verification dossiers, real-time in-campus headcount gauges, and immutable institutional audit trails.
  - `FEEDBACK & GOVERNANCE LOOP`: Returning visitor profile retrieval (consent-driven 30-day lifecycle), real-time overstay and duplicate pass alerts to guard view, and dynamic campus closure capacity adjustments.

---

## 9. Entity Relationship Diagram (ERD)

![Figure 9: Entity Relationship Diagram](file:///C:/Users/Administrator/Downloads/egatepass/diagram-output/egatepass-entity-relationship-diagram.png)

- **Deliverables:** [PNG](file:///C:/Users/Administrator/Downloads/egatepass/diagram-output/egatepass-entity-relationship-diagram.png) | [SVG](file:///C:/Users/Administrator/Downloads/egatepass/diagram-output/egatepass-entity-relationship-diagram.svg) | [Draw.io](file:///C:/Users/Administrator/Downloads/egatepass/diagram-output/egatepass-entity-relationship-diagram.drawio)
- **Standard / Model Notation:** Crow's Foot Relational Data Model Specification
- **Relational Cardinalities:**
  - `VISITORS (1)` ||--|| `PASSES (1)`: Strict 1-to-1 unique relationship; each visitor registration maps to exactly one issued gate pass (`passes.visitor_id UNIQUE`).
  - `VISITORS (1)` ||--o{ `VISITOR_EVIDENCE (M)`: 1-to-Many evidence items (id_front, id_back, live_capture).
  - `VISITORS (1)` ||--o{ `UPLOAD_INTENTS (M)`: 1-to-Many temporary upload tokens.
  - `VISITORS (1)` ||--o| `RETURNING_VISITOR_PROFILES (0..1)`: Optional 1-to-0..1 relationship connecting a visitor registration to a reusable returning profile.
  - `RETURNING_VISITOR_PROFILES (1)` ||--o{ `RETURNING_VISITOR_VEHICLES (M)`: 1-to-Many declared vehicles.
  - `RETURNING_VISITOR_PROFILES (1)` ||--o{ `RETURNING_FACE_TEMPLATES (M)`: 1-to-Many transient 128-dimensional biometric vectors.
  - `PASSES (1)` ||--o{ `VISIT_EVENTS (M)`: 1-to-Many optical scan events (entry, exit, denied) recorded by hardware scanners.
  - `OFFICES (1)` ||--o{ `OFFICE_VISITS (M)`: 1-to-Many visit appointment requests.
  - `OFFICES (1)` ||--o{ `OFFICE_PERSONNEL (M)`: 1-to-Many assigned faculty hosts.
  - `STAFF_PROFILES (1)` ||--o{ `AUDIT_EVENTS (M)`: 1-to-Many security actions logged by staff.
  - `STAFF_PROFILES (1)` ||--o{ `CAMPUS_CALENDAR_CLOSURES (M)`: 1-to-Many institutional holiday declarations.
  - `DEVICES (1)` ||--o{ `VISIT_EVENTS (M)`: 1-to-Many physical scans recorded by a hardware terminal.
  - `PSGC_LOCATIONS (1)` ||--o{ `PSGC_LOCATIONS (M)`: Self-referential hierarchical parent-child relationship.

---

## 10. Physical Database Schema Diagram

![Figure 10: Database Schema Diagram](file:///C:/Users/Administrator/Downloads/egatepass/diagram-output/egatepass-database-schema.png)

- **Deliverables:** [PNG](file:///C:/Users/Administrator/Downloads/egatepass/diagram-output/egatepass-database-schema.png) | [SVG](file:///C:/Users/Administrator/Downloads/egatepass/diagram-output/egatepass-database-schema.svg) | [Draw.io](file:///C:/Users/Administrator/Downloads/egatepass/diagram-output/egatepass-database-schema.drawio)
- **Standard / Model Notation:** PostgreSQL 15 Physical Schema Specification
- **Physical Relational Tables & Invariants:**
  - `public.visitors`: Governs identity, contact, required biological sex (`'male'`, `'female'`), hierarchical PSGC address attributes, purpose, and timestamp tracking. Protected by Row Level Security (RLS).
  - `public.passes`: Stores digital pass state (`pass_status` ENUM), 32-byte binary token digest (`token_digest bytea UNIQUE`), unique public reference UUID, temporal validity bounds (`valid_from`, `valid_until`), and ingress/egress timestamps (`time_in`, `time_out`).
  - `public.visit_events`: Append-only physical gate access log recording optical scan events, guard device pairings, gate names, and JSONB diagnostic telemetry.
  - `public.staff_profiles`: Manages institutional staff credentials, system roles (`'admin'`, `'guard'`, `'office_staff'`), active state, and TOTP MFA secrets.
  - `public.devices`: Hardware terminal registry binding kiosks and guard scanners by unique station identifiers.
  - `public.offices` & `public.office_visits`: Campus department directory and visit adjudication queue.
  - `public.audit_events`: Tamper-evident administrative audit ledger recording all system actions, actor identities, IP addresses, and resource mutations.
  - `public.psgc_locations`: Comprehensive reference table indexing Philippine regions, provinces, cities/municipalities, and barangays.
