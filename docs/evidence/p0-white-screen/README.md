# P0 white-screen evidence

Revision under repair: `86a455ede2adc68ef6e09794e3ad118b70f63162`

- `before-desktop.png`: Edge capture from a detached worktree at the exact pre-fix revision. The root remained empty after Firebase Auth threw `auth/invalid-api-key` during module evaluation.
- `after-dev-configured-*.png`: Vite development server with the private Supabase-only `.env.local`; values are not recorded.
- `after-dev-missing-*.png`: Vite development server with both public Supabase variables deliberately empty.
- `after-dev-malformed-*.png`: Vite development server with a deliberately invalid URL and a synthetic non-secret key.
- `after-preview-configured-*.png`: built Vite preview using the Supabase-only local configuration.

Recurring command: `npm run test:e2e:startup`.

These images prove local rendering only. They do not prove provider connectivity, database migrations, Auth identities, RLS, Storage, Vercel routing, or production behavior.
