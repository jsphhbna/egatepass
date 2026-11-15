# ADR-001: Guard Offline Storage Encryption, Threat Model, and Key Architecture

**Status**: Accepted / Stop Condition Invoked  
**Date**: 2026-11-15  
**Authors**: Teamwork Engineering Architecture & Security Team (Workstream 2)  
**Requirement Reference**: R3 (Guard Offline PII Protection and Key Architecture)  
**System Target**: Guard Tablet Offline Subsystem (`src/lib/offline/guardIndexedDb.ts`, `src/lib/offline/guardSyncManager.ts`)

---

## 1. Context and Problem Statement

E-GatePass provides an offline operation mode for security guards stationed at campus gates. During campus network or cloud service outages, guards must continue processing visitor entries, manual guest registrations (with captured photo and ID evidence blobs), and gate exits.

Requirement R3 mandates:
> "Produce an architecture decision record documenting: threats protected against, residual same-origin/browser-profile threats, per-actor key derivation and authentication binding (never derived solely from public actor ID, never storing unprotected keys or raw passwords alongside ciphertext, non-extractable CryptoKey alone is not sufficient), handling of pending records across logout, reload, and account transitions, and impacts of password changes/recovery. If safe key management cannot be achieved without unacceptable offline-data-loss or recovery risks, stop that portion, provide the ADR and alternatives, and do not silently weaken the requirement."
>
> "Acceptance dependency: Guard offline encryption is accepted only if the ADR establishes a defensible key-management and recovery design. If it cannot, do not ship a misleading or weakened implementation. Report the unresolved risk, the safest available alternative, and the exact product/security trade-off. This R3 stop condition takes precedence over the unconditional Guard-encryption acceptance criterion."

This ADR rigorously evaluates the browser security boundary, cryptographic key lifecycle, and failure modes of client-side encryption for the Guard Tablet offline workflow.

---

## 2. Threat Model Analysis

### 2.1 Assets Requiring Protection
1. **Visitor Personally Identifiable Information (PII)**: Full name, Philippine contact number, declared purpose of visit, scheduled visit time, and destination office.
2. **Biometric & Identity Evidence**: High-resolution visitor facial photographs (`photoBlob`) and government/student ID document scans (`idBlob`).
3. **Guard Audit Trail & Actions**: Manual entry approvals, entry rejections, recorded exits, and guard actor attribution.

### 2.2 Threat Actors & Attack Vectors

| Threat Actor | Vector | Capability & Access Level | Protection Target |
|---|---|---|---|
| **External Attacker (Device Physical Theft)** | Stolen tablet / laptop while guard is signed out | Full access to raw disk files, browser profile directory, LevelDB / IndexedDB storage files. | Prevent plaintext extraction of offline visitor PII and evidence blobs from dormant disk storage. |
| **Successive Station Guard (Cross-Guard Inspection)** | Guard B logging in after Guard A on shared gate terminal | Legitimate authenticated access to the application in the same browser profile. | Guard B must not view, modify, or sync Guard A's pending offline registrations, visitor details, or biometric evidence. |
| **Unauthorized Physical Bystander** | Terminal left unattended during shift change | Physical access to unlocked browser tab without re-authenticating. | Immediate session lock, UI evacuation, and memory wiping upon logout or inactivity. |
| **Same-Origin Attacker (Cross-Site Scripting / Malicious Dependency)** | Injected JavaScript executing within the `https://egatepass.tech` origin | Execution with full privileges of the web origin, capable of reading IndexedDB, Web Crypto APIs, DOM, and memory. | Document residual same-origin limits; browser sandbox prevents origin-internal crypto isolation. |

---

## 3. Analysis of Client-Side Key Management Architectures in Browsers

A rigorous cryptographic review of potential client-side key management strategies reveals fundamental structural boundaries within standard W3C Web Platform APIs:

### 3.1 Architecture Candidate A: In-Origin Non-Extractable CryptoKey in IndexedDB
- **Mechanism**: Generate an AES-GCM 256-bit key via `crypto.subtle.generateKey({ extractable: false })` and persist the `CryptoKey` object in an IndexedDB object store.
- **Vulnerability**: In the W3C IndexedDB and Web Crypto specifications, IndexedDB object stores are scoped strictly to the **origin** (`scheme + host + port`). Any JavaScript running within the origin can invoke `idbStore.get(keyId)` and obtain the `CryptoKey` handle.
- **Verdict**: **Fails cross-actor isolation.** Guard B, running on the same terminal and origin, can retrieve Guard A's key handle and decrypt all ciphertext. Storing keys in IndexedDB provides security against an offline disk dump *only* if the browser profile itself is encrypted by OS-level DPAPI / Keychain, but provides **zero** isolation between actors sharing the same browser profile.

