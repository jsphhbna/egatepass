# Architecture

```text
Browser (React/Vite) → Firebase Auth / Firestore
Browser /api/* → Netlify Functions → Firebase Admin / Cloudinary
GitHub main → Netlify; Firestore rules/indexes deploy separately
```

`users/{uid}` defines active staff roles (`guard`, `admin`, `superadmin`); `devices/{uid}` defines active `entry`, `exit`, and `kiosk` devices. Route guards are UI only. Firestore Rules and functions re-check authorization.

Passes in `gatePasses` follow `valid` → `pending` → `approved` → `inside` → `exited`, with `rejected` and invalid/expired outcomes. Scanner functions transactionally enforce device type/gate and create `visitLogs`; Guard decisions use a protected function.

Browser reads are rule-limited. Public/Kiosk pass creation, scans, decisions, settings, account/device actions, image cleanup, and reconciliation use functions. `auditLogs`, `reconciliationTasks`, `rateLimits`, and `maintenanceState` are server-authored. Cloudinary signatures create server-only `imageUploads` using authenticated delivery; pass creation claims them and carries delivery metadata into visitor/pass records. Authorized `/api/image` access never treats an asset ID as permission.

Visitor pass requests are limited to today through 30 days ahead. For new records, image expiry is the later of the creation-time retention deadline and pass end plus 24 hours. Closed transitions restore the original creation-time retention deadline; legacy records are not rewritten, and purge-time pass checks prevent deletion while a pass remains operationally active.
