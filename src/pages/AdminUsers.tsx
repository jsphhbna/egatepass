import { useState, useEffect, useRef } from 'react';
import { Plus } from 'lucide-react';
import { Button, FormField, Input, Select, StatusBadge, DataTable, DataTableHead, DataTableRow, DataTableCell, Modal, ConfirmModal } from '@/components/ui';
import { toast } from 'sonner';
import { z } from 'zod';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { UserRole } from '@/types';
import { PASSWORD_MIN_LENGTH, PASSWORD_POLICY_HELPER_TEXT, passwordSchema } from '@/lib/passwordPolicy';
import { useAuth } from '@/hooks/useAuth';
import { formatUserRole, isSuperAdmin } from '@/lib/permissions';
import { getAccessToken } from '@/services/auth';

const userSchema = z.object({
  name: z.string().min(2, 'Name is required').max(50),
  email: z.string().email('Valid email required'),
  password: passwordSchema,
  role: z.literal('admin', {
    message: 'New staff accounts are limited to Admin role',
  }),
});
type UserFormData = z.infer<typeof userSchema>;

interface AppUserWithId {
  uid: string;
  name: string;
  email: string;
  role: UserRole;
  active: boolean;
  privacyAcceptedAt: string | null;
  mustChangePassword?: boolean;
  createdAt: string;
  decommissionedAt?: string | null;
  decommissionedBy?: string | null;
  decommissionReason?: string | null;
}