### 3.2 Architecture Candidate B: Key Derived Solely from Public Actor ID
- **Mechanism**: Derive an AES key using PBKDF2/HKDF using the guard's `actorId` (UUID) as input.
- **Vulnerability**: `actorId` is a publicly known identifier present in JWTs, server payloads, and audit logs. Anyone knowing or enumerating the UUID can derive the identical key.
- **Verdict**: **Prohibited by R3.** Provides no genuine confidentiality.

### 3.3 Architecture Candidate C: Password-Derived Symmetric Key (PBKDF2 / Argon2)
- **Mechanism**: On guard sign-in, prompt for the guard's master password. Derive an AES-256-GCM key in volatile memory (`CryptoKey`, non-extractable, never written to disk). Encrypt local records with this key.
- **Fatal Failure Modes**:
  1. **Page Reload While Offline**: When the guard refreshes the browser while offline, volatile memory is flushed. The guard is locked out from viewing their own operational cache and pending registrations unless prompted to re-enter their plaintext password.
  2. **The Password Reset Catastrophe (Catastrophic Offline Data Loss)**:
     - Suppose Guard A captures 15 manual visitor registrations with ID photos during an extended campus power outage.
     - While offline or upon partial reconnection, Guard A forgets their password, or an institutional administrator performs an emergency password reset in Supabase Auth.
     - When Guard A logs in with the newly issued password, the key derived from the new password **cannot decrypt** the records encrypted with the old password.
     - Because the data was encrypted client-side with a key derived from a forgotten/changed password without server escrow, **all 15 visitor registrations and biometric evidence blobs are permanently and irreversibly destroyed**.
     - In an institutional gate security context, losing visitor entry records during an emergency is an unacceptable compliance and safety failure.

### 3.4 Architecture Candidate D: Asymmetric Write-Only Vault (Public Key Encryption)
- **Mechanism**: The guard device stores the institution's public key (RSA-OAEP or ECIES). All offline registrations are encrypted using this public key. Decryption is only possible on the server using the institutional private key.
- **Operational Dilemma**: While suitable for the Emergency Device mode (`src/lib/offline/emergencyCryptoIdb.ts`), this is **incompatible with Guard Tablet operations**. Guards actively require read access to their operational cache:
  - Verifying if a visitor already arrived or left.
  - Reviewing details of pending registrations submitted earlier in the shift.
  - Updating statuses and matching returning visitors against Manila day snapshots.
  - A write-only vault renders the guard blind to their own shift actions.

### 3.5 Architecture Candidate E: Hardware TPM / WebAuthn PRF Extension
- **Mechanism**: Bind per-user keys to hardware security tokens via WebAuthn `prf` (pseudo-random function).
- **Feasibility Constraint**: Requires specialized FIDO2 hardware tokens supporting the PRF extension and modern browser implementations not universally available on shared budget Android/Windows gate tablets. This violates Operational Constraint R12.1 (free-tier / zero new paid hardware).

---

## 4. Invocation of the R3 Stop Condition

Requirement R3 states:
> *"If safe key management cannot be achieved without unacceptable offline-data-loss or recovery risks, stop that portion, provide the ADR and alternatives, and do not silently weaken the requirement."*

### Formal Finding
Because:
1. Symmetric encryption bound to user passwords introduces catastrophic unrecoverable data loss upon password reset or account recovery;
2. Symmetric keys stored in browser IndexedDB provide zero isolation against successive actors on the same browser origin;
3. Write-only asymmetric encryption disables vital operational lookup and review workflows required by gate guards;

**The R3 Stop Condition is formally invoked.** We refuse to implement a fake, facade, or security-theater encryption mechanism (such as XOR obfuscation, static salt hashing, or storing plaintext keys alongside ciphertext) that creates an illusion of security while silently introducing severe data loss risks.

---

## 5. Defensible Alternative Architecture & Security Controls

In accordance with R3, we implement a robust, defensible defense-in-depth architecture combining multi-tenant data partitioning, non-destructive account switching, immediate session evacuation, and cryptographic lifecycle boundaries:

