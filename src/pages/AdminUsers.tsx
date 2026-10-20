import { useState, useEffect } from 'react';
import {
  collection,
  query,
  getDocs,
} from 'firebase/firestore';
import { auth, db } from '@/lib/firebase';
import { FirebaseApp, initializeApp } from 'firebase/app';
import { getAuth, sendEmailVerification, signInWithEmailAndPassword, signOut } from 'firebase/auth';
import { Plus } from 'lucide-react';
import { Button, FormField, Input, Select, StatusBadge, DataTable, DataTableHead, DataTableRow, DataTableCell, Modal, ConfirmModal } from '@/components/ui';
import { toast } from 'sonner';
import { z } from 'zod';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { AppUser } from '@/types';
import { PASSWORD_MIN_LENGTH } from '@/lib/passwordPolicy';
import { useAuth } from '@/hooks/useAuth';
import { formatUserRole, isSuperAdmin } from '@/lib/permissions';

// Use same config as primary app
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

let secondaryApp: FirebaseApp | null = null;
try {
  secondaryApp = initializeApp(firebaseConfig, 'SecondaryAppUserCreation');
} catch (error) {
  console.error('Secondary app init error:', error);
}

const userSchema = z.object({
  name: z.string().min(2, 'Name is required').max(50),
  email: z.string().email('Valid email required'),
  password: z.string()
    .min(PASSWORD_MIN_LENGTH, `Password must be at least ${PASSWORD_MIN_LENGTH} characters`)
    .regex(/[A-Za-z]/, 'Password must include at least one letter')
    .regex(/\d/, 'Password must include at least one number'),
  role: z.enum({ admin: 'admin', guard: 'guard' }, {
    message: 'Select a valid role',
  }),
});
type UserFormData = z.infer<typeof userSchema>;

interface AppUserWithId extends AppUser {
  uid: string;
}

