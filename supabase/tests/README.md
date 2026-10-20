# Supabase Integration Tests

These are real database tests, not text fixtures. Run only against a disposable local Supabase stack or an explicitly authorized non-production project whose identity has been confirmed.

```powershell
npx supabase@latest db reset
npx supabase@latest test db
```

The two SQL files currently define 27 assertions. Required promotion evidence also includes a second clean-install run, migration-chain metadata/policy comparison, real Auth bearer sessions through the Data API, and actual private Storage uploads/download/list/delete denials. `tests/supabase-migration-static.test.ts` is only a source-safety regression and cannot replace these commands.

Current status: **BLOCKED** because this workstation has no Docker-backed local Supabase and no authorized hosted test target.
