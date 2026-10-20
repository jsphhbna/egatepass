# First Super Admin Bootstrap

E-GatePass intentionally has no public or application-accessible bootstrap endpoint. Establish the first Super Admin through authorized Firebase administration using one explicitly selected account. This is used for a fresh database, when no active Super Admin exists, or after an approved clean handoff.

## Preconditions

- You must be an authorized Firebase project owner or administrator.
- Create or select one legitimate Firebase Authentication account and ensure it has a matching `users/{uid}` Firestore document.
- Confirm the account is active and email-verified where required. When promoting an existing account, confirm its current role is exactly `admin`.
- Do not promote every existing Admin.

## One-time procedure

1. Open the Firebase Console for the correct E-GatePass project.
2. Open **Authentication > Users**, locate the chosen Admin by exact email address, and copy the account UID.
3. Open **Firestore Database > Data > users > {copied UID}**.
4. Verify all of the following before editing:
   - The document ID exactly matches the Authentication UID.
   - `email` matches the selected Authentication account.
   - `active` is `true`.
   - `role` is exactly `admin`.
5. Edit only the `role` field, changing its string value from `admin` to `superadmin`, then save.
6. Create one document with an automatically generated ID in `auditLogs` containing:
   - `actorUid`: `manual-bootstrap`
   - `actorRole`: `system`
   - `targetUid`: the selected account UID
   - `target`: `users/{selected account UID}`
   - `previousRole`: `admin`
   - `newRole`: `superadmin`
   - `previousActive`: `true`
   - `newActive`: `true`
   - `action`: `initial_superadmin_bootstrapped`
   - `details`: a short change-ticket or authorization reference; do not include passwords or secrets
   - `timestamp`: the current Firestore timestamp
7. Have the selected user sign out and sign in again, then verify that the Admin portal identifies the account as **Super Admin**.
8. Verify that at least one active Super Admin remains before later demoting or deactivating any Super Admin.

After this one-time bootstrap, use the protected user-management controls for role and activation changes. Direct browser writes are denied by Firestore rules, and the backend prevents removal of the final active Super Admin.

## Recovery

If every Super Admin is accidentally lost through an out-of-band console change, repeat this manual procedure for one explicitly authorized active Admin and record a new bootstrap/recovery audit event. Never add a temporary public endpoint or client-side bypass.

Do not promote arbitrary users. After recovery, verify sign-in, ordinary Admin capabilities, Super Admin controls, and that at least one active Super Admin remains.
