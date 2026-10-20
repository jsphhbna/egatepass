# Clean Data Handoff

> **WARNING: Do not blindly delete the Firestore database or Firebase Authentication users.** Firestore data, Firebase Auth accounts, Cloudinary assets, and Netlify configuration are separate systems. Deleting one does not remove the others.

## Inventory

| Collection/document | Purpose | Clear for handoff? | Preserve/recreate? | Notes |
| --- | --- | --- | --- | --- |
| `users` | staff profiles/roles | only approved test staff | recreate school Admin/Super Admin | Auth UID must match document |
| `devices` | device account settings | only approved test devices | preserve or recreate scanners | device Auth user is separate |
| `visitors` | visitor records/images references | usually approved test history | no | Cloudinary cleanup is separate |
| `gatePasses` | pass lifecycle | usually approved test history | no | preserve only if policy requires history |
| `visitLogs` | operational history | only approved history | no | follow school retention policy |
| `auditLogs` | admin/system history | only if policy authorizes | bootstrap audit required | do not remove required evidence casually |
| `reconciliationTasks` | unresolved partial operations | only after investigation | no | never hide unresolved work |
| `settings/app` | operational/security settings | no | preserve or recreate | includes working hours/retention |
| `imageUploads` | server upload sessions | expired/test sessions after review | no | server-only metadata |

There is no separate emergency collection: Emergency reads current inside `gatePasses` and its paper “Accounted” checklist is not persisted.

## Controlled procedure

1. Export/backup the data required by school policy and record the deployed commit.
2. Identify developer/test Auth, staff, and device accounts; decide which school device configuration remains.
3. Approve exact collection/date/account scope. Remove visitor/pass/history records only through a controlled manual or purpose-built process; do not run blanket deletion commands.
4. Remove matching Firebase Authentication accounts only when their Firestore profiles/devices are also intentionally retired.
5. Use authorized server-side Cloudinary cleanup for referenced/orphaned images; Firestore deletion alone leaves assets behind.
6. Preserve or recreate `settings/app`, school devices, and an active Super Admin. Follow [Super Admin Bootstrap](SUPER_ADMIN_BOOTSTRAP.md) for a fresh school owner.
7. Create school Admin/device accounts, run the controlled lifecycle smoke test, and confirm developer/test data is gone.

For a full fresh start, recreate settings, a first Super Admin, required Admins, and device Auth accounts/documents. For partial cleanup, keep `settings/app` and approved `devices`, while removing only approved visitor, pass, and history data. CSV exports are operational exports, not a complete disaster-recovery backup; take an approved Firestore/Auth/Cloudinary inventory before cleanup.

## Environment and secrets handoff

The incoming school technician needs approved GitHub, Netlify, Firebase, and Cloudinary access. Review the required variable **names** in `.env.example`; do not put values in GitHub, documentation, or tickets. Rotate credentials where policy requires, including generating a new `CRON_SECRET` and updating it only in Netlify.

Before the handoff is complete, verify the non-secret runtime configuration remains `AWS_LAMBDA_JS_RUNTIME=nodejs24.x` and `NODE_OPTIONS=--experimental-require-module`, then redeploy if changed environment values require it. Verify scheduled retention cleanup, Firebase Admin Functions, Cloudinary Functions, and their logs. The detailed generation, Netlify setup, rotation, and classification procedure is in [Environment and Scheduled Cleanup Handoff](ENVIRONMENT_AND_CRON.md).