export function AdminUsers() {
  const { uid, role } = useAuth();
  const canManageAdministrativeRoles = isSuperAdmin(role);
  const [users, setUsers] = useState<AppUserWithId[]>([]);
  const [loading, setLoading] = useState(true);
  const [isCreating, setIsCreating] = useState(false);
  const [deactivatingUser, setDeactivatingUser] = useState<AppUserWithId | null>(null);
  const [isDeactivating, setIsDeactivating] = useState(false);
  const [roleChange, setRoleChange] = useState<{ user: AppUserWithId; newRole: AppUser['role'] } | null>(null);
  const [isChangingRole, setIsChangingRole] = useState(false);

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<UserFormData>({
    resolver: zodResolver(userSchema),
    defaultValues: { role: 'guard' },
  });

  async function loadUsers() {
    setLoading(true);
    try {
      const q = query(collection(db, 'users'));
      const snap = await getDocs(q);
      const list: AppUserWithId[] = [];
      snap.forEach((d) => {
        list.push({ uid: d.id, ...d.data() } as AppUserWithId);
      });
      setUsers(list);
    } catch (err) {
      console.error(err);
      toast.error('Failed to load users');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadUsers();
  }, []);

  async function onSubmit(data: UserFormData) {
    if (!canManageAdministrativeRoles && data.role !== 'guard') {
      toast.error('Admins may only create Guard accounts');
      return;
    }
    if (!secondaryApp) {
      toast.error('Secondary app not initialized');
      return;
    }

    try {
      const token = await auth.currentUser?.getIdToken();
      if (!token) throw new Error('Your session has expired. Please sign in again.');

      const response = await fetch('/api/create-user', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(data),
      });
      const result = await response.json().catch(() => null) as { error?: string } | null;
      if (!response.ok) throw new Error(result?.error || 'Failed to create user');

      const secondaryAuth = getAuth(secondaryApp);
      let emailSent = false;
      try {
        const userCredential = await signInWithEmailAndPassword(secondaryAuth, data.email, data.password);
        await sendEmailVerification(userCredential.user);
        emailSent = true;
      } catch (emailErr) {
        console.error('Email verification error:', emailErr);
      } finally {
        await signOut(secondaryAuth).catch(() => undefined);
      }

      if (emailSent) {
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

  async function updateUserAccount(targetUid: string, update: { role?: AppUser['role']; active?: boolean }) {
    const token = await auth.currentUser?.getIdToken();
    if (!token) throw new Error('Your session has expired. Please sign in again.');

    const response = await fetch('/api/update-user', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ targetUid, ...update }),
    });
    const body = await response.json().catch(() => null) as { error?: string } | null;
    if (!response.ok) {
      throw new Error(body?.error || 'Failed to update user account');
    }
  }

  function canManageAccount(user: AppUserWithId): boolean {
    if (user.uid === uid) return false;
    return canManageAdministrativeRoles || (role === 'admin' && user.role === 'guard');
  }

  async function handleDeactivate(user: AppUserWithId) {
    setIsDeactivating(true);
    try {
      await updateUserAccount(user.uid, { active: false });
      toast.success('User deactivated successfully');
      setDeactivatingUser(null);
      loadUsers();
    } catch (err) {
      console.error(err);
      toast.error('Failed to deactivate user');
    } finally {
      setIsDeactivating(false);
    }
  }

  async function toggleStatus(user: AppUserWithId) {
    if (user.active) {
      setDeactivatingUser(user);
    } else {
      // Reactivate instantly
      try {
        await updateUserAccount(user.uid, { active: true });
        toast.success('User activated successfully');
        loadUsers();
      } catch (err) {
        console.error(err);
        toast.error('Failed to update user status');
      }
    }
  }

  async function handleRoleChange() {
    if (!roleChange) return;
    setIsChangingRole(true);
    try {
      await updateUserAccount(roleChange.user.uid, { role: roleChange.newRole });
      toast.success(`${roleChange.user.name} is now ${formatUserRole(roleChange.newRole)}`);
      setRoleChange(null);
      await loadUsers();
    } catch (err) {
      console.error(err);
      toast.error(err instanceof Error ? err.message : 'Failed to change user role');
    } finally {
      setIsChangingRole(false);
    }
  }

  function roleOptionsFor(user: AppUserWithId): AppUser['role'][] {
    if (user.role === 'guard') return ['guard', 'admin'];
    if (user.role === 'admin') return ['guard', 'admin', 'superadmin'];
    return ['admin', 'superadmin'];
  }

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
          <FormField label="Name" id="new-user-name" error={errors.name?.message}>
            <Input id="new-user-name" type="text" {...register('name')} error={!!errors.name} />
          </FormField>

          <FormField label="Email" id="new-user-email" error={errors.email?.message}>
            <Input id="new-user-email" type="email" {...register('email')} error={!!errors.email} />
          </FormField>

          <FormField label="Password" id="new-user-password" error={errors.password?.message}>
            <Input id="new-user-password" type="password" minLength={PASSWORD_MIN_LENGTH} autoComplete="new-password" {...register('password')} error={!!errors.password} />
            <p className="mt-1 text-xs text-[var(--color-text-muted)]">
              At least {PASSWORD_MIN_LENGTH} characters with a letter and a number.
            </p>
          </FormField>

          <FormField label="Role" id="new-user-role" error={errors.role?.message}>
            <Select
              id="new-user-role"
              {...register('role')} 
              error={!!errors.role}
            >
              <option value="guard">Guard</option>
              {canManageAdministrativeRoles && <option value="admin">Admin</option>}
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
            {users.map((user) => (
              <DataTableRow key={user.uid}>
                <DataTableCell className="font-semibold">{user.name}</DataTableCell>
                <DataTableCell className="text-[var(--color-text-secondary)]">{user.email}</DataTableCell>
                <DataTableCell>
                  <StatusBadge 
                    status={user.role}
                    label={formatUserRole(user.role)}
                  />
                </DataTableCell>
                <DataTableCell>
                  <StatusBadge 
                    status={user.active ? 'active' : 'inactive'}
                    label={user.active ? 'Active' : 'Deactivated'} 
                  />
                </DataTableCell>
                <DataTableCell className="text-right">
                  <div className="flex flex-wrap items-center justify-end gap-2">
                    {canManageAdministrativeRoles && user.uid !== uid && (
                      <Select
                        value={user.role}
                        onChange={(event) => {
                          const newRole = event.target.value as AppUser['role'];
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
                    {canManageAccount(user) ? (
                      <Button
                        variant="ghost"
                        onClick={() => toggleStatus(user)}
                        className="text-[var(--color-brand)] hover:bg-[var(--color-brand-light)]"
                      >
                        {user.active ? 'Deactivate' : 'Activate'}
                      </Button>
                    ) : user.uid === uid ? (
                      <span className="text-xs font-medium text-[var(--color-text-muted)]">Current account</span>
                    ) : null}
                  </div>
                </DataTableCell>
              </DataTableRow>
            ))}
            {users.length === 0 && (
              <tr>
                <td colSpan={5} className="py-8 text-center text-[var(--color-text-muted)]">
                  No users found.
                </td>
              </tr>
            )}
          </tbody>
        </DataTable>
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
    </div>
  );
}
