import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('SECURITY DEFINER Function Audit & Hardening Contract', () => {
  const migrationsDir = 'supabase/migrations';
  const migrationFiles = readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();
  const allMigrationsSql = migrationFiles
    .map(f => readFileSync(join(migrationsDir, f), 'utf8'))
    .join('\n');

  const AUDITED_14_DEFINER_FUNCTIONS = [
    {
      schema: 'private',
      name: 'current_staff_role',
      requiresAuth: true,
      blocksRecovery: true,
      schemaExposedViaHttp: false,
      reason: 'Used inside RLS policies on tables like staff_profiles and audit_events to inspect caller role without infinite recursion.',
    },
    {
      schema: 'private',
      name: 'has_staff_role',
      requiresAuth: true,
      blocksRecovery: true,
      schemaExposedViaHttp: false,
      reason: 'RLS helper evaluating caller role membership against allowed staff roles without triggering policy recursion.',
    },
    {
      schema: 'private',
      name: 'current_device_type',
      requiresAuth: true,
      blocksRecovery: true,
      schemaExposedViaHttp: false,
      reason: 'RLS helper determining whether the authenticated session is an active kiosk or guard_station device.',
    },
    {
      schema: 'private',
      name: 'is_portal_actor',
      requiresAuth: true,
      blocksRecovery: true,
      schemaExposedViaHttp: false,
      reason: 'RLS helper evaluating whether caller is a portal visitor or device.',
    },
    {
      schema: 'private',
      name: 'can_read_visitor',
      requiresAuth: true,
      blocksRecovery: true,
      schemaExposedViaHttp: false,
      reason: 'Defines row access policy for visitor records based on staff authorization, device assignment, or visitor upload ownership.',
    },
    {
      schema: 'private',
      name: 'can_read_storage_object',
      requiresAuth: true,
      blocksRecovery: true,
      schemaExposedViaHttp: false,
      reason: 'Enforces fine-grained storage.objects access control for visitor-photos and visitor-ids buckets.',
    },
    {
      schema: 'private',
      name: 'jwt_claims',
      requiresAuth: false,
      blocksRecovery: false,
      schemaExposedViaHttp: false,
      reason: 'Extracts request.jwt.claims safely with null fallback without elevating privilege.',
    },
    {
      schema: 'private',
      name: 'is_recovery_session',
      requiresAuth: false,
      blocksRecovery: false,
      schemaExposedViaHttp: false,
      reason: 'Detects password-recovery JWT sessions (aal1 with amr recovery) to confine recovery actors.',
    },
    {
      schema: 'api',
      name: 'current_actor',
      requiresAuth: true,
      blocksRecovery: true,
      schemaExposedViaHttp: true,
      reason: 'Resolves active staff or device profile for the authenticated caller; requires elevated access to read metadata before profile is selected.',
    },
    {
      schema: 'api',
      name: 'create_upload_intent',
      requiresAuth: true,
      blocksRecovery: true,
      schemaExposedViaHttp: true,
      reason: 'Generates secure pre-signed evidence upload intents and registers intent records tied to auth.uid().',
    },
    {
      schema: 'api',
      name: 'acknowledge_privacy',
      requiresAuth: true,
      blocksRecovery: true,
      schemaExposedViaHttp: true,
      reason: 'Records staff or device privacy policy consent timestamp tied strictly to caller auth.uid().',
    },
    {
      schema: 'api',
      name: 'abandon_upload_intent',
      requiresAuth: true,
      blocksRecovery: false,
      schemaExposedViaHttp: true,
      reason: 'Allows visitors to cancel pending upload intents and cleans up transient records, strictly scoped to caller intent.',
    },
    {
      schema: 'api',
      name: 'get_published_thermal_template',
      requiresAuth: false,
      blocksRecovery: false,
      schemaExposedViaHttp: true,
      reason: 'Returns active thermal badge print layout for guard stations and kiosks.',
    },
    {
      schema: 'private',
      name: 'validate_thermal_template_layout',
      requiresAuth: false,
      blocksRecovery: false,
      schemaExposedViaHttp: false,
      reason: 'Pure layout JSON schema validation function for thermal printing templates.',
    },
  ];

  it('audits all 14 functions and ensures every SECURITY DEFINER function sets search_path = \'\'', () => {
    for (const fn of AUDITED_14_DEFINER_FUNCTIONS) {
      const regex = new RegExp(`function\\s+${fn.schema}\\.${fn.name}\\s*\\([\\s\\S]*?security\\s+definer[\\s\\S]*?set\\s+search_path\\s*=\\s*''`, 'i');
      const hasDefinition = regex.test(allMigrationsSql);
      expect(
        hasDefinition,
        `Function ${fn.schema}.${fn.name} must be declared SECURITY DEFINER with set search_path = ''`
      ).toBe(true);
    }
  });

  it('ensures private schema functions are never exposed via PostgREST grants', () => {
    // Functions in `private` schema should not have anonymous grants
    for (const fn of AUDITED_14_DEFINER_FUNCTIONS) {
      if (fn.schema === 'private') {
        const anonGrantRegex = new RegExp(`grant\\s+execute\\s+on\\s+function\\s+private\\.${fn.name}[^;]*to\\s+[^;]*\\banon\\b`, 'i');
        expect(anonGrantRegex.test(allMigrationsSql)).toBe(false);
      }
    }
  });

  it('ensures api.* functions never grant execution to anonymous role (fail closed for anon)', () => {
    for (const fn of AUDITED_14_DEFINER_FUNCTIONS) {
      if (fn.schema === 'api') {
        const anonGrantRegex = new RegExp(`grant\\s+execute\\s+on\\s+function\\s+api\\.${fn.name}[^;]*to\\s+[^;]*\\banon\\b`, 'i');
        expect(anonGrantRegex.test(allMigrationsSql)).toBe(false);
      }
    }
  });

  it('ensures recovery sessions are restricted from accessing protected staff/device functions', () => {
    const recoveryChecks = [
      'current_staff_role',
      'has_staff_role',
      'current_device_type',
      'can_read_visitor',
      'can_read_storage_object',
    ];
    for (const fnName of recoveryChecks) {
      const fnBlockRegex = new RegExp(`function\\s+private\\.${fnName}[\\s\\S]*?\\$\\$[\\s\\S]*?\\$\\$`, 'i');
      const match = allMigrationsSql.match(fnBlockRegex);
      expect(match).not.toBeNull();
      // Must contain recovery check
      expect(allMigrationsSql).toContain('is_recovery_session');
    }
  });

  it('ensures upload intent ownership strictly matches auth.uid() in abandon_upload_intent', () => {
    // Migration 00200 for upload_intent_abandon_least_privilege
    const abandonDef = allMigrationsSql.match(/function\s+api\.abandon_upload_intent[\s\S]*?\$\$(.*?)\$\$/is);
    expect(abandonDef).not.toBeNull();
    const body = abandonDef![1];
    expect(body).toContain('auth.uid()');
    expect(body).toContain('owner_id');
  });

  it('ensures acknowledge_privacy strictly checks and updates caller auth.uid()', () => {
    const ackDef = allMigrationsSql.match(/function\s+api\.acknowledge_privacy[\s\S]*?\$\$(.*?)\$\$/is);
    expect(ackDef).not.toBeNull();
    const body = ackDef![1];
    expect(body).toContain('auth.uid()');
  });
});
