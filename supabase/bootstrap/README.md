# Initial Super Admin Bootstrap

This is an owner-authorized, one-time database-operator procedure. It is not an API and must never use a service key in the browser.

Prerequisites:

1. Apply and integration-test the exact migration chain in an isolated environment.
2. Create and verify the intended human in Supabase Auth through an approved admin workflow.
3. Confirm the target project identity and record a backup/rollback point.
4. Connect as the authorized `postgres`/`supabase_admin` database operator.

Run in one transaction, replacing values only in the private SQL session:

```sql
begin;

select id, email_confirmed_at is not null as email_verified
from auth.users
where id = '<AUTH-USER-UUID>'::uuid;

select private.bootstrap_super_admin(
  '<AUTH-USER-UUID>'::uuid,
  '<DISPLAY NAME>'
);

select user_id, role, active, must_change_password
from public.staff_profiles
where user_id = '<AUTH-USER-UUID>'::uuid;

commit;
```

The function rejects a missing Auth user, a non-database-operator caller, or any attempt after a staff profile already exists. It creates an audit event and forces a first password change. Test the failure cases in the isolated database before any authorized production use.

Rollback before use: `rollback;`. After commit, do not delete the only active Super Admin; the database trigger rejects that transition. Recovery needs a separately authorized database-operator procedure and audit record.
