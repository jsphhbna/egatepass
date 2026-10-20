# Authorization Matrix

Status: SQL/RLS implementation reviewed; runtime enforcement is **BLOCKED / NOT VERIFIED** until tested on isolated Supabase with real sessions.

| Asset/action | Guest visitor | Kiosk | Entry | Exit | Guard | Admin | Super Admin |
|---|---:|---:|---:|---:|---:|---:|---:|
| Read own visitor/pass | Own only | No direct operational history | No | No | Pending case only | Yes | Yes |
| Create evidence upload intent | Portal source | Kiosk source | No | No | No | No | No |
| List/read evidence objects | Own intent/reference only | Own current intent only | No | No | Pending case only | Yes | Yes |
| Direct table mutation | No | No | No | No | No | No | No |
| Scan entry/exit | No | No | Entry RPC only | Exit RPC only | No | No | No |
| Decide pending pass | No | No | No | No | Yes | Yes | Yes |
| Read visit/audit history | No | No | No | No | Scoped queue only | Yes | Yes |
| Read reconciliation | No | No | No | No | No | No | Yes |
| Manage privileged roles/settings/holds | No | No | No | No | No | Restricted | Yes |

S2 implements identity resolution, select policies, private evidence buckets, and upload-intent RPC authorization. M1 adds caller-bound privacy acknowledgement and a service-role-only Guard password finalizer. Pass lifecycle, governance, provisioning, and retention RPCs remain reserved for later stages and therefore have no client write path today.

## Fail-closed rules

- Missing, suspended, unverified, revoked, or wrong-type identity yields no privileged actor.
- RLS plus explicit grants are both required. There is no `passes USING (true)` or client insert/update/delete grant.
- Definer helpers use `search_path = ''`, schema-qualified relations, explicit caller/resource checks, and exact execute grants.
- The browser cannot write visit events, audit events, reconciliation tasks, holds, limiter state, or maintenance state.
- Storage insert requires a live, owner/path/bucket-bound intent. No client Storage update/delete policy exists.
- A service-role server function bypasses RLS and must independently authorize the caller before using it.
- QR-email RPCs are service-role-only. The Vercel handler authenticates the bearer, resolves only the issuance public-reference UUID, verifies current owner/status/expiry and bearer digest, and passes the authenticated actor ID. Each definer repeats owner/status/expiry/tuple checks under locks; anon/authenticated/PUBLIC execution is revoked.
- The Guard password endpoint authenticates the bearer against Supabase Auth, checks the active Guard profile, verifies the current password, and uses a separate privileged client so the verification session cannot replace the admin client's service-role authorization.

## Mandatory runtime denial tests

Run `supabase test db`, then use actual Auth bearer sessions over the Data/Storage APIs. Required negatives include cross-owner PII, forged staff metadata, Admin-to-privileged role change, last-Super-Admin removal, revoked/wrong-type device, arbitrary pass lookup, forged event/audit writes, wrong source/gate, expired intent, Storage list/update/delete, and direct invocation of each definer function.
