# Working Hours and Complete Exports

## Working-hours source of truth

`settings/app.workingHours` is the sole configurable campus access schedule:

```text
start: HH:mm
end: HH:mm
timezone: Asia/Manila
```

Only a Super Admin can submit this field through `/api/update-settings`. Admins may read it but the backend rejects attempts to modify it. The server validates 24-hour `HH:mm` values and requires `start < end`.

`create-pass` reads the setting in the same Firestore transaction used to create the visitor and pass, then derives `validFrom` and `validUntil` on the server. Portal and Kiosk clients never submit validity timestamps. Existing installations whose settings document is missing or contains invalid working hours fall back to `08:00`-`17:00` in `Asia/Manila` so legacy pass creation remains available.

## Complete exports

Visitor records, visitor activity, and administrative activity keep their normal views bounded and offer cursor-based loading. Complete filtered CSV exports fetch Firestore in pages of 250 rather than issuing an unlimited query. Exports stop at 10,000 source records; the UI warns the operator to narrow filters if that safety limit is reached.

Visitor-record CSV honors the selected date, status, and visitor-name filters. Activity CSV honors the selected event type and date range; administrative CSV honors date range, actor-role, and action filters. These exports query Firestore using the signed-in operator's existing Rules authorization: Guards and Admins may read visitor activity, only Admins may read administrative activity, and reconciliation is intentionally excluded from CSV export and remains available only through the protected Super Admin reconciliation view. Normal audit exports exclude reconciliation records, Cloudinary image identifiers, QR/pass tokens, credentials, request bodies, and audit metadata. Printing Visitor Records is labeled as the currently loaded view and is not represented as a complete-history export.
