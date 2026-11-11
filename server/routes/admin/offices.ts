import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { HttpError, recordReconciliation, requireStaffActor } from '../../actors.js';
import { jsonResponse, readBearerToken } from '../../http.js';
import { getServerSupabaseClients } from '../../supabase.js';

const createOfficeSchema = z.object({
  action: z.literal('create_office').optional(),
  name: z.string().trim().min(2).max(100),
  description: z.string().trim().max(300).optional(),
  active: z.boolean().optional().default(true),
});

const assignStaffSchema = z.object({
  action: z.literal('assign_staff'),
  userId: z.string().uuid(),
  officeId: z.string().uuid(),
});

const removeStaffSchema = z.object({
  action: z.literal('remove_staff'),
  userId: z.string().uuid(),
  officeId: z.string().uuid(),
});

const patchOfficeSchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(2).max(100).optional(),
  description: z.string().trim().max(300).optional(),
  active: z.boolean().optional(),
  verified: z.boolean().optional(),
});

const provisionAccountSchema = z.object({
  action: z.literal('provision_account'),
  officeId: z.string().uuid(),
  staffEmail: z.string().trim().email().max(320),
  displayName: z.string().trim().min(2).max(100).optional(),
  operationId: z.string().uuid().optional(),
});

const resetCredentialsSchema = z.object({
  action: z.literal('reset_account_credentials'),
  userId: z.string().uuid(),
  officeId: z.string().uuid().optional(),
});

const resendVerificationSchema = z.object({
  action: z.literal('resend_verification_email'),
  userId: z.string().uuid(),
  officeId: z.string().uuid().optional(),
});

const toggleAccountActiveSchema = z.object({
  action: z.literal('toggle_account_active'),
  userId: z.string().uuid(),
  active: z.boolean(),
});

type OfficeStaffDirectoryEntry = {
  userId: string;
  displayName: string;
  role: string;
  active: boolean;
  mustChangePassword: boolean;
  email?: string;
  emailConfirmed?: boolean;
};

type AuthUserRecord = {
  id: string;
  email?: string | null;
  email_confirmed_at?: string | null;
  app_metadata?: Record<string, unknown> | null;
};

async function findAuthUserByEmail(
  admin: ReturnType<typeof getServerSupabaseClients>['admin'],
  normalizedEmail: string,
): Promise<AuthUserRecord | null> {
  const perPage = 200;
  for (let page = 1; page <= 25; page += 1) {
    const res = await admin.auth.admin.listUsers({ page, perPage });
    if (res.error) {
      throw res.error;
    }
    const users = (res.data?.users || []) as AuthUserRecord[];
    const match = users.find((u) => (u.email || '').toLowerCase().trim() === normalizedEmail);
    if (match) return match;
    if (users.length < perPage) break;
  }
  return null;
}

async function hydrateAuthStaffEntries(
  admin: ReturnType<typeof getServerSupabaseClients>['admin'],
  staffMap: Map<string, OfficeStaffDirectoryEntry>,
): Promise<boolean> {
  const targetIds = new Set(staffMap.keys());
  if (targetIds.size === 0) return false;

  const resolvedIds = new Set<string>();
  let hadWarning = false;

  try {
    const perPage = 200;
    for (let page = 1; page <= 25 && resolvedIds.size < targetIds.size; page += 1) {
      const res = await admin.auth.admin.listUsers({ page, perPage });
      if (res.error) {
        hadWarning = true;
        console.warn('Could not list auth users for office staff directory:', res.error);
        break;
      }
      const users = (res.data?.users || []) as AuthUserRecord[];
      for (const u of users) {
        const entry = staffMap.get(u.id);
        if (entry) {
          entry.email = u.email ?? '';
          entry.emailConfirmed = Boolean(u.email_confirmed_at);
          resolvedIds.add(u.id);
        }
      }
      if (users.length < perPage) break;
    }
  } catch (err) {
    hadWarning = true;
    console.warn('Could not list auth users for office staff directory:', err);
  }

  const unresolved = Array.from(targetIds).filter((uid) => !resolvedIds.has(uid));
  if (unresolved.length > 0 && typeof admin.auth?.admin?.getUserById === 'function') {
    const results = await Promise.allSettled(
      unresolved.map((uid) => admin.auth.admin.getUserById(uid))
    );
    for (let i = 0; i < unresolved.length; i += 1) {
      const uid = unresolved[i]!;
      const settled = results[i];
      if (settled?.status === 'fulfilled' && !settled.value.error && settled.value.data?.user) {
        const u = settled.value.data.user as AuthUserRecord;
        const entry = staffMap.get(uid);
        if (entry) {
          entry.email = u.email ?? '';
          entry.emailConfirmed = Boolean(u.email_confirmed_at);
          resolvedIds.add(uid);
        }
      } else {
        hadWarning = true;
      }
    }
  }

  return hadWarning;
}