export function AdminUsers() {
  const { uid, role } = useAuth();
  const canManageAdministrativeRoles = isSuperAdmin(role);
  const [users, setUsers] = useState<AppUserWithId[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'inactive' | 'decommissioned'>('active');
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [deactivatingUser, setDeactivatingUser] = useState<AppUserWithId | null>(null);
  const [isDeactivating, setIsDeactivating] = useState(false);
  const [decommissioningUser, setDecommissioningUser] = useState<AppUserWithId | null>(null);
  const [decommissionPassword, setDecommissionPassword] = useState('');
  const [decommissionReason, setDecommissionReason] = useState('');
  const [isDecommissioning, setIsDecommissioning] = useState(false);
  const [roleChange, setRoleChange] = useState<{ user: AppUserWithId; newRole: UserRole } | null>(null);
  const [isChangingRole, setIsChangingRole] = useState(false);
  const [reactivatingUserId, setReactivatingUserId] = useState<string | null>(null);

  const usersReadGenerationRef = useRef(0);
  const usersAbortControllerRef = useRef<AbortController | null>(null);
  const usersLoadMoreAbortControllerRef = useRef<AbortController | null>(null);
  const usersLoadMoreInFlightRef = useRef(false);

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<UserFormData>({
    resolver: zodResolver(userSchema),
    defaultValues: { role: 'admin' },
  });

  async function loadUsers() {
    const currentGen = ++usersReadGenerationRef.current;
    usersAbortControllerRef.current?.abort();
    const controller = new AbortController();
    usersAbortControllerRef.current = controller;

    // Invalidate load-more ownership and abort in-flight append
    usersLoadMoreAbortControllerRef.current?.abort();
    usersLoadMoreAbortControllerRef.current = null;
    usersLoadMoreInFlightRef.current = false;
    setLoadingMore(false);

    setLoading(true);
    try {
      const response = await fetch('/api/admin/users?limit=50', {
        headers: { Authorization: `Bearer ${await getAccessToken()}` },
        signal: controller.signal,
      });
      const body = await response.json().catch(() => null) as { users?: AppUserWithId[]; nextCursor?: string | null; hasMore?: boolean; error?: string } | null;
      if (controller.signal.aborted || currentGen !== usersReadGenerationRef.current) return;
      if (!response.ok) throw new Error(body?.error || 'Failed to load users');
      setUsers(body?.users ?? []);
      setNextCursor(body?.nextCursor ?? null);
      setHasMore(body?.hasMore ?? false);
    } catch (err: any) {
      if (controller.signal.aborted || currentGen !== usersReadGenerationRef.current) return;
      console.error(err);
      toast.error('Failed to load users');
    } finally {
      if (currentGen === usersReadGenerationRef.current) {
        setLoading(false);
      }
    }
  }

  async function loadMoreUsers() {
    if (!nextCursor || usersLoadMoreInFlightRef.current || loadingMore) return;
    usersLoadMoreInFlightRef.current = true;
    setLoadingMore(true);
    const currentGen = usersReadGenerationRef.current;

    usersLoadMoreAbortControllerRef.current?.abort();
    const loadMoreController = new AbortController();
    usersLoadMoreAbortControllerRef.current = loadMoreController;

    try {
      const response = await fetch(`/api/admin/users?limit=50&cursor=${encodeURIComponent(nextCursor)}`, {
        headers: { Authorization: `Bearer ${await getAccessToken()}` },
        signal: loadMoreController.signal,
      });
      const body = await response.json().catch(() => null) as { users?: AppUserWithId[]; nextCursor?: string | null; hasMore?: boolean; error?: string } | null;
      if (loadMoreController.signal.aborted || currentGen !== usersReadGenerationRef.current) return;
      if (!response.ok) throw new Error(body?.error || 'Failed to load more users');
      setUsers((prev) => [...prev, ...(body?.users ?? [])]);
      setNextCursor(body?.nextCursor ?? null);
      setHasMore(body?.hasMore ?? false);
    } catch (err: any) {
      if (loadMoreController.signal.aborted || currentGen !== usersReadGenerationRef.current) return;
      console.error(err);
      toast.error('Failed to load more users');
    } finally {
      if (currentGen === usersReadGenerationRef.current) {
        usersLoadMoreInFlightRef.current = false;
        setLoadingMore(false);
      }
    }
  }

  useEffect(() => {
    loadUsers();
    return () => {
      usersAbortControllerRef.current?.abort();
      usersLoadMoreAbortControllerRef.current?.abort();
    };
  }, []);

  async function onSubmit(data: UserFormData) {
    if (!canManageAdministrativeRoles) {
      toast.error('Only superadmins may create administrator accounts');
      return;
    }
    try {
      const token = await getAccessToken();

      const response = await fetch('/api/create-user', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(data),
      });
      const result = await response.json().catch(() => null) as { error?: string; verificationEmailSent?: boolean } | null;
      if (!response.ok) {
        if (result?.error === 'existing_auth_identity_unprovisioned') {
          throw new Error(
            'An authentication account already exists for this email but it has not been provisioned as an E-GatePass staff account. Resolve the existing Auth identity through the authorized account-recovery/bootstrap procedure before creating this staff account.'
          );
        }
        if (result?.error === 'email_exists' || result?.error === 'user_already_exists') {
          throw new Error('A staff account with this email address already exists.');
        }
        throw new Error(result?.error || 'Failed to create user');
      }
      if (result?.verificationEmailSent) {
        toast.success(`${data.role} account created. Verification email sent!`);
      } else {
        toast.warning(`${data.role} account created, but failed to send verification email.`);
      }
      setIsCreating(false);
      reset();
      loadUsers();
    } catch (err) {
      console.error(err);
      toast.error(err instanceof Error ? err.message : 'Failed to create user');
    }
  }

  async function updateUserAccount(targetUid: string, update: { role?: UserRole; active?: boolean }) {
    const token = await getAccessToken();

    const response = await fetch('/api/update-user', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ targetUid, ...update }),
    });
    const body = await response.json().catch(() => null) as {
      ok?: boolean;
      result?: 'success' | 'partial';
      profileUpdated?: boolean;
      authSynchronized?: boolean;
      reconciliationRequired?: boolean;
      error?: string;
      message?: string;
    } | null;

    if (
      body?.result === 'partial' &&
      body.profileUpdated === true &&
      body.reconciliationRequired === true
    ) {
      return body;
    }

    if (!response.ok) {
      if (body?.error === 'target_decommissioned') {
        throw new Error('This staff account has been permanently decommissioned and can no longer be modified.');
      }
      if (body?.error === 'cannot_remove_last_superadmin') {
        throw new Error('Cannot demote or deactivate the last remaining Super Admin.');
      }
      throw new Error(body?.error || 'Failed to update user account');
    }
    return body;
  }

  function canManageAccount(user: AppUserWithId): boolean {
    if (user.uid === uid || user.decommissionedAt) return false;
    return canManageAdministrativeRoles || (role === 'admin' && user.role === 'guard');
  }

  async function handleDeactivate(user: AppUserWithId) {
    setIsDeactivating(true);
    try {
      const res = await updateUserAccount(user.uid, { active: false });
      if (res?.result === 'partial' && res.profileUpdated && res.reconciliationRequired) {
        toast.warning(
          res.message || 'Profile updated, but authentication synchronization needs reconciliation. Refreshing authoritative account status.'
        );
      } else {
        toast.success('User deactivated successfully');
      }
      setDeactivatingUser(null);
      loadUsers();
    } catch (err) {
      console.error(err);
      toast.error(err instanceof Error ? err.message : 'Failed to deactivate user');
    } finally {
      setIsDeactivating(false);
    }
  }

  async function handlePermanentDecommission() {
    if (!decommissioningUser) return;
    if (!decommissionPassword) {
      toast.error('Please enter your Super Admin password to confirm.');
      return;
    }
    const cleanReason = decommissionReason.trim();
    if (cleanReason.length < 5 || cleanReason.length > 240) {
      toast.error('Decommission reason must be between 5 and 240 characters.');
      return;
    }

    setIsDecommissioning(true);
    try {
      const token = await getAccessToken();
      const response = await fetch('/api/decommission-user', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          targetUid: decommissioningUser.uid,
          reason: cleanReason,
          password: decommissionPassword,
        }),
      });

      const body = (await response.json().catch(() => null)) as {
        ok?: boolean;
        error?: string;
        message?: string;
        reconciliationRequired?: boolean;
      } | null;

      if (response.status === 503 && body?.reconciliationRequired) {
        toast.warning(
          body.message ||
            'Account decommissioned in database, but Auth suspension requires reconciliation.'
        );
        setDecommissioningUser(null);
        setDecommissionPassword('');
        setDecommissionReason('');
        await loadUsers();
        return;
      }

      if (!response.ok) {
        if (body?.error === 'invalid_superadmin_password') {
          throw new Error('Incorrect Super Admin password. Please check your password and try again.');
        }
        if (body?.error === 'target_user_must_be_inactive') {
          throw new Error('Staff account must be deactivated before it can be decommissioned.');
        }
        if (body?.error === 'cannot_decommission_self') {
          throw new Error('You cannot decommission your own Super Admin account.');
        }
        throw new Error(body?.error || 'Failed to decommission account.');
      }

      toast.success(`Staff account for ${decommissioningUser.name} has been permanently decommissioned.`);
      setDecommissioningUser(null);
      setDecommissionPassword('');
      setDecommissionReason('');
      await loadUsers();
    } catch (err) {
      console.error(err);
      toast.error(err instanceof Error ? err.message : 'Failed to decommission user.');
    } finally {
      setIsDecommissioning(false);
    }
  }

  async function toggleStatus(user: AppUserWithId) {
    if (user.active) {
      setDeactivatingUser(user);
    } else {
      if (reactivatingUserId === user.uid) return;
      setReactivatingUserId(user.uid);
      try {
        const res = await updateUserAccount(user.uid, { active: true });
        if (res?.result === 'partial' && res.profileUpdated && res.reconciliationRequired) {
          toast.warning(
            res.message || 'Profile updated, but authentication synchronization needs reconciliation. Refreshing authoritative account status.'
          );
        } else {
          toast.success('User activated successfully');
        }
        loadUsers();
      } catch (err) {
        console.error(err);
        toast.error(err instanceof Error ? err.message : 'Failed to update user status');
      } finally {
        setReactivatingUserId(null);
      }
    }
  }

  async function handleRoleChange() {
    if (!roleChange) return;
    setIsChangingRole(true);
    try {
      const res = await updateUserAccount(roleChange.user.uid, { role: roleChange.newRole });
      if (res?.result === 'partial' && res.profileUpdated && res.reconciliationRequired) {
        toast.warning(
          res.message || 'Profile updated, but authentication synchronization needs reconciliation. Refreshing authoritative account status.'
        );
      } else {
        toast.success(`${roleChange.user.name} is now ${formatUserRole(roleChange.newRole)}`);
      }
      setRoleChange(null);
      await loadUsers();
    } catch (err) {
      console.error(err);
      toast.error(err instanceof Error ? err.message : 'Failed to change user role');
    } finally {
      setIsChangingRole(false);
    }
  }

  function roleOptionsFor(user: AppUserWithId): UserRole[] {
    // Legacy Guard accounts display their current role but can only be promoted to Admin or Superadmin.
    if (user.role === 'guard') return ['guard', 'admin', 'superadmin'];
    return ['admin', 'superadmin'];
  }

  const filteredUsers = users.filter((user) => {
    if (statusFilter === 'active') return !user.decommissionedAt && user.active;
    if (statusFilter === 'inactive') return !user.decommissionedAt && !user.active;
    if (statusFilter === 'decommissioned') return !!user.decommissionedAt;
    return true; // 'all'
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-[var(--color-text-primary)]">
            User Management
          </h1>
          <p className="text-sm text-[var(--color-text-secondary)]">
            Manage Guard accounts{canManageAdministrativeRoles ? ' and administrative roles' : ''}
          </p>
        </div>
        <Button onClick={() => setIsCreating(true)} icon={<Plus className="h-4 w-4" />}>
          Add User
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-1.5 border-b border-[var(--color-border)] pb-3">
        {(
          [
            { id: 'active', label: 'Active' },
            { id: 'inactive', label: 'Inactive' },
            { id: 'decommissioned', label: 'Decommissioned' },
            { id: 'all', label: 'All' },
          ] as const
        ).map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setStatusFilter(tab.id)}
            className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors ${
              statusFilter === tab.id
                ? 'bg-[var(--color-brand)] text-white shadow-xs'
                : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)]'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <Modal 
        isOpen={isCreating} 
        onClose={() => {
          setIsCreating(false);
          reset();
        }}
        title="Create New Account"
        preventClose={isSubmitting}
        size="sm"
      >
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-5">
          <p className="text-xs text-[var(--color-text-secondary)] font-medium">Fields marked * are required.</p>

          <FormField label="Name" id="new-user-name" requirement="required" error={errors.name?.message}>
            <Input id="new-user-name" type="text" {...register('name')} error={!!errors.name} required aria-required="true" />
          </FormField>

          <FormField label="Email" id="new-user-email" requirement="required" error={errors.email?.message}>
            <Input id="new-user-email" type="email" {...register('email')} error={!!errors.email} required aria-required="true" />
          </FormField>

          <FormField label="Password" id="new-user-password" requirement="required" error={errors.password?.message}>
            <Input id="new-user-password" type="password" minLength={PASSWORD_MIN_LENGTH} autoComplete="new-password" {...register('password')} error={!!errors.password} required aria-required="true" />
            <p className="mt-1 text-xs text-[var(--color-text-muted)]">
              {PASSWORD_POLICY_HELPER_TEXT}
            </p>
          </FormField>

          <div className="rounded-md border border-[var(--color-info)] bg-[var(--color-info-light)] p-3 text-xs text-[var(--color-info-dark)]">
            Guard staff accounts for daily operations are now managed as dedicated <strong>Guard Station</strong> devices under the <strong>Devices</strong> tab. New staff accounts are created as Admin.
          </div>

          <FormField label="Role" id="new-user-role" requirement="required" error={errors.role?.message}>
            <Select
              id="new-user-role"
              {...register('role')} 
              error={!!errors.role}
              required
              aria-required="true"
            >
              <option value="admin">Admin</option>
            </Select>
          </FormField>

          <Button type="submit" disabled={isSubmitting} className="w-full" loading={isSubmitting}>
            {isSubmitting ? 'Creating...' : 'Create Account'}
          </Button>
        </form>
      </Modal>

      {loading ? (
        <div className="flex h-32 items-center justify-center">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-[var(--color-border)] border-t-[var(--color-brand)]" role="status" aria-label="Loading users" />
        </div>
      ) : (
        <DataTable>
          <DataTableHead>
            <DataTableRow>
              <DataTableCell isHeader>Name</DataTableCell>
              <DataTableCell isHeader>Email</DataTableCell>
              <DataTableCell isHeader>Role</DataTableCell>
              <DataTableCell isHeader>Status</DataTableCell>
              <DataTableCell isHeader className="text-right">Actions</DataTableCell>
            </DataTableRow>
          </DataTableHead>
          <tbody>
            {filteredUsers.map((user) => (
              <DataTableRow key={user.uid}>
                <DataTableCell className="font-semibold">{user.name}</DataTableCell>
                <DataTableCell className="text-[var(--color-text-secondary)]">{user.email}</DataTableCell>
                <DataTableCell>
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <StatusBadge 
                      status={user.role}
                      label={formatUserRole(user.role)}
                    />
                    {user.role === 'guard' && (
                      <span className="inline-flex items-center rounded-md bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-800 ring-1 ring-inset ring-amber-600/20">
                        Deprecated
                      </span>
                    )}
                  </div>
                </DataTableCell>
                <DataTableCell>
                  {user.decommissionedAt ? (
                    <div className="flex flex-col gap-0.5 max-w-[220px]">
                      <StatusBadge 
                        status="destructive" 
                        label="Decommissioned" 
                      />
                      <span className="text-[11px] text-[var(--color-text-muted)]">
                        {new Date(user.decommissionedAt).toLocaleDateString('en-US', {
                          month: 'short',
                          day: 'numeric',
                          year: 'numeric',
                        })}
                      </span>
                      {user.decommissionReason && (
                        <span
                          className="text-[11px] text-[var(--color-text-secondary)] break-words line-clamp-2"
                          title={user.decommissionReason}
                        >
                          Reason: {user.decommissionReason}
                        </span>
                      )}
                    </div>
                  ) : (
                    <StatusBadge 
                      status={user.active ? 'active' : 'inactive'}
                      label={user.active ? 'Active' : 'Deactivated'} 
                    />
                  )}
                </DataTableCell>
                <DataTableCell className="text-right">
                  <div className="flex flex-wrap items-center justify-end gap-2">
                    {user.decommissionedAt ? (
                      <span className="text-xs text-[var(--color-text-muted)] italic">Decommissioned</span>
                    ) : (
                      <>
                        {canManageAdministrativeRoles && user.uid !== uid && (
                          <Select
                            value={user.role}
                            onChange={(event) => {
                              const newRole = event.target.value as UserRole;
                              if (newRole !== user.role) setRoleChange({ user, newRole });
                            }}
                            aria-label={`Change role for ${user.name}`}
                            className="min-h-9 w-auto py-1 text-xs"
                          >
                            {roleOptionsFor(user).map((option) => (
                              <option key={option} value={option}>{formatUserRole(option)}</option>
                            ))}
                          </Select>
                        )}
                        {canManageAccount(user) && (
                          <Button
                            variant="ghost"
                            onClick={() => toggleStatus(user)}
                            disabled={reactivatingUserId === user.uid}
                            loading={reactivatingUserId === user.uid}
                            className="text-[var(--color-brand)] hover:bg-[var(--color-brand-light)]"
                          >
                            {user.active ? 'Deactivate' : reactivatingUserId === user.uid ? 'Reactivating…' : 'Activate'}
                          </Button>
                        )}
                        {role === 'superadmin' && !user.active && user.uid !== uid && (
                          <Button
                            variant="destructive"
                            size="sm"
                            onClick={() => {
                              setDecommissioningUser(user);
                              setDecommissionPassword('');
                              setDecommissionReason('');
                            }}
                          >
                            Permanently Decommission
                          </Button>
                        )}
                        {user.uid === uid && (
                          <span className="text-xs font-medium text-[var(--color-text-muted)]">Current account</span>
                        )}
                      </>
                    )}
                  </div>
                </DataTableCell>
              </DataTableRow>
            ))}
            {filteredUsers.length === 0 && (
              <tr>
                <td colSpan={5} className="py-8 text-center text-[var(--color-text-muted)]">
                  No users found.
                </td>
              </tr>
            )}
          </tbody>
        </DataTable>
      )}

      {hasMore && (
        <div className="flex justify-center pt-2">
          <Button
            variant="secondary"
            onClick={loadMoreUsers}
            loading={loadingMore}
            disabled={loadingMore}
          >
            Load More Users
          </Button>
        </div>
      )}

      <ConfirmModal
        isOpen={!!deactivatingUser}
        onClose={() => setDeactivatingUser(null)}
        title="Deactivate User?"
        description={
          <>
            Are you sure you want to deactivate <strong className="text-[var(--color-text-primary)]">{deactivatingUser?.name}</strong>?
            They will lose access immediately. You can reactivate them later.
          </>
        }
        onConfirm={() => {
          if (deactivatingUser) handleDeactivate(deactivatingUser);
        }}
        confirmText="Deactivate"
        isDestructive
        loading={isDeactivating}
      />

      <ConfirmModal
        isOpen={!!roleChange}
        onClose={() => setRoleChange(null)}
        title="Change User Role?"
        description={roleChange ? (
          <>
            Change <strong className="text-[var(--color-text-primary)]">{roleChange.user.name}</strong> from {formatUserRole(roleChange.user.role)} to {formatUserRole(roleChange.newRole)}? This changes their access immediately.
          </>
        ) : ''}
        onConfirm={handleRoleChange}
        confirmText="Change Role"
        loading={isChangingRole}
      />

      <Modal
        isOpen={!!decommissioningUser}
        onClose={() => {
          if (!isDecommissioning) {
            setDecommissioningUser(null);
            setDecommissionPassword('');
            setDecommissionReason('');
          }
        }}
        title="Permanently Decommission Staff Account"
        preventClose={isDecommissioning}
        size="md"
      >
        <div className="space-y-4">
          <div className="rounded-lg border border-[var(--color-danger-border)] bg-[var(--color-danger-light)] p-3 text-xs text-[var(--color-danger)] leading-relaxed">
            <strong>Warning:</strong> This action permanently prevents this staff account from returning to service. Historical security and audit records will be preserved.
          </div>

          {decommissioningUser && (
            <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-subtle)] p-3 text-xs space-y-1">
              <div><span className="font-semibold">Name:</span> {decommissioningUser.name}</div>
              <div><span className="font-semibold">Email:</span> {decommissioningUser.email}</div>
              <div><span className="font-semibold">Role:</span> {formatUserRole(decommissioningUser.role)}</div>
            </div>
          )}

          <p className="text-xs text-[var(--color-text-secondary)] font-medium">Fields marked * are required.</p>

          <FormField
            label="Super Admin Password"
            id="decommission-admin-password"
            requirement="required"
          >
            <Input
              id="decommission-admin-password"
              type="password"
              value={decommissionPassword}
              onChange={(e) => setDecommissionPassword(e.target.value)}
              placeholder="Enter your current password to authorize"
              disabled={isDecommissioning}
              required
              aria-required="true"
              autoComplete="current-password"
            />
          </FormField>

          <FormField
            label="Decommission Reason"
            id="decommission-reason"
            requirement="required"
          >
            <textarea
              id="decommission-reason"
              value={decommissionReason}
              onChange={(e) => setDecommissionReason(e.target.value)}
              placeholder="Provide a reason for permanent decommissioning (5-240 characters)"
              rows={3}
              minLength={5}
              maxLength={240}
              disabled={isDecommissioning}
              required
              aria-required="true"
              className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-xs text-[var(--color-text-primary)] focus:border-[var(--color-brand)] focus:outline-none"
            />
            <div className="flex justify-end text-[11px] text-[var(--color-text-muted)]">
              {decommissionReason.length} / 240
            </div>
          </FormField>

          <div className="flex justify-end gap-2 pt-2">
            <Button
              variant="secondary"
              onClick={() => {
                setDecommissioningUser(null);
                setDecommissionPassword('');
                setDecommissionReason('');
              }}
              disabled={isDecommissioning}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handlePermanentDecommission}
              loading={isDecommissioning}
              disabled={isDecommissioning || !decommissionPassword || decommissionReason.trim().length < 5}
            >
              Permanently Decommission
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
