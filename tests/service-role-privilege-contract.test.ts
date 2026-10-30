import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  SERVICE_ROLE_TABLE_CONTRACT,
  SERVER_DIRECT_TABLE_OPERATIONS,
  type PrivilegeType,
} from '../server/privilege-contract.js';

function collectFiles(dir: string, ext = ['.ts', '.js']): string[] {
  const result: string[] = [];
  const entries = readdirSync(dir);
  for (const entry of entries) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (entry !== 'node_modules' && entry !== 'dist' && entry !== '.git') {
        result.push(...collectFiles(full, ext));
      }
    } else if (ext.some((e) => entry.endsWith(e))) {
      result.push(full);
    }
  }
  return result;
}

describe('Service Role Least-Privilege Architecture Contract', () => {
  it('covers all 16 canonical public application tables in the contract', () => {
    const expectedTables = [
      'app_settings',
      'audit_events',
      'devices',
      'incident_holds',
      'maintenance_state',
      'pass_email_verifications',
      'passes',
      'portal_identity_verification_attempts',
      'rate_limit_buckets',
      'resend_webhook_events',
      'reconciliation_tasks',
      'staff_profiles',
      'upload_intents',
      'visit_events',
      'visitor_evidence',
      'visitors',
    ].sort();

    const contractedTables = Object.keys(SERVICE_ROLE_TABLE_CONTRACT).sort();
    expect(contractedTables).toEqual(expectedTables);
  });

  it('scans all server/ and api/ code to ensure every direct table operation is registered', () => {
    const rootDir = process.cwd();
    const serverFiles = collectFiles(join(rootDir, 'server'));
    const apiFiles = collectFiles(join(rootDir, 'api'));
    const allFiles = [...serverFiles, ...apiFiles];

    const detectedCalls: Array<{ file: string; table: string }> = [];

    for (const filePath of allFiles) {
      const rel = relative(rootDir, filePath).replace(/\\/g, '/');
      const content = readFileSync(filePath, 'utf8');
      const lines = content.split('\n');

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const match = line.match(/\.from\(\s*['"]([a-zA-Z0-9_]+)['"]\s*\)/);
        if (match) {
          detectedCalls.push({ file: rel, table: match[1] });
        }
      }
    }

    // Every detected file and table must match an entry in SERVER_DIRECT_TABLE_OPERATIONS
    for (const detected of detectedCalls) {
      const registration = SERVER_DIRECT_TABLE_OPERATIONS.find(
        (op) => op.file === detected.file && op.table === detected.table
      );
      expect(
        registration,
        `Unregistered direct table access found: ${detected.file} queries table '${detected.table}' without registration in SERVER_DIRECT_TABLE_OPERATIONS`
      ).toBeDefined();

      // Check that the table has contract
      const contract = SERVICE_ROLE_TABLE_CONTRACT[detected.table];
      expect(contract, `Table '${detected.table}' queried in ${detected.file} lacks contract in SERVICE_ROLE_TABLE_CONTRACT`).toBeDefined();
    }
  });

  it('enforces RPC-only mutation boundaries on protected domain tables', () => {
    const rpcOnlyTables = [
      'passes',
      'devices',
      'staff_profiles',
      'incident_holds',
      'app_settings',
      'visitor_evidence',
      'visit_events',
    ];

    for (const table of rpcOnlyTables) {
      const contract = SERVICE_ROLE_TABLE_CONTRACT[table];
      expect(contract).toBeDefined();
      expect(contract.allowedPrivileges).not.toContain('INSERT');
      expect(contract.allowedPrivileges).not.toContain('UPDATE');
      expect(contract.allowedPrivileges).not.toContain('DELETE');
      expect(contract.forbiddenPrivileges).toContain('INSERT');
      expect(contract.forbiddenPrivileges).toContain('UPDATE');
      expect(contract.forbiddenPrivileges).toContain('DELETE');
    }
  });

  it('enforces audit log immutability by strictly forbidding UPDATE on audit_events', () => {
    const auditContract = SERVICE_ROLE_TABLE_CONTRACT['audit_events'];
    expect(auditContract).toBeDefined();
    expect(auditContract.allowedPrivileges).toContain('SELECT');
    expect(auditContract.allowedPrivileges).toContain('INSERT');
    expect(auditContract.allowedPrivileges).toContain('DELETE'); // Retention purge only
    expect(auditContract.allowedPrivileges).not.toContain('UPDATE');
    expect(auditContract.forbiddenPrivileges).toContain('UPDATE');
  });

  it('strictly isolates rate_limit_buckets from direct server table access', () => {
    const rateContract = SERVICE_ROLE_TABLE_CONTRACT['rate_limit_buckets'];
    expect(rateContract).toBeDefined();
    expect(rateContract.allowedPrivileges).toHaveLength(0);
    expect(rateContract.forbiddenPrivileges).toEqual(['SELECT', 'INSERT', 'UPDATE', 'DELETE']);
  });
});
