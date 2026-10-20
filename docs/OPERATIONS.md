# Operations Guide

## Accounts and devices

Super Admins use protected user/device controls to create and manage staff and device accounts. Admins handle daily operations but cannot change Super Admin-only settings. Do not demote or deactivate the last active Super Admin; backend protection rejects it. Prefer disabling an account to deleting it when historical attribution must remain.

Kiosk, Entry, and Exit are authenticated device accounts. Verify each is active; Entry/Exit must have the correct type and gate assignment. Do not share device credentials or use a staff account as a scanner.

## Working hours

`settings/app.workingHours` uses Asia/Manila time. The documented fallback is 08:00–17:00 if settings are missing/invalid. Only Super Admin can change working hours; see [Working Hours and Exports](WORKING_HOURS_AND_EXPORTS.md).

## Retention

Super Admins configure visitor/history (default 30 days, range 7–365), images (7, 1–90), audit logs (365, 90–1095), and resolved reconciliation records (90, 30–365). Automatic cleanup runs daily through Netlify using `CRON_SECRET` and bounded batches. Pending/inside passes and issued passes that have not expired, unresolved reconciliation tasks, and security-sensitive audit actions are protected. Export required archives before retention expiry. See [Environment and Scheduled Cleanup Handoff](ENVIRONMENT_AND_CRON.md) for the machine-to-machine cleanup authorization and rotation procedure.

Unclaimed-upload `imageUploads.expiresAt`, visitor-image lifetime, and manual image purge are separate. A changed image policy applies to new visitor records and does not rewrite existing deadlines. A manual purge requires Super Admin confirmation and handles one bounded batch (up to 25 visitors) per confirmation.

Cleanup order is deliberate: remove referenced Cloudinary assets using their recorded delivery type, then mark `imagesPurgedAt`; only a closed pass with a purged image state, no other pass for its visitor, and no pending reconciliation is eligible for one parent-last bounded deletion of its visit logs, upload metadata, pass, and visitor. Ordinary audit events may then expire; security-sensitive audit events and unresolved reconciliation records are never automatically deleted. Visitor, audit, reconciliation, and image categories keep server-only cursors and deterministic sort order, so blocked records do not starve later eligible records. Cursors cycle back after reaching the end.

The historical-pass query requires both `gatePasses(status ASC, issuedAt ASC)` and the existing descending operational index. Deploy the ascending index and wait for `READY` before relying on scheduled cleanup. Do not use destructive production cleanup as an index test.

## Logs, images, and exports

`visitLogs` are operational events visible to Guards and administrators. `auditLogs` are administrative/system events visible to administrators. `reconciliationTasks`, `maintenanceState`, and `rateLimits` are server-only; Super Admin sees a bounded sanitized reconciliation list through the protected endpoint. New Cloudinary images use authenticated delivery and are application-authorized by references. Legacy public assets remain a known transition risk until the bounded migration in [Image Security](IMAGE_SECURITY.md) is completed. Never expose Cloudinary secrets or manually delete assets with browser credentials.

## Anonymous workflow abuse limits

The signing and pass-creation Functions enforce fixed-window Firestore counters after authentication and strict body validation. Raw client IP addresses are not stored; Netlify's connection address is HMAC-hashed with `CRON_SECRET` and project context. Requests without the trusted Netlify header or without the server secret still receive UID limits.

| Operation/actor | Burst window | Sustained window |
| --- | --- | --- |
| Visitor image signing | 8 per UID / 120 per IP per 60 seconds | 40 per UID / 1,000 per IP per hour |
| Visitor pass creation | 3 per UID / 60 per IP per 10 minutes | 10 per UID / 500 per IP per day |
| Kiosk image signing | 200 per UID / 240 per IP per 60 seconds | 2,000 per UID / 2,400 per IP per hour |
| Kiosk pass creation | 100 per UID / 120 per IP per 10 minutes | 1,000 per UID / 1,200 per IP per day |

An exceeded limit returns HTTP 429 and `Retry-After`. Separate UID limits prevent one visitor from consuming another visitor's UID quota, while higher IP ceilings accommodate a school network using one egress address. `expiresAt` is ordinary Firestore timestamp data; the daily scheduled maintenance job deletes only up to 50 expired counter records per run, so this free-tier deployment does not depend on Firestore TTL or an unbounded scan. Firestore Rules deny all client access to the counter collection.

Filtered CSV exports page through results and stop at 10,000 source records. Print is only the currently loaded view.

## Routine health checks

Check Netlify deployment/function logs, Firebase permission errors, Firestore index readiness, Cloudinary failures, and inactive or incorrectly configured devices.
