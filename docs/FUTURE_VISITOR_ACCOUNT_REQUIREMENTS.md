# Future Visitor Account Requirements (Deferred Feature)

> **STATUS: DEFERRED ARCHITECTURAL SPECIFICATION ONLY**  
> No visitor account registration, credential storage, profile management, or login features are authorized or implemented in this release. Anonymous/no-account visitor pass registration remains the sole and default public registration path.

---

## 1. Context & Scope Boundary

E-GatePass visitor registration intentionally creates ephemeral visitor passes and does not establish reusable visitor profiles or accounts. The current institutional public registration flow operates without requiring visitor accounts.

This document records the future requirements and institutional constraints if EARIST later decides to introduce optional reusable visitor accounts.

---

## 2. Institutional Requirements for Future Visitor Accounts

1. **Anonymous / No-Account Default**:
   - Anonymous, single-use pass registration must remain the default and primary registration flow.
   - Creating a reusable account must be strictly optional for frequent campus visitors (e.g., recurring vendors, contractors, or regular academic visitors).
   - Visitors must never be coerced or required to create an account merely to obtain an E-GatePass.

2. **Inactivity Period & Account Decommissioning**:
   - Before account creation, the user interface must explicitly disclose the configured inactivity duration after which an inactive visitor profile will be automatically disabled or deleted.
   - **Configured Inactivity Threshold**:
     ```text
     INACTIVITY PERIOD: TBD BY EARIST POLICY
     ```
   - No arbitrary inactivity duration shall be assumed or hardcoded until formal approval by EARIST administration.

3. **Data Minimization & Privacy Alignment**:
   - An optional reusable account must store only minimal identifying information needed to expedite pre-registration.
   - Evidence photos and physical ID scans must continue to adhere to campus retention limits rather than permanent storage.
   - Visitors must be able to view their data, request account deletion, and withdraw consent at any time.

4. **Security & Session Controls**:
   - Reusable visitor accounts must enforce rate-limiting, secure authentication, and session expiration.
   - Pass generation from a saved visitor profile must still require identity verification at campus security gates.
   - Pass tokens must remain single-use, cryptographically verified, and opaque without encoding visitor PII.

---

## 3. Prohibited Implementation Scope (Current Release)

The following capabilities are explicitly **OUT OF SCOPE** and must **NOT** be implemented in the current system:
- Visitor self-signup and password creation.
- Persistent visitor profile management or visitor dashboards.
- Visitor login, magic links, or session management for visitors.
- Visit history logging tied to persistent visitor credentials.
- Automated visitor account purging or disable background jobs.
- Password recovery or account recovery flows for public visitors.
