# Image security and cleanup

Cloudinary's API secret and all destructive operations remain in Netlify Functions. The browser receives only a short-lived upload signature, the public Cloudinary API key, the server-selected `authenticated` delivery type, and the exact server-generated public ID it must use. It never receives destructive credentials.

## Identifier and reference policy

- Current uploads use `e-gatepass/photos/<uploadId>` or `e-gatepass/ids/<uploadId>`, where the random upload ID is 16-128 URL-safe characters.
- Older syntactically safe identifiers are treated as legacy candidates. They are usable only when an existing visitor or gate-pass document references the exact value.
- Empty, oversized, traversal-like, or otherwise malformed identifiers are rejected before Cloudinary is contacted.
- A well-formed but unreferenced identifier is not an authorization grant and returns not found.
- New uploads use Cloudinary's `authenticated` delivery type. Knowing the public ID is insufficient to retrieve the original or a derived asset without a Cloudinary signature.
- `/api/image` verifies the E-GatePass staff role/reference and fetches a signed authenticated Cloudinary URL server-side. The Cloudinary URL is not returned to the browser.
- Records without delivery metadata are treated as legacy `upload` assets for compatibility until the controlled migration below converts them.

The `imageUploads` collection is server-only. Each signature creates a 24-hour pending session bound to the authenticated visitor or active Kiosk identity and the exact public ID. Pass creation validates and atomically claims every upload session. Existing pass idempotency remains valid after a session has been claimed.

`imageUploads.expiresAt` remains only the unclaimed-upload deadline. New visitors receive a creation-time `baseImagesExpireAt` and an effective `imagesExpireAt`. The effective deadline is the later of the configured image-retention deadline or the pass validity end plus a 24-hour safety margin. Rejected, expired-on-scan, and exited new passes return to the stored creation-time base deadline. Policy changes do not rewrite existing deadlines. Legacy records are not silently rewritten; purge independently protects pending, inside, and still-valid issued passes. Expired, missing, and temporarily unavailable images have distinct UI states while visitor/pass metadata remains readable.

## Access matrix

| Actor | Pending operational image | Historical referenced image | Arbitrary/unreferenced image | Destructive access |
| --- | --- | --- | --- | --- |
| Guard | Allowed when an exact gate-pass reference is pending | Denied | Denied | None |
| Admin | Allowed | Allowed when exactly referenced by an existing record | Denied | None |
| Super Admin | Allowed | Allowed when exactly referenced by an existing record | Denied | Manual bounded purge only |
| Visitor / Kiosk | No proxy access | No proxy access | No proxy access | Own unclaimed upload cleanup only |

`AuthenticatedImage` sends its Firebase bearer token in an authorization header, reads the response into a temporary browser object URL, verifies that the response is an image, revokes old object URLs, and has no direct-Cloudinary fallback.

## Cleanup paths

Failed pass creation invokes `/api/cleanup-upload`. That endpoint accepts at most the two expected images and deletes only exact, current-format sessions owned by the caller that remain unclaimed. Claimed images cannot be removed through this path. A failed deletion is marked `cleanup_failed` and produces a server-only reconciliation task.

Retention purge is separate. `/api/purge-images` accepts only an authenticated Super Admin or the timing-safe `CRON_SECRET` internal caller. It scans bounded deterministic legacy/current pages, skips active/future passes and pending reconciliation, destroys each asset using its recorded delivery type, and marks a visitor purged only after all referenced deletions succeed. Every visitor deletion failure creates a deterministic reconciliation item; cleanup cursors advance so one blocked record cannot starve later records and cycle back for later review.

## Existing public-asset migration

Do not mass-edit Cloudinary or Firestore directly. The `migrate-image-delivery` Function provides a bounded, Super Admin-only transition:

1. Deploy the compatibility code first so the proxy and purge understand both `upload` and `authenticated` assets.
2. Call the endpoint with `{ "dryRun": true }`. It scans no more than five visitors and returns a `nextCursor`; it does not call Cloudinary or write an audit event.
3. For an approved live batch, send `{ "dryRun": false, "confirmation": "MIGRATE LEGACY VISITOR IMAGES" }`, adding the returned cursor to the next request.
4. The Function uses Cloudinary `rename` with `type: upload`, `to_type: authenticated`, and CDN invalidation, then updates the visitor and all bounded pass references.
5. If Cloudinary and Firestore cannot both be finalized, a server-only reconciliation item identifies the visitor, image field, and required checks. The proxy tries the authenticated namespace for a legacy-metadata miss so a privacy-first partial migration remains viewable by authorized staff.
6. Review the administrative audit and unresolved reconciliation list between batches. Verify representative migrated assets through `/api/image` and verify their unsigned `/image/authenticated/...` Cloudinary URL is denied.

Migration is required after deployment for existing public assets. No production migration is performed automatically by a deploy, retention run, or Settings change.

There is intentionally no generic image DELETE endpoint and no unauthenticated or unrestricted cleanup endpoint. The daily Netlify retention wrapper delegates to the existing `CRON_SECRET`-protected bounded purge; an authorized Super Admin may also run it manually. Required indexes must be deployed before enabling scheduled cleanup.