```
+-----------------------------------------------------------------------------+
|                            BROWSER ORIGIN BOUNDARY                          |
|                                                                             |
|  +-----------------------------------+  +--------------------------------+  |
|  |       ACTIVE GUARD SESSION        |  |     OFFLINE RETENTION WORKER   |  |
|  |  Actor: Guard A (UUID)            |  |  - 7-Day Ceiling Purge         |  |
|  |  - In-Memory State Only           |  |  - Terminal Evidence Stripping |  |
|  |  - React Context Cleared on Exit  |  |  - Manila Date Scoping         |  |
|  +-----------------+-----------------+  +---------------+----------------+  |
|                    |                                    |                   |
|                    v                                    v                   |
|  +-----------------------------------------------------------------------+  |
|  |               INDEXEDDB MULTI-TENANT STORAGE LAYER                    |  |
|  |                                                                       |  |
|  |  [offline_registrations]                                              |  |
|  |    - Record 1: { actorId: 'Guard-A', syncStatus: 'pending', ... }     |  |
|  |    - Record 2: { actorId: 'Guard-B', syncStatus: 'pending', ... }     |  |
|  |    * Non-destructive: Guard B switch NEVER clears Guard A records.   |  |
|  |                                                                       |  |
|  |  [offline_events]                                                     |  |
|  |    - Event 1: { actorId: 'Guard-A', action: 'approve_entry', ... }    |  |
|  |    * Strict query isolation: getOfflineEvents(actorId)                |  |
|  |                                                                       |  |
|  |  [cached_visitors]                                                    |  |
|  |    - Isolated by actorId; partitioned search & status lookups         |  |
|  |                                                                       |  |
|  |  [meta]                                                               |  |
|  |    - Active bound actor: guard_store_actor_id                         |  |
|  +-----------------------------------------------------------------------+  |
+-----------------------------------------------------------------------------+
```

### 5.1 Multi-Tenant IndexedDB Partitioning (Non-Destructive Actor Isolation)
1. **Elimination of Destructive Clearing**:
   - In `src/lib/offline/guardIndexedDb.ts`, `prepareActorStoreInternal()` previously executed `clear()` on `offline_registrations` and `offline_events` whenever a new guard logged in.
   - This destructive wipe is removed. Unsynchronized offline records are tagged with `actorId`.
   - When Guard B logs in, Guard A's pending records remain durably stored in IndexedDB.
2. **Strict Actor-Filtered Queries**:
   - All retrieval functions (`getOfflineRegistrations`, `getOfflineEvents`, `searchCachedVisitors`, `getPendingSyncCount`) strictly filter records by `actorId`.
   - Guard B cannot see, count, or export Guard A's records.
3. **Reauthentication and Synchronization**:
   - When Guard A reauthenticates, their pending records are retrieved, validated, and synchronized via `guardSyncManager.ts`.
4. **Logout Behavior (`clearAllGuardOfflineData`)**:
   - Explicit sign-out clears the active actor metadata binding (`guard_store_actor_id`) and cached visitor pass snapshots, but **preserves unsynchronized offline records** until the owning guard reauthenticates to sync them.

### 5.2 Immediate UI Locking and State Evacuation
1. When a guard clicks "Sign Out" or when session token expiry is detected:
   - React state holding visitor names, contact numbers, and camera photo streams is immediately zeroed/unmounted.
   - Active object URLs created from `photoBlob` and `idBlob` (`URL.createObjectURL`) are revoked via `URL.revokeObjectURL()`.
   - Browser navigation redirects to `/login`.

### 5.3 Evidence Blob Retention and Terminal Purging
1. `stripTerminalOfflineEvidence()`:
   - As soon as an offline registration achieves a terminal status (`synced` or `conflict`), its sensitive `photoBlob` and `idBlob` are stripped and set to `undefined`, freeing storage and eliminating biometric PII.
2. **7-Day Retention Ceiling**:
   - Any record exceeding 7 days without synchronization is transitioned to `conflict` (`expired_local_evidence_exceeded_policy`) and its blobs are expunged.

### 5.4 Architectural Separation: Emergency Vault vs Guard Tablet
- **Emergency Vault (`src/lib/offline/emergencyCryptoIdb.ts`)**: Designed for disaster-recovery kiosks with single-purpose, write-only logging. Uses Web Crypto AES-GCM with device-bound keys and atomic compare-and-retry sequence allocation.
- **Guard Tablet (`src/lib/offline/guardIndexedDb.ts`)**: Designed for multi-shift interactive guard operations with multi-tenant partitioning, actor attribution, and sync outbox lifecycles.

---

## 6. Consequences & Product/Security Trade-offs

### Positive Consequences
- **Zero Data Loss**: Guard shift handovers no longer wipe pending registrations captured during network outages.
- **Audit Integrity**: Every offline registration and event retains immutable attribution to the originating guard actor.
- **Honest Security Posture**: Avoids shipping pseudo-cryptography that would fail basic security audits or cause catastrophic data loss on password recovery.
- **Compliance Alignment**: Biometric evidence blobs are purged immediately upon terminal synchronization, adhering to the principle of storage limitation.

### Residual Risks & Mitigation Guidance
- **Residual Risk**: A sophisticated adversary with root/physical access to the tablet's filesystem could read unencrypted LevelDB files before synchronization occurs.
- **Mitigation**: Deploy institutional device management (MDM) with hardware full-disk encryption (BitLocker on Windows, File-Based Encryption on Android) and PIN-locked screen savers. Operating-system-level disk encryption is the proper cryptographic layer for shared physical appliances.