export function generateTemporaryPassword(): string {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghijkmnopqrstuvwxyz';
  const digits = '23456789';
  const symbols = '!@#$%^&*-_+=';

  const pick = (set: string, count: number) => {
    let res = '';
    const bytes = randomBytes(count);
    for (let i = 0; i < count; i++) {
      const b = bytes[i] ?? 0;
      res += set[b % set.length];
    }
    return res;
  };

  const parts = [
    pick(upper, 4),
    pick(lower, 4),
    pick(digits, 4),
    pick(symbols, 4),
  ].join('');

  const arr = parts.split('');
  for (let i = arr.length - 1; i > 0; i--) {
    const b = randomBytes(1)[0] ?? 0;
    const j = b % (i + 1);
    const temp = arr[i] ?? '';
    arr[i] = arr[j] ?? '';
    arr[j] = temp;
  }
  return arr.join('');
}

export async function handleRequest(request: Request): Promise<Response> {
  try {
    const token = readBearerToken(request);
    if (!token) return jsonResponse(401, { error: 'authentication_required' });

    const { admin } = getServerSupabaseClients();
    const actor = await requireStaffActor(admin, token, ['admin', 'superadmin']);

  if (request.method === 'GET') {
    const url = new URL(request.url);
    const withPersonnel = url.searchParams.get('withPersonnel') === 'true';

    const { data: offices, error: officeErr } = await admin
      .from('offices')
      .select('id, name, description, active, verified, verified_at, verified_by, created_at, updated_at')
      .order('name', { ascending: true });

    if (officeErr) {
      console.error('Failed to load offices directory:', officeErr);
      return jsonResponse(503, { error: 'office_directory_load_failed', message: 'Failed to load office directory.' });
    }

    const { data: assignments, error: assignErr } = await admin
      .from('office_staff_assignments')
      .select('office_id, user_id');

    if (assignErr) {
      console.error('Failed to load office staff assignments:', assignErr);
      return jsonResponse(503, { error: 'office_assignments_load_failed', message: 'Failed to load office staff assignments.' });
    }

    const allAssignedUserIds = Array.from(new Set((assignments || []).map((a) => a.user_id)));
    const staffMap = new Map<string, OfficeStaffDirectoryEntry>();
    const warnings: string[] = [];

    if (allAssignedUserIds.length > 0) {
      const { data: profiles, error: profErr } = await admin
        .from('staff_profiles')
        .select('user_id, display_name, role, active, must_change_password')
        .in('user_id', allAssignedUserIds);

      if (profErr) {
        console.error('Failed to load assigned staff profiles:', profErr);
        return jsonResponse(503, { error: 'staff_profiles_load_failed', message: 'Failed to load assigned staff profiles.' });
      }

      for (const p of profiles || []) {
        staffMap.set(p.user_id, {
          userId: p.user_id,
          displayName: p.display_name,
          role: p.role,
          active: p.active,
          mustChangePassword: p.must_change_password,
        });
      }

      const authLookupHadWarning = await hydrateAuthStaffEntries(admin, staffMap);
      if (authLookupHadWarning) {
        warnings.push('auth_directory_partial');
      }
    }

    const assignmentMap = new Map<string, string[]>();
    for (const a of assignments || []) {
      const list = assignmentMap.get(a.office_id) || [];
      list.push(a.user_id);
      assignmentMap.set(a.office_id, list);
    }

    const personnelMap = new Map<string, Array<{ id: string; name: string; title: string | null; active: boolean }>>();
    let personnelUnavailable = false;
    if (withPersonnel) {
      try {
        const { data: personnel, error: persErr } = await admin
          .from('office_personnel')
          .select('id, office_id, name, title, active')
          .order('name', { ascending: true });

        if (persErr) {
          console.warn('Optional office_personnel lookup failed; returning base office directory:', persErr);
          personnelUnavailable = true;
          warnings.push('personnel_unavailable');
        } else {
          for (const p of personnel || []) {
            const list = personnelMap.get(p.office_id) || [];
            list.push({ id: p.id, name: p.name, title: p.title, active: p.active });
            personnelMap.set(p.office_id, list);
          }
        }
      } catch (err) {
        console.warn('Optional office_personnel lookup threw; returning base office directory:', err);
        personnelUnavailable = true;
        warnings.push('personnel_unavailable');
      }
    }

    const result = (offices || []).map((o) => {
      const assignedUserIds = assignmentMap.get(o.id) || [];
      const assignedStaff = assignedUserIds
        .map((uid) => staffMap.get(uid))
        .filter((s): s is NonNullable<typeof s> => Boolean(s));

      const dedicated = assignedStaff.find((s) => s.role === 'office_staff') || assignedStaff[0] || null;

      return {
        ...o,
        assignedStaffIds: assignedUserIds,
        staffCount: assignedUserIds.length,
        assignedStaff,
        dedicatedAccount: dedicated,
        personnel: withPersonnel ? personnelMap.get(o.id) || [] : undefined,
      };
    });

    return jsonResponse(200, {
      offices: result,
      ...(personnelUnavailable ? { personnelUnavailable: true } : {}),
      ...(warnings.length > 0 ? { warnings } : {}),
    });
  }

  // General mutations (create office, provision, reset credentials, assign) permitted for admin and superadmin.

  if (request.method === 'POST') {
    const body = await request.json().catch(() => null);

    // ==========================================
    // ACTION: PROVISION DEDICATED OFFICE ACCOUNT
    // ==========================================
    if (body?.action === 'provision_account') {
      const parsed = provisionAccountSchema.safeParse(body);
      if (!parsed.success) return jsonResponse(400, { error: 'invalid_request', details: parsed.error.issues });

      const { officeId, staffEmail, displayName, operationId: suppliedOperationId } = parsed.data;
      const operationId = suppliedOperationId ?? randomUUID();

      const { data: office, error: offErr } = await admin
        .from('offices')
        .select('id, name, active')
        .eq('id', officeId)
        .maybeSingle();

      if (offErr) {
        console.error('Failed to look up office for provisioning:', offErr);
        return jsonResponse(503, { error: 'office_lookup_failed', message: 'Failed to verify office record.' });
      }
      if (!office) {
        return jsonResponse(404, { error: 'office_not_found', message: 'The specified office does not exist' });
      }

      if (!office.active) {
        return jsonResponse(400, { error: 'office_inactive', message: 'Cannot provision accounts for inactive offices' });
      }

      const email = staffEmail.toLowerCase().trim();
      const staffName = (displayName || `${office.name} Staff`).trim();

      const markOperation = async (params: {
        authUserId?: string | null;
        status?: string;
        emailDeliveryStatus?: string;
        errorCode?: string | null;
        errorMessage?: string | null;
        reconciliationRecorded?: boolean;
      }) => {
        const updateRes = await admin.schema('api').rpc('update_office_provisioning_operation', {
          requested_actor_id: actor.id,
          requested_operation_id: operationId,
          requested_auth_user_id: params.authUserId ?? null,
          requested_status: params.status ?? null,
          requested_email_delivery_status: params.emailDeliveryStatus ?? null,
          requested_error_code: params.errorCode === undefined ? null : (params.errorCode ?? ''),
          requested_error_message: params.errorMessage === undefined ? null : (params.errorMessage ?? ''),
          requested_reconciliation_recorded: params.reconciliationRecorded ?? null,
        });
        if (updateRes.error) {
          console.error('Failed to update provisioning operation journal:', updateRes.error);
        }
      };

      const claimRes = await admin.schema('api').rpc('claim_office_provisioning_operation', {
        requested_actor_id: actor.id,
        requested_operation_id: operationId,
        requested_office_id: officeId,
        requested_email: email,
        requested_display_name: staffName,
      });

      if (claimRes.error) {
        const errCode = claimRes.error.code;
        const errMsg = claimRes.error.message || 'provisioning_journal_unavailable';
        if (errCode === 'P0002') {
          return jsonResponse(404, { error: 'office_not_found', message: 'The specified office does not exist' });
        }
        if (errCode === '42501') {
          if (errMsg.includes('office is inactive')) {
            return jsonResponse(400, { error: 'office_inactive', message: 'Cannot provision accounts for inactive offices' });
          }
          return jsonResponse(403, { error: 'forbidden', message: errMsg });
        }
        if (errCode === '22023') {
          return jsonResponse(400, { error: 'invalid_request', message: errMsg });
        }
        if (errCode === 'PGRST202' || errMsg.includes('claim_office_provisioning_operation')) {
          return jsonResponse(503, { error: 'service_unavailable_migration_required', message: 'Database migration 86 is required.' });
        }
        return jsonResponse(503, { error: 'provisioning_journal_unavailable', message: 'Could not initialize provisioning operation journal.' });
      }

      const claimPayload = (claimRes.data && typeof claimRes.data === 'object' ? claimRes.data : {}) as {
        action?: string;
        officeName?: string;
        operation?: {
          operation_id?: string;
          auth_user_id?: string | null;
          status?: string;
          email_delivery_status?: string;
          display_name?: string;
          reconciliation_recorded?: boolean;
        };
      };
      const claimAction = claimPayload.action || 'proceed';
      const claimedOp = claimPayload.operation || {};

      if (claimAction === 'operation_mismatch') {
        return jsonResponse(409, {
          error: 'operation_id_mismatch',
          message: 'This provisioning operation ID is already bound to a different office or email.',
          operationId,
        });
      }

      if (claimAction === 'compensation_failed') {
        return jsonResponse(409, {
          error: 'provisioning_compensation_failed',
          compensationStatus: 'compensation_failed',
          reconciliationRequired: true,
          message: 'A previous provisioning attempt with this operation ID requires administrator reconciliation before retrying.',
          operationId,
        });
      }

      if (claimAction === 'replay_completed') {
        const existingUserId = claimedOp.auth_user_id ?? null;
        let staffSummary: OfficeStaffDirectoryEntry = {
          userId: existingUserId || '',
          displayName: claimedOp.display_name || staffName,
          role: 'office_staff',
          active: true,
          mustChangePassword: true,
          email,
          emailConfirmed: false,
        };

        if (existingUserId) {
          const [{ data: staffRow }, authLookup] = await Promise.all([
            admin
              .from('staff_profiles')
              .select('user_id, display_name, role, active, must_change_password')
              .eq('user_id', existingUserId)
              .maybeSingle(),
            admin.auth.admin.getUserById(existingUserId).catch(() => ({ data: { user: null }, error: null })),
          ]);
          const authUser = (authLookup as { data?: { user?: AuthUserRecord | null } })?.data?.user ?? null;
          staffSummary = {
            userId: existingUserId,
            displayName: staffRow?.display_name || staffSummary.displayName,
            role: staffRow?.role || 'office_staff',
            active: staffRow?.active ?? true,
            mustChangePassword: staffRow?.must_change_password ?? true,
            email: authUser?.email || email,
            emailConfirmed: Boolean(authUser?.email_confirmed_at),
          };
        }

        const emailSent = claimedOp.email_delivery_status === 'sent';
        const emailFailed = claimedOp.email_delivery_status === 'failed';

        return jsonResponse(200, {
          ok: true,
          replayed: true,
          outcome: 'replayed_completed',
          operationId,
          officeId,
          userId: existingUserId,
          email: staffSummary.email || email,
          temporaryPasswordIssued: false,
          mustChangePassword: staffSummary.mustChangePassword,
          emailConfirmed: Boolean(staffSummary.emailConfirmed),
          verificationEmailSent: emailSent,
          ...(emailFailed
            ? {
                reconciliationRequired: true,
                warning: 'This office account was already provisioned earlier, but its initial verification email failed. Use Resend Verification Email or Reset Credentials if the temporary password was lost.',
              }
            : {}),
          staffAccountSummary: staffSummary,
        });
      }

      let targetUserId: string | null = null;
      let temporaryPassword: string | undefined;
      let temporaryPasswordIssued = false;
      let createdFreshAuthUser = false;

      if (claimAction === 'resume_incomplete' && claimedOp.auth_user_id) {
        const authLookup = await admin.auth.admin.getUserById(claimedOp.auth_user_id).catch(() => ({ data: { user: null }, error: { message: 'lookup_failed' } }));
        const existingAuthUser = (authLookup as { data?: { user?: AuthUserRecord | null } })?.data?.user ?? null;
        const appMeta = (existingAuthUser?.app_metadata || {}) as Record<string, unknown>;
        const emailMatches = (existingAuthUser?.email || '').toLowerCase().trim() === email;
        const provenanceMatches =
          Boolean(existingAuthUser) &&
          emailMatches &&
          appMeta.provisioning_source === 'office_account' &&
          (!appMeta.provisioning_operation_id || appMeta.provisioning_operation_id === operationId) &&
          (!appMeta.provisioning_office_id || appMeta.provisioning_office_id === officeId);

        if (!provenanceMatches || !existingAuthUser) {
          await markOperation({
            status: 'failed',
            errorCode: 'existing_account_conflict',
            errorMessage: 'Incomplete operation could not verify provisioning provenance.',
          });
          return jsonResponse(409, {
            error: 'existing_account_conflict',
            message: `An existing account for "${email}" does not match the provenance of this provisioning operation.`,
            operationId,
          });
        }

        targetUserId = existingAuthUser.id;
      } else {
        const candidatePassword = generateTemporaryPassword();
        const created = await admin.auth.admin.createUser({
          email,
          password: candidatePassword,
          email_confirm: false,
          app_metadata: {
            provisioning_source: 'office_account',
            provisioning_operation_id: operationId,
            provisioning_office_id: officeId,
          },
        });

        if (created.error || !created.data?.user) {
          const err = created.error;
          const msg = typeof err === 'object' && err !== null && 'message' in err ? String(err.message).toLowerCase() : '';
          const errCode = typeof err === 'object' && err !== null && 'code' in err ? String((err as { code?: string }).code).toLowerCase() : '';
          const isDuplicate =
            msg.includes('already exists') ||
            msg.includes('already registered') ||
            errCode === 'email_exists';

          if (!isDuplicate) {
            await markOperation({
              status: 'failed',
              errorCode: errCode || 'auth_user_creation_failed',
              errorMessage: msg || 'auth_user_creation_failed',
            });
            return jsonResponse(503, {
              error: 'auth_user_creation_failed',
              message: 'Failed to create Auth user for the office account. Please retry.',
              operationId,
            });
          }

          let existingAuthUser: AuthUserRecord | null = null;
          try {
            existingAuthUser = await findAuthUserByEmail(admin, email);
          } catch (lookupErr) {
            console.error('Paginated auth lookup failed on duplicate email:', lookupErr);
            await markOperation({
              status: 'failed',
              errorCode: 'auth_lookup_failed',
              errorMessage: 'Could not inspect existing auth user after duplicate email error.',
            });
            return jsonResponse(503, {
              error: 'auth_lookup_failed',
              message: 'An account with this email may already exist, and Auth directory lookup failed.',
              operationId,
            });
          }

          const appMeta = (existingAuthUser?.app_metadata || {}) as Record<string, unknown>;
          const provenanceMatches =
            Boolean(existingAuthUser) &&
            appMeta.provisioning_source === 'office_account' &&
            appMeta.provisioning_operation_id === operationId &&
            appMeta.provisioning_office_id === officeId;

          if (!existingAuthUser || !provenanceMatches) {
            await markOperation({
              status: 'failed',
              errorCode: 'existing_account_conflict',
              errorMessage: 'Email is already registered to an unrelated account.',
            });
            return jsonResponse(409, {
              error: 'existing_account_conflict',
              message: `An account with email "${email}" is already registered outside this provisioning operation. Use another email or assign an existing verified office staff account.`,
              operationId,
            });
          }

          const [{ data: existingProfile }, { data: existingDevice }] = await Promise.all([
            admin
              .from('staff_profiles')
              .select('user_id, role')
              .eq('user_id', existingAuthUser.id)
              .maybeSingle(),
            admin
              .from('devices')
              .select('id')
              .eq('user_id', existingAuthUser.id)
              .maybeSingle(),
          ]);

          if (existingDevice || (existingProfile && existingProfile.role !== 'office_staff')) {
            await markOperation({
              status: 'failed',
              errorCode: 'existing_account_conflict',
              errorMessage: 'Matched email belongs to a device or non-office staff account.',
            });
            return jsonResponse(409, {
              error: 'existing_account_conflict',
              message: `The existing account for "${email}" belongs to another account type and cannot be adopted.`,
              operationId,
            });
          }

          targetUserId = existingAuthUser.id;
          temporaryPasswordIssued = false;
        } else {
          targetUserId = created.data.user.id;
          temporaryPassword = candidatePassword;
          temporaryPasswordIssued = true;
          createdFreshAuthUser = true;
        }
      }

      await markOperation({
        authUserId: targetUserId,
        status: 'auth_created',
        emailDeliveryStatus: 'pending',
        errorCode: '',
        errorMessage: '',
      });

      // Atomic DB provisioning via RPC: staff_profiles (role=office_staff, must_change_password=true) + office_staff_assignments + audit_events
      const rpcRes = await admin.schema('api').rpc('provision_office_staff_account', {
        requested_actor_id: actor.id,
        requested_user_id: targetUserId,
        requested_office_id: officeId,
        requested_name: staffName,
        requested_request_id: operationId,
      });

      if (rpcRes.error) {
        console.error('Database provisioning failed:', rpcRes.error);
        if (!createdFreshAuthUser) {
          await markOperation({
            authUserId: targetUserId,
            status: 'failed',
            errorCode: rpcRes.error.code || 'provisioning_failed',
            errorMessage: rpcRes.error.message,
          });
          return jsonResponse(500, {
            error: 'provisioning_failed',
            compensationStatus: 'skipped_existing_user',
            message: 'Failed to provision office staff profile in database during retry.',
            operationId,
            details: rpcRes.error.message,
          });
        }

        const delRes = await admin.auth.admin.deleteUser(targetUserId).catch((e) => ({ error: e }));
        if (delRes?.error) {
          console.error('CRITICAL: Auth rollback failed during office provisioning compensation:', delRes.error);
          await recordReconciliation(
            admin,
            'office.provision_compensation_failed',
            'auth.users',
            targetUserId,
            `Rollback failed after DB error: ${rpcRes.error.message}`,
            { officeId, email, operationId }
          ).catch(() => undefined);
          await markOperation({
            authUserId: targetUserId,
            status: 'compensation_failed',
            emailDeliveryStatus: 'not_attempted',
            errorCode: 'provisioning_compensation_failed',
            errorMessage: rpcRes.error.message,
            reconciliationRecorded: true,
          });
          return jsonResponse(500, {
            error: 'provisioning_compensation_failed',
            compensationStatus: 'compensation_failed',
            reconciliationRequired: true,
            message: 'Failed to provision office staff profile in database and rollback of the temporary Auth account failed. Administrator reconciliation is required.',
            operationId,
            details: rpcRes.error.message,
          });
        }

        await markOperation({
          authUserId: targetUserId,
          status: 'compensated',
          emailDeliveryStatus: 'not_attempted',
          errorCode: rpcRes.error.code || 'provisioning_failed',
          errorMessage: rpcRes.error.message,
        });
        return jsonResponse(500, {
          error: 'provisioning_failed',
          compensationStatus: 'rolled_back',
          message: 'Failed to provision office staff profile in database. Auth account was rolled back.',
          operationId,
          details: rpcRes.error.message,
        });
      }

      // Dispatch real email verification via Supabase Auth / Resend
      const resendResult = await admin.auth.resend({
        type: 'signup',
        email,
      }).catch((err) => ({ error: err }));

      const staffAccountSummary: OfficeStaffDirectoryEntry = {
        userId: targetUserId,
        displayName: staffName,
        role: 'office_staff',
        active: true,
        mustChangePassword: true,
        email,
        emailConfirmed: false,
      };

      if (resendResult?.error) {
        const deliveryErrMsg = (resendResult.error as { message?: string })?.message || 'resend_failed';
        console.warn('Office staff verification email delivery failed:', resendResult.error);
        await recordReconciliation(
          admin,
          'office.verification_email_failed',
          'staff_profiles',
          targetUserId,
          deliveryErrMsg,
          { email, officeId, operationId }
        ).catch(() => undefined);

        await markOperation({
          authUserId: targetUserId,
          status: 'completed',
          emailDeliveryStatus: 'failed',
          errorCode: 'verification_email_failed',
          errorMessage: deliveryErrMsg,
          reconciliationRecorded: true,
        });

        return jsonResponse(200, {
          ok: true,
          outcome: 'provisioned_email_failed',
          operationId,
          officeId,
          userId: targetUserId,
          email,
          ...(temporaryPasswordIssued && temporaryPassword ? { temporaryPassword } : {}),
          temporaryPasswordIssued,
          mustChangePassword: true,
          emailConfirmed: false,
          verificationEmailSent: false,
          reconciliationRequired: true,
          warning: 'Office account created, but the verification email could not be delivered. Retry verification email from the office directory.',
          staffAccountSummary,
        });
      }

      await markOperation({
        authUserId: targetUserId,
        status: 'completed',
        emailDeliveryStatus: 'sent',
        errorCode: '',
        errorMessage: '',
      });

      return jsonResponse(200, {
        ok: true,
        outcome: 'provisioned',
        operationId,
        officeId,
        userId: targetUserId,
        email,
        ...(temporaryPasswordIssued && temporaryPassword ? { temporaryPassword } : {}),
        temporaryPasswordIssued,
        mustChangePassword: true,
        emailConfirmed: false,
        verificationEmailSent: true,
        staffAccountSummary,
      });
    }

    // ==========================================
    // ACTION: RESET DEDICATED OFFICE CREDENTIALS
    // ==========================================
    if (body?.action === 'reset_account_credentials') {
      const parsed = resetCredentialsSchema.safeParse(body);
      if (!parsed.success) return jsonResponse(400, { error: 'invalid_request', details: parsed.error.issues });

      const { userId, officeId } = parsed.data;

      const { data: staff, error: stErr } = await admin
        .from('staff_profiles')
        .select('user_id, display_name, role, active')
        .eq('user_id', userId)
        .maybeSingle();

      if (stErr) throw stErr;
      if (!staff) {
        return jsonResponse(404, { error: 'staff_not_found', message: 'Staff profile not found' });
      }

      // If officeId is specified, verify that the staff is assigned to that office
      if (officeId) {
        const { data: assignment, error: assignErr } = await admin
          .from('office_staff_assignments')
          .select('id')
          .eq('user_id', userId)
          .eq('office_id', officeId)
          .maybeSingle();

        if (assignErr) throw assignErr;
        if (!assignment) {
          return jsonResponse(403, {
            error: 'staff_not_assigned_to_office',
            message: 'This staff account is not assigned to the requested office',
          });
        }
      }

      const temporaryPassword = generateTemporaryPassword();

      const { error: authErr } = await admin.auth.admin.updateUserById(userId, {
        password: temporaryPassword,
      });
      if (authErr) throw authErr;

      // Mark profile for mandatory password change and record audit event via RPC
      const rpcRes = await admin.schema('api').rpc('reset_staff_temporary_password', {
        requested_actor_id: actor.id,
        requested_user_id: userId,
        requested_request_id: randomUUID(),
        requested_office_id: officeId || null,
      });

      if (rpcRes.error) {
        console.error('CRITICAL: reset_staff_temporary_password failed after Auth password update:', rpcRes.error);
        
        // Active fail-closed compensation: actively revoke the temporary password by setting it to an unguessable 256-bit random secret
        const revokeSecret = randomBytes(32).toString('hex');
        const revokeRes = await admin.auth.admin.updateUserById(userId, {
          password: revokeSecret,
        }).catch((e) => ({ error: e }));

        if (revokeRes?.error) {
          console.error('CRITICAL: Failed to overwrite Auth password during reset failure compensation. Locking account:', revokeRes.error);
          await admin.auth.admin.updateUserById(userId, { ban_duration: '876000h' }).catch(() => undefined);
          await recordReconciliation(
            admin,
            'office.reset_compensation_failed',
            'auth.users',
            userId,
            `Revocation failed after DB error: ${rpcRes.error.message}`,
            { officeId }
          ).catch(() => undefined);
        }

        await recordReconciliation(
          admin,
          'office.reset_enforcement_failed',
          'staff_profiles',
          userId,
          `Password updated but forced-change flag failed: ${rpcRes.error.message}`,
          { officeId }
        ).catch(() => undefined);

        return jsonResponse(500, {
          error: 'reset_enforcement_failed',
          message: 'Failed to enforce mandatory password change on staff profile. Temporary credentials have been invalidated and revoked.',
        });
      }

      return jsonResponse(200, {
        ok: true,
        userId,
        temporaryPassword,
        mustChangePassword: true,
      });
    }

    // ==========================================
    // ACTION: RESEND OFFICE ACCOUNT VERIFICATION
    // ==========================================
    if (body?.action === 'resend_verification_email') {
      const parsed = resendVerificationSchema.safeParse(body);
      if (!parsed.success) return jsonResponse(400, { error: 'invalid_request', details: parsed.error.issues });

      const { userId, officeId } = parsed.data;

      const { data: staff, error: stErr } = await admin
        .from('staff_profiles')
        .select('user_id, display_name, role, active, decommissioned_at')
        .eq('user_id', userId)
        .maybeSingle();

      if (stErr) {
        console.error('Failed to look up staff for verification resend:', stErr);
        return jsonResponse(503, { error: 'staff_lookup_failed', message: 'Failed to verify staff account.' });
      }
      if (!staff) {
        return jsonResponse(404, { error: 'staff_not_found', message: 'Staff profile not found' });
      }
      if ((staff as { decommissioned_at?: string | null }).decommissioned_at) {
        return jsonResponse(409, { error: 'target_decommissioned', message: 'Cannot send verification email for a decommissioned staff account.' });
      }
      if (!staff.active) {
        return jsonResponse(409, { error: 'staff_inactive', message: 'Cannot send verification email for an inactive staff account.' });
      }

      if (officeId) {
        const { data: assignment, error: assignErr } = await admin
          .from('office_staff_assignments')
          .select('id')
          .eq('user_id', userId)
          .eq('office_id', officeId)
          .maybeSingle();

        if (assignErr) throw assignErr;
        if (!assignment) {
          return jsonResponse(403, {
            error: 'staff_not_assigned_to_office',
            message: 'This staff account is not assigned to the requested office',
          });
        }
      }

      const { data: authUser, error: authUserErr } = await admin.auth.admin.getUserById(userId);
      if (authUserErr || !authUser?.user) {
        return jsonResponse(404, { error: 'auth_user_not_found' });
      }

      if (authUser.user.email_confirmed_at) {
        return jsonResponse(400, {
          error: 'email_already_verified',
          message: 'This staff account email address has already been verified.',
        });
      }

      const resendRes = await admin.auth.resend({
        type: 'signup',
        email: authUser.user.email!,
      }).catch((e) => ({ error: e }));

      if (resendRes?.error) {
        return jsonResponse(500, {
          error: 'resend_failed',
          message: (resendRes.error as any)?.message || 'Failed to dispatch verification email',
        });
      }

      return jsonResponse(200, {
        ok: true,
        userId,
        email: authUser.user.email,
        verificationEmailSent: true,
      });
    }

    // ==========================================
    // ACTION: TOGGLE OFFICE ACCOUNT ACTIVE
    // ==========================================
    if (body?.action === 'toggle_account_active') {
      const parsed = toggleAccountActiveSchema.safeParse(body);
      if (!parsed.success) return jsonResponse(400, { error: 'invalid_request', details: parsed.error.issues });

      const { userId, active } = parsed.data;

      // Update active state and record audit event via authoritative RPC
      const updateRes = await admin.schema('api').rpc('update_staff_profile', {
        requested_actor_id: actor.id,
        requested_user_id: userId,
        requested_role: null,
        requested_active: active,
        requested_request_id: randomUUID(),
      });

      if (updateRes.error) throw updateRes.error;

      return jsonResponse(200, { ok: true, userId, active });
    }

    if (body?.action === 'verify_office' || body?.action === 'unverify_office') {
      if (actor.role !== 'superadmin') {
        return jsonResponse(403, {
          error: 'superadmin_required',
          message: 'Only superadmin can verify or unverify campus offices',
        });
      }
      const officeId = body.officeId;
      if (!officeId || typeof officeId !== 'string') {
        return jsonResponse(400, { error: 'invalid_office_id' });
      }

      const { data: existingOffice, error: chkErr } = await admin
        .from('offices')
        .select('id')
        .eq('id', officeId)
        .maybeSingle();
      if (chkErr) throw chkErr;
      if (!existingOffice) {
        return jsonResponse(404, { error: 'office_not_found', message: 'The specified office does not exist' });
      }

      const isVerify = body.action === 'verify_office';
      const { data: updatedOffice, error: vErr } = await admin
        .from('offices')
        .update({
          verified: isVerify,
          verified_at: isVerify ? new Date().toISOString() : null,
          verified_by: isVerify ? actor.id : null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', officeId)
        .select()
        .single();
      if (vErr) throw vErr;
      return jsonResponse(200, { ok: true, office: updatedOffice });
    }

    if (body?.action === 'assign_staff') {
      const parsed = assignStaffSchema.safeParse(body);
      if (!parsed.success) return jsonResponse(400, { error: 'invalid_request', details: parsed.error.issues });

      const { data: office, error: offErr } = await admin
        .from('offices')
        .select('id, name, active')
        .eq('id', parsed.data.officeId)
        .maybeSingle();
      if (offErr) {
        console.error('Failed to verify office for assignment:', offErr);
        return jsonResponse(503, { error: 'office_lookup_failed', message: 'Failed to verify the target office.' });
      }
      if (!office) {
        return jsonResponse(404, { error: 'office_not_found', message: 'The specified office does not exist' });
      }
      if (!office.active) {
        return jsonResponse(400, { error: 'office_inactive', message: 'Cannot assign staff to an inactive office.' });
      }

      const { data: staff, error: stErr } = await admin
        .from('staff_profiles')
        .select('user_id, role, active, decommissioned_at')
        .eq('user_id', parsed.data.userId)
        .maybeSingle();
      if (stErr) {
        console.error('Failed to verify staff profile for assignment:', stErr);
        return jsonResponse(503, { error: 'staff_lookup_failed', message: 'Failed to verify staff account.' });
      }
      if (!staff) {
        return jsonResponse(404, { error: 'staff_not_found', message: 'The specified staff account does not exist' });
      }
      if ((staff as { decommissioned_at?: string | null }).decommissioned_at) {
        return jsonResponse(409, { error: 'target_decommissioned', message: 'Cannot assign a decommissioned staff account.' });
      }
      if (!staff.active) {
        return jsonResponse(409, { error: 'staff_inactive', message: 'Cannot assign an inactive staff account.' });
      }
      if (staff.role !== 'office_staff') {
        return jsonResponse(400, { error: 'invalid_staff_role', message: 'Only office_staff accounts can be assigned to offices.' });
      }

      const { error: insErr } = await admin.from('office_staff_assignments').upsert({
        user_id: parsed.data.userId,
        office_id: parsed.data.officeId,
        created_by: actor.id,
      }, { onConflict: 'user_id,office_id' });

      if (insErr) {
        console.error('Failed to save office staff assignment:', insErr);
        return jsonResponse(503, { error: 'office_assignment_failed', message: 'Failed to save office staff assignment.' });
      }
      return jsonResponse(200, { ok: true, message: 'Staff assigned to office successfully.' });
    }

    if (body?.action === 'remove_staff') {
      const parsed = removeStaffSchema.safeParse(body);
      if (!parsed.success) return jsonResponse(400, { error: 'invalid_request', details: parsed.error.issues });

      const { error: delErr } = await admin
        .from('office_staff_assignments')
        .delete()
        .eq('user_id', parsed.data.userId)
        .eq('office_id', parsed.data.officeId);

      if (delErr) throw delErr;
      return jsonResponse(200, { ok: true, message: 'Staff removed from office successfully.' });
    }

    const parsed = createOfficeSchema.safeParse(body);
    if (!parsed.success) return jsonResponse(400, { error: 'invalid_request', details: parsed.error.issues });

    const normalizedName = parsed.data.name;
    const normalizedDescription = parsed.data.description && parsed.data.description.length > 0
      ? parsed.data.description
      : null;
    const requestedActive = parsed.data.active ?? true;

    const { data: newOffice, error: createErr } = await admin
      .from('offices')
      .insert({
        name: normalizedName,
        description: normalizedDescription,
        active: requestedActive,
        verified: false,
        created_by: actor.id,
        updated_by: actor.id,
      })
      .select('id, name, description, active, verified, verified_at, verified_by, created_at, updated_at')
      .single();

    if (createErr) {
      const errCode = (createErr as { code?: string }).code;
      const errMessage = String((createErr as { message?: string }).message || '').toLowerCase();
      if (errCode === '23505' || errMessage.includes('offices_name_key') || errMessage.includes('duplicate key')) {
        const { data: existingOffice, error: lookupErr } = await admin
          .from('offices')
          .select('id, name, description, active, verified, verified_at, verified_by, created_at, updated_at')
          .eq('name', normalizedName)
          .maybeSingle();

        if (lookupErr) throw lookupErr;

        if (existingOffice) {
          const sameDescription = (existingOffice.description ?? null) === normalizedDescription;
          const sameActive = existingOffice.active === requestedActive;
          if (sameDescription && sameActive) {
            return jsonResponse(200, {
              ok: true,
              idempotent: true,
              alreadyExists: true,
              office: existingOffice,
              message: `Office "${existingOffice.name}" already exists in the directory.`,
            });
          }

          return jsonResponse(409, {
            error: 'office_already_exists',
            message: `An office named "${existingOffice.name}" already exists.`,
            office: existingOffice,
          });
        }

        return jsonResponse(409, {
          error: 'office_already_exists',
          message: `An office named "${normalizedName}" already exists.`,
        });
      }

      throw createErr;
    }

    return jsonResponse(201, { ok: true, office: newOffice });
  }

  if (request.method === 'PATCH') {
    const body = await request.json().catch(() => null);
    const parsed = patchOfficeSchema.safeParse(body);
    if (!parsed.success) return jsonResponse(400, { error: 'invalid_request', details: parsed.error.issues });

    const { data: existingOffice, error: chkErr } = await admin
      .from('offices')
      .select('id')
      .eq('id', parsed.data.id)
      .maybeSingle();
    if (chkErr) throw chkErr;
    if (!existingOffice) {
      return jsonResponse(404, { error: 'office_not_found', message: 'The specified office does not exist' });
    }

    const updates: Record<string, unknown> = { updated_at: new Date().toISOString(), updated_by: actor.id };
    if (parsed.data.name !== undefined) updates.name = parsed.data.name;
    if (parsed.data.description !== undefined) updates.description = parsed.data.description;
    if (parsed.data.active !== undefined) updates.active = parsed.data.active;
    if (parsed.data.verified !== undefined) {
      if (actor.role !== 'superadmin') {
        return jsonResponse(403, {
          error: 'superadmin_required',
          message: 'Only superadmin can modify office verification status',
        });
      }
      updates.verified = parsed.data.verified;
      updates.verified_at = parsed.data.verified ? new Date().toISOString() : null;
      updates.verified_by = parsed.data.verified ? actor.id : null;
    }

    const { data: updatedOffice, error: updateErr } = await admin
      .from('offices')
      .update(updates)
      .eq('id', parsed.data.id)
      .select()
      .single();

    if (updateErr) {
      const errCode = (updateErr as { code?: string }).code;
      const errMessage = String((updateErr as { message?: string }).message || '').toLowerCase();
      if (errCode === '23505' || errMessage.includes('offices_name_key') || errMessage.includes('duplicate key')) {
        return jsonResponse(409, {
          error: 'office_already_exists',
          message: `An office named "${parsed.data.name ?? 'requested'}" already exists.`,
        });
      }
      throw updateErr;
    }
    return jsonResponse(200, { ok: true, office: updatedOffice });
  }

  return jsonResponse(405, { error: 'method_not_allowed' }, { Allow: 'GET, POST, PATCH' });
  } catch (error) {
    if (error instanceof HttpError) {
      return jsonResponse(error.status, { error: error.code });
    }
    console.error('Unhandled offices error:', error);
    return jsonResponse(500, { error: 'internal_error' });
  }
}

export const fetch = handleRequest;
export default { fetch: handleRequest };
