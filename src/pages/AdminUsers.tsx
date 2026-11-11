import { useState, useEffect, useRef, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Plus, Building2, UserCheck, CheckCircle2, Users, AlertCircle, KeyRound, Copy, Check, Eye, EyeOff, ShieldAlert, RefreshCw } from 'lucide-react';
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
import { getOfficeDirectoryStatusMeta, upsertOfficeInDirectory, type AdminOfficeRecord } from '@/lib/officeDirectory';

const userSchema = z.object({
  name: z.string().min(2, 'Name is required').max(50),
  email: z.string().email('Valid email required'),
  password: passwordSchema,
  role: z.enum(['admin', 'office_staff'], {
    message: 'Staff accounts can be Admin or Office Staff',
  }),
  officeIds: z.array(z.string()).optional(),
});
type UserFormData = z.infer<typeof userSchema>;

function createClientUuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.floor(Math.random() * 16);
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

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
  assignedOfficeIds?: string[];
}

export function AdminUsers() {
  const { uid, role } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const currentTab = searchParams.get('tab') || 'staff';

  // Office Directory & Assignments State
  const [adminOffices, setAdminOffices] = useState<AdminOfficeRecord[]>([]);

  // Office Provisioning & Dedicated Credentials State (Phase F)
  const [provisioningOffice, setProvisioningOffice] = useState<{ id: string; name: string } | null>(null);
  const [provisionCustomEmail, setProvisionCustomEmail] = useState('');
  const [provisionDisplayName, setProvisionDisplayName] = useState('');
  const [provisionOperationId, setProvisionOperationId] = useState('');
  const [provisionError, setProvisionError] = useState<string | null>(null);
  const [isProvisioning, setIsProvisioning] = useState(false);
  const isProvisioningRef = useRef(false);

  const [resendingUserId, setResendingUserId] = useState<string | null>(null);
  const resendingUserRef = useRef<string | null>(null);

  const [resettingOffice, setResettingOffice] = useState<{ id: string; name: string; userId: string; email: string } | null>(null);
  const [isResetting, setIsResetting] = useState(false);

  const [credentialsModalData, setCredentialsModalData] = useState<{
    officeId?: string;
    userId?: string;
    officeName: string;
    email: string;
    temporaryPassword?: string;
    temporaryPasswordIssued?: boolean;
    mustChangePassword: boolean;
    verificationEmailSent?: boolean;
    warning?: string;
    replayed?: boolean;
  } | null>(null);
  const [revealPassword, setRevealPassword] = useState(false);
  const [copiedPassword, setCopiedPassword] = useState(false);
  const [loadingAdminOffices, setLoadingAdminOffices] = useState(false);
  const [officeDirectoryError, setOfficeDirectoryError] = useState<string | null>(null);
  const [officeDirectoryWarning, setOfficeDirectoryWarning] = useState<string | null>(null);
  const [showAddOfficeModal, setShowAddOfficeModal] = useState(false);
  const [newOfficeName, setNewOfficeName] = useState('');
  const [newOfficeDesc, setNewOfficeDesc] = useState('');
  const [createOfficeError, setCreateOfficeError] = useState<string | null>(null);
  const [isCreatingOffice, setIsCreatingOffice] = useState(false);
  const isCreatingOfficeRef = useRef(false);
  const officeDirectoryReadGenRef = useRef(0);

  // Manage Office Assignment Modal
  const [assigningUser, setAssigningUser] = useState<AppUserWithId | null>(null);
  const [selectedOfficeIdsForUser, setSelectedOfficeIdsForUser] = useState<string[]>([]);
  const [isSavingAssignments, setIsSavingAssignments] = useState(false);
  const isSavingAssignmentsRef = useRef(false);

  const loadAdminOffices = useCallback(async (options?: { suppressErrorToast?: boolean }): Promise<{ ok: boolean; error?: string }> => {
    const currentGen = ++officeDirectoryReadGenRef.current;
    setLoadingAdminOffices(true);
    setOfficeDirectoryError(null);
    try {
      const token = await getAccessToken();
      const res = await fetch('/api/admin/offices', {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      const data = await res.json().catch(() => null) as { offices?: AdminOfficeRecord[]; message?: string; error?: string } | null;
      if (currentGen !== officeDirectoryReadGenRef.current) {
        return { ok: true };
      }
      if (!res.ok) {
        const message = data?.message || data?.error || `Failed to load campus office directory (HTTP ${res.status}).`;
        setOfficeDirectoryError(message);
        if (!options?.suppressErrorToast) {
          toast.error(message);
        }
        return { ok: false, error: message };
      }
      setAdminOffices(Array.isArray(data?.offices) ? data.offices : []);
      setOfficeDirectoryError(null);
      setOfficeDirectoryWarning(null);
      return { ok: true };
    } catch (err: any) {
      if (currentGen !== officeDirectoryReadGenRef.current) {
        return { ok: true };
      }
      console.error('Failed to load admin offices:', err);
      const message = err?.message || 'Unable to load campus office directory.';
      setOfficeDirectoryError(message);
      if (!options?.suppressErrorToast) {
        toast.error(message);
      }
      return { ok: false, error: message };
    } finally {
      if (currentGen === officeDirectoryReadGenRef.current) {
        setLoadingAdminOffices(false);
      }
    }
  }, []);

  useEffect(() => {
    if (currentTab === 'directory' || currentTab === 'assignments') {
      void loadAdminOffices();
    }
  }, [currentTab, loadAdminOffices]);

  function openProvisionModal(office: { id: string; name: string }) {
    setProvisioningOffice(office);
    setProvisionDisplayName(`${office.name} Staff`);
    setProvisionCustomEmail('');
    setProvisionError(null);
    setProvisionOperationId(createClientUuid());
  }

  async function handleProvisionDedicatedAccount() {
    if (!provisioningOffice || isProvisioningRef.current || isProvisioning) return;
    const trimmedEmail = provisionCustomEmail.trim();
    if (!trimmedEmail) {
      const msg = 'Reachable staff email address is required.';
      setProvisionError(msg);
      toast.error(msg);
      return;
    }

    const opId = provisionOperationId || createClientUuid();
    if (!provisionOperationId) {
      setProvisionOperationId(opId);
    }

    isProvisioningRef.current = true;
    setIsProvisioning(true);
    setProvisionError(null);

    try {
      const token = await getAccessToken();
      const res = await fetch('/api/admin/offices', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          action: 'provision_account',
          officeId: provisioningOffice.id,
          staffEmail: trimmedEmail,
          displayName: provisionDisplayName.trim() || undefined,
          operationId: opId,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.message || data.error || `Failed to provision office account (HTTP ${res.status})`);
      }

      const targetOffice = provisioningOffice;
      const temporaryPasswordIssued = data.temporaryPasswordIssued !== undefined
        ? Boolean(data.temporaryPasswordIssued)
        : Boolean(data.temporaryPassword);
      const verificationEmailSent = data.verificationEmailSent !== false;
      const warningMsg = data.warning || (!verificationEmailSent
        ? 'Office account created, but verification email could not be delivered. Retry verification email below or from the directory.'
        : undefined);
      const resolvedEmail = data.email || trimmedEmail;

      setCredentialsModalData({
        officeId: targetOffice.id,
        userId: data.userId,
        officeName: targetOffice.name,
        email: resolvedEmail,
        temporaryPassword: data.temporaryPassword,
        temporaryPasswordIssued,
        mustChangePassword: data.mustChangePassword ?? true,
        verificationEmailSent,
        warning: warningMsg,
        replayed: Boolean(data.replayed),
      });

      setProvisioningOffice(null);
      setProvisionCustomEmail('');
      setProvisionDisplayName('');
      setProvisionError(null);
      setProvisionOperationId('');

      setAdminOffices((prev) => {
        const existingOffice = prev.find((o) => o.id === targetOffice.id);
        const summary = data.staffAccountSummary || (data.userId
          ? {
              userId: data.userId,
              displayName: provisionDisplayName.trim() || `${targetOffice.name} Staff`,
              role: 'office_staff',
              active: true,
              mustChangePassword: true,
              email: resolvedEmail,
              emailConfirmed: Boolean(data.emailConfirmed),
            }
          : (existingOffice?.dedicatedAccount ?? null));
        const priorAssigned = existingOffice?.assignedStaff || [];
        const nextAssigned = summary && !priorAssigned.some((item) => item.userId === summary.userId)
          ? [...priorAssigned, summary]
          : priorAssigned;
        return upsertOfficeInDirectory(prev, {
          id: targetOffice.id,
          name: existingOffice?.name ?? targetOffice.name,
          assignedStaff: nextAssigned,
          dedicatedAccount: summary || null,
        });
      });

      if (!verificationEmailSent) {
        toast.warning(warningMsg || 'Office account provisioned, but verification email failed.');
      } else if (data.replayed) {
        toast.info('This provisioning operation was already completed earlier.');
      } else {
        toast.success('Dedicated office account provisioned successfully.');
      }

      const refreshRes = await loadAdminOffices({ suppressErrorToast: true });
      if (!refreshRes.ok) {
        const refreshWarning = `Dedicated office account was provisioned cleanly, but refreshing the office directory failed (${refreshRes.error || 'unknown error'}). Showing updated local state until refresh succeeds.`;
        setOfficeDirectoryWarning(refreshWarning);
        setOfficeDirectoryError(null);
        toast.warning(refreshWarning);
      }
    } catch (err: any) {
      const msg = err?.message || 'Failed to provision office account';
      setProvisionError(msg);
      toast.error(msg);
    } finally {
      isProvisioningRef.current = false;
      setIsProvisioning(false);
    }
  }

  async function handleConfirmResetCredentials() {
    if (!resettingOffice || isResetting) return;
    setIsResetting(true);
    try {
      const token = await getAccessToken();
      const res = await fetch('/api/admin/offices', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          action: 'reset_account_credentials',
          userId: resettingOffice.userId,
          officeId: resettingOffice.id,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || data.error || 'Failed to reset credentials');

      setCredentialsModalData({
        officeName: resettingOffice.name,
        email: resettingOffice.email,
        temporaryPassword: data.temporaryPassword,
        mustChangePassword: true,
      });
      setResettingOffice(null);
      toast.success('Office credentials reset. Displaying new temporary password.');
      await loadAdminOffices();
    } catch (err: any) {
      toast.error(err.message || 'Failed to reset credentials');
    } finally {
      setIsResetting(false);
    }
  }

  async function handleResendVerification(userId: string, officeId: string) {
    if (resendingUserRef.current) return;
    resendingUserRef.current = userId;
    setResendingUserId(userId);
    try {
      const token = await getAccessToken();
      const res = await fetch('/api/admin/offices', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          action: 'resend_verification_email',
          userId,
          officeId,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || data.error || 'Failed to resend verification email');
      setCredentialsModalData((prev) =>
        prev && prev.userId === userId
          ? { ...prev, verificationEmailSent: true, warning: undefined }
          : prev
      );
      toast.success('Verification email resent successfully.');
    } catch (err: any) {
      toast.error(err.message || 'Failed to resend verification email');
    } finally {
      resendingUserRef.current = null;
      setResendingUserId(null);
    }
  }

  async function handleToggleOfficeAccountActive(userId: string, active: boolean) {
    try {
      const token = await getAccessToken();
      const res = await fetch('/api/admin/offices', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          action: 'toggle_account_active',
          userId,
          active,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || data.error || 'Failed to update account status');
      toast.success(active ? 'Office account reactivated.' : 'Office account deactivated.');
      await loadAdminOffices();
    } catch (err: any) {
      toast.error(err.message || 'Failed to update account status');
    }
  }

  function handleCopyPassword(text: string) {
    navigator.clipboard.writeText(text);
    setCopiedPassword(true);
    toast.success('Temporary password copied to clipboard.');
    setTimeout(() => setCopiedPassword(false), 2500);
  }

  async function handleVerifyOffice(officeId: string, verify: boolean) {
    try {
      const token = await getAccessToken();
      const res = await fetch('/api/admin/offices', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          action: verify ? 'verify_office' : 'unverify_office',
          officeId,
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.message || data?.error || 'Failed to update office verification');
      if (data?.office) {
        setAdminOffices((prev) => upsertOfficeInDirectory(prev, data.office));
      }
      const refreshResult = await loadAdminOffices({ suppressErrorToast: true });
      if (!refreshResult.ok && data?.office) {
        setAdminOffices((prev) => upsertOfficeInDirectory(prev, data.office));
        const warningMsg = `Office "${data.office.name}" verification was updated, but refreshing the directory failed (${refreshResult.error}).`;
        setOfficeDirectoryWarning(warningMsg);
        toast.warning(warningMsg);
        return;
      }
      toast.success(verify ? 'Office verified successfully.' : 'Office unverified.');
    } catch (err: any) {
      toast.error(err.message || 'Failed to update office verification');
    }
  }

  async function handleToggleOfficeActive(officeId: string, active: boolean) {
    try {
      const token = await getAccessToken();
      const res = await fetch('/api/admin/offices', {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          id: officeId,
          active,
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.message || data?.error || 'Failed to update office status');
      if (data?.office) {
        setAdminOffices((prev) => upsertOfficeInDirectory(prev, data.office));
      }
      const refreshResult = await loadAdminOffices({ suppressErrorToast: true });
      if (!refreshResult.ok && data?.office) {
        setAdminOffices((prev) => upsertOfficeInDirectory(prev, data.office));
        const warningMsg = `Office "${data.office.name}" status was updated, but refreshing the directory failed (${refreshResult.error}).`;
        setOfficeDirectoryWarning(warningMsg);
        toast.warning(warningMsg);
        return;
      }
      toast.success(active ? 'Office activated successfully.' : 'Office deactivated.');
    } catch (err: any) {
      toast.error(err.message || 'Failed to update office status');
    }
  }

  async function handleCreateOffice() {
    if (isCreatingOfficeRef.current || isCreatingOffice) return;
    const trimmedName = newOfficeName.trim();
    const trimmedDesc = newOfficeDesc.trim();
    if (trimmedName.length < 2) {
      const msg = 'Office name must be at least 2 characters.';
      setCreateOfficeError(msg);
      toast.error(msg);
      return;
    }
    isCreatingOfficeRef.current = true;
    setIsCreatingOffice(true);
    setCreateOfficeError(null);
    try {
      const token = await getAccessToken();
      const res = await fetch('/api/admin/offices', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          action: 'create_office',
          name: trimmedName,
          description: trimmedDesc || undefined,
        }),
      });
      const data = await res.json().catch(() => null) as {
        ok?: boolean;
        idempotent?: boolean;
        alreadyExists?: boolean;
        office?: AdminOfficeRecord;
        message?: string;
        error?: string;
      } | null;

      if (!res.ok) {
        if (res.status === 409 && data?.office) {
          setAdminOffices((prev) => upsertOfficeInDirectory(prev, data.office!));
        }
        const message = data?.message || data?.error || `Failed to create office (HTTP ${res.status}).`;
        setCreateOfficeError(message);
        toast.error(message);
        return;
      }

      if (!data?.office) {
        const message = 'Office creation response was incomplete. Refresh the directory to verify before retrying.';
        setCreateOfficeError(message);
        toast.error(message);
        return;
      }

      const confirmedOffice = data.office;
      setAdminOffices((prev) => upsertOfficeInDirectory(prev, confirmedOffice));
      setOfficeDirectoryWarning(null);
      setShowAddOfficeModal(false);
      setNewOfficeName('');
      setNewOfficeDesc('');
      setCreateOfficeError(null);

      const refreshResult = await loadAdminOffices({ suppressErrorToast: true });
      if (!refreshResult.ok) {
        setAdminOffices((prev) => upsertOfficeInDirectory(prev, confirmedOffice));
        const warningMsg = `Office "${confirmedOffice.name}" was created, but refreshing the directory failed (${refreshResult.error || 'network error'}). Showing the newly created office.`;
        setOfficeDirectoryWarning(warningMsg);
        toast.warning(warningMsg);
        return;
      }

      toast.success(
        data.idempotent || data.alreadyExists
          ? `Office "${confirmedOffice.name}" was already saved and synced to the directory.`
          : `Office "${confirmedOffice.name}" created. It remains hidden from visitors until verified by a Superadmin.`
      );
    } catch (err: any) {
      const message = err?.message || 'Failed to create office. Your inputs were preserved so you can safely retry.';
      setCreateOfficeError(message);
      toast.error(message);
    } finally {
      isCreatingOfficeRef.current = false;
      setIsCreatingOffice(false);
    }
  }

  async function handleSaveOfficeAssignments() {
    if (!assigningUser || isSavingAssignmentsRef.current || isSavingAssignments) return;
    isSavingAssignmentsRef.current = true;
    setIsSavingAssignments(true);
    try {
      const token = await getAccessToken();
      const res = await fetch('/api/system/update-user', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          targetUid: assigningUser.uid,
          officeIds: selectedOfficeIdsForUser,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || data.error || `Failed to update office assignments (HTTP ${res.status})`);
      toast.success('Office assignments updated successfully.');
      setAssigningUser(null);
      await Promise.all([
        loadUsers(),
        loadAdminOffices({ suppressErrorToast: true }),
      ]);
    } catch (err: any) {
      toast.error(err.message || 'Failed to update office assignments');
    } finally {
      isSavingAssignmentsRef.current = false;
      setIsSavingAssignments(false);
    }
  }

  const canManageAdministrativeRoles = isSuperAdmin(role);
  const canManageOffices = role === 'admin' || role === 'superadmin';
  const canVerifyOffice = isSuperAdmin(role);
  const [users, setUsers] = useState<AppUserWithId[]>([]);
  const [loading, setLoading] = useState(true);
  const [usersLoadError, setUsersLoadError] = useState<string | null>(null);
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
    setUsersLoadError(null);
    try {
      const response = await fetch('/api/admin/users?limit=50', {
        headers: { Authorization: `Bearer ${await getAccessToken()}` },
        signal: controller.signal,
      });
      const body = await response.json().catch(() => null) as { users?: AppUserWithId[]; nextCursor?: string | null; hasMore?: boolean; message?: string; error?: string } | null;
      if (controller.signal.aborted || currentGen !== usersReadGenerationRef.current) return;
      if (!response.ok) throw new Error(body?.message || body?.error || `Failed to load users (HTTP ${response.status})`);
      setUsers(body?.users ?? []);
      setNextCursor(body?.nextCursor ?? null);
      setHasMore(body?.hasMore ?? false);
      setUsersLoadError(null);
    } catch (err: any) {
      if (controller.signal.aborted || currentGen !== usersReadGenerationRef.current) return;
      console.error(err);
      const errMsg = err?.message || 'Failed to load users';
      setUsersLoadError(errMsg);
      toast.error(errMsg);
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
      <div>
        <h1 className="text-2xl font-bold text-[var(--color-text-primary)]">
          Staff & Access Governance
        </h1>
        <p className="text-sm text-[var(--color-text-secondary)]">
          Manage administrative staff accounts, campus office directory, and staff department assignments
        </p>
      </div>

      {/* Sub-Tabs Navigation */}
      <div className="flex border-b border-[var(--color-border)] gap-2 overflow-x-auto pb-px">
        {[
          { id: 'staff', label: 'Staff Accounts', icon: Users },
          { id: 'directory', label: 'Office Directory', icon: Building2 },
          { id: 'assignments', label: 'Office Assignments', icon: UserCheck },
        ].map((tab) => {
          const Icon = tab.icon;
          const isActive = currentTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => {
                const next = new URLSearchParams(searchParams);
                next.set('tab', tab.id);
                setSearchParams(next);
              }}
              className={`flex items-center gap-2 px-4 py-2.5 text-xs font-bold whitespace-nowrap border-b-2 transition-colors ${
                isActive
                  ? 'border-[#7A0A0A] text-[#7A0A0A]'
                  : 'border-transparent text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'
              }`}
            >
              <Icon className="h-4 w-4" />
              <span>{tab.label}</span>
            </button>
          );
        })}
      </div>

      {currentTab === 'staff' && (
        <div className="space-y-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-lg font-bold text-[var(--color-text-primary)]">
                Staff Accounts
              </h2>
              <p className="text-xs text-[var(--color-text-secondary)]">
                Manage Guard accounts{canManageAdministrativeRoles ? ' and administrative roles' : ''}
              </p>
            </div>
            {canManageAdministrativeRoles && (
              <Button onClick={() => setIsCreating(true)} icon={<Plus className="h-4 w-4" />}>
                Add User
              </Button>
            )}
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
            Guard station terminals for gate monitoring are managed under the <strong>Devices</strong> tab. Guard personnel access the monitoring feed using Guard Station terminals.
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
              <option value="office_staff">Office Staff</option>
            </Select>
          </FormField>

          <Button type="submit" disabled={isSubmitting} className="w-full" loading={isSubmitting}>
            {isSubmitting ? 'Creating...' : 'Create Account'}
          </Button>
        </form>
      </Modal>

      {usersLoadError && (
        <div role="alert" className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between rounded-lg border border-[var(--color-danger-border)] bg-[var(--color-danger-light)] px-4 py-3 text-xs text-[var(--color-danger-dark)]">
          <div className="flex items-center gap-2">
            <AlertCircle className="h-4 w-4 flex-shrink-0 text-[var(--color-danger)]" />
            <span>{usersLoadError}</span>
          </div>
          <Button size="sm" variant="secondary" onClick={() => void loadUsers()} icon={<RefreshCw className="h-3.5 w-3.5" />}>
            Retry
          </Button>
        </div>
      )}

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
        </div>
      )}

      {currentTab === 'directory' && (
        <div className="space-y-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-lg font-bold text-[var(--color-text-primary)]">
                Campus Office Directory
              </h2>
              <p className="text-xs text-[var(--color-text-secondary)]">
                Superadmin-governed institutional offices and departments. New offices start Active / Unverified and cannot be selected by visitors until verified by a Superadmin.
              </p>
            </div>
            {canManageOffices && (
              <Button
                onClick={() => {
                  setCreateOfficeError(null);
                  setShowAddOfficeModal(true);
                }}
                icon={<Plus className="h-4 w-4" />}
              >
                Add Office
              </Button>
            )}
          </div>

          {officeDirectoryWarning && (
            <div role="status" className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-xs text-amber-900">
              <div className="flex items-center gap-2">
                <AlertCircle className="h-4 w-4 flex-shrink-0 text-amber-700" />
                <span>{officeDirectoryWarning}</span>
              </div>
              <Button size="sm" variant="secondary" onClick={() => void loadAdminOffices()} icon={<RefreshCw className="h-3.5 w-3.5" />}>
                Retry Refresh
              </Button>
            </div>
          )}

          {officeDirectoryError && !officeDirectoryWarning && (
            <div role="alert" className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between rounded-lg border border-[var(--color-danger-border)] bg-[var(--color-danger-light)] px-4 py-3 text-xs text-[var(--color-danger-dark)]">
              <div className="flex items-center gap-2">
                <AlertCircle className="h-4 w-4 flex-shrink-0 text-[var(--color-danger)]" />
                <span>{officeDirectoryError}</span>
              </div>
              <Button size="sm" variant="secondary" onClick={() => void loadAdminOffices()} icon={<RefreshCw className="h-3.5 w-3.5" />}>
                Retry
              </Button>
            </div>
          )}

          {loadingAdminOffices ? (
            <div className="flex h-32 items-center justify-center">
              <div className="h-8 w-8 animate-spin rounded-full border-4 border-[var(--color-border)] border-t-[var(--color-brand)]" role="status" aria-label="Loading offices" />
            </div>
          ) : (
            <DataTable>
              <DataTableHead>
                <DataTableRow>
                  <DataTableCell isHeader>Office Name</DataTableCell>
                  <DataTableCell isHeader>Description</DataTableCell>
                  <DataTableCell isHeader>Status</DataTableCell>
                  <DataTableCell isHeader>Verification</DataTableCell>
                  <DataTableCell isHeader>Dedicated Account</DataTableCell>
                  <DataTableCell isHeader className="text-right">Actions</DataTableCell>
                </DataTableRow>
              </DataTableHead>
              <tbody>
                {adminOffices.map((office) => {
                  const statusMeta = getOfficeDirectoryStatusMeta(office);
                  return (
                  <DataTableRow key={office.id}>
                    <DataTableCell className="font-semibold">{office.name}</DataTableCell>
                    <DataTableCell className="text-xs text-[var(--color-text-secondary)] max-w-xs truncate">
                      {office.description || '—'}
                    </DataTableCell>
                    <DataTableCell>
                      <StatusBadge
                        status={office.active ? 'active' : 'inactive'}
                        label={office.active ? 'Active' : 'Inactive'}
                      />
                    </DataTableCell>
                    <DataTableCell>
                      <div className="space-y-1">
                        {office.verified ? (
                          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700 border border-emerald-200">
                            <CheckCircle2 className="h-3 w-3" /> {statusMeta.combinedLabel}
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700 border border-amber-200">
                            {statusMeta.combinedLabel}
                          </span>
                        )}
                        <p className="text-[11px] text-[var(--color-text-muted)]">
                          {statusMeta.visitorHint}
                        </p>
                      </div>
                    </DataTableCell>
                    <DataTableCell>
                      {office.dedicatedAccount ? (
                        <div className="space-y-1">
                          <div className="font-mono text-xs font-semibold text-[var(--color-text-primary)]">
                            {office.dedicatedAccount.email || 'office.account@earist.edu.ph'}
                          </div>
                          <div className="flex items-center gap-1.5">
                            <span className={`inline-block h-2 w-2 rounded-full ${office.dedicatedAccount.active ? 'bg-emerald-500' : 'bg-gray-400'}`} />
                            <span className="text-[11px] font-medium text-[var(--color-text-secondary)]">
                              {office.dedicatedAccount.active ? 'Active' : 'Deactivated'}
                            </span>
                            {office.dedicatedAccount.mustChangePassword && (
                              <span className="rounded bg-amber-50 text-amber-800 border border-amber-200 px-1 py-0.2 text-[9px] font-bold">
                                1st login pending
                              </span>
                            )}
                            {office.dedicatedAccount.emailConfirmed === false && (
                              <span className="rounded bg-rose-50 text-rose-800 border border-rose-200 px-1 py-0.2 text-[9px] font-bold">
                                Email unverified
                              </span>
                            )}
                          </div>
                        </div>
                      ) : (
                        <span className="text-xs text-[var(--color-text-muted)] italic">
                          No account provisioned
                        </span>
                      )}
                    </DataTableCell>
                    <DataTableCell className="text-right">
                      {canManageOffices && (
                        <div className="inline-flex flex-wrap items-center gap-1.5 justify-end">
                          {!office.dedicatedAccount ? (
                            <Button
                              size="sm"
                              variant="secondary"
                              onClick={() => openProvisionModal({ id: office.id, name: office.name })}
                              icon={<KeyRound className="h-3.5 w-3.5 text-[#7A0A0A]" />}
                            >
                              Provision Account
                            </Button>
                          ) : (
                            <>
                              {office.dedicatedAccount.emailConfirmed === false && (
                                <Button
                                  size="sm"
                                  variant="secondary"
                                  loading={resendingUserId === office.dedicatedAccount.userId}
                                  disabled={resendingUserId !== null}
                                  onClick={() => handleResendVerification(office.dedicatedAccount!.userId, office.id)}
                                  title="Resend verification email to staff"
                                >
                                  Resend Verification
                                </Button>
                              )}
                              <Button
                                size="sm"
                                variant="secondary"
                                onClick={() => setResettingOffice({
                                  id: office.id,
                                  name: office.name,
                                  userId: office.dedicatedAccount!.userId,
                                  email: office.dedicatedAccount!.email || `${office.name} Account`,
                                })}
                                title="Reset account credentials"
                              >
                                Reset Password
                              </Button>
                              <Button
                                size="sm"
                                variant="secondary"
                                onClick={() => handleToggleOfficeAccountActive(
                                  office.dedicatedAccount!.userId,
                                  !office.dedicatedAccount!.active
                                )}
                              >
                                {office.dedicatedAccount.active ? 'Deactivate' : 'Reactivate'}
                              </Button>
                            </>
                          )}
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => handleToggleOfficeActive(office.id, !office.active)}
                          >
                            {office.active ? 'Disable Office' : 'Enable Office'}
                          </Button>
                          {canVerifyOffice ? (
                            office.verified ? (
                              <Button
                                variant="secondary"
                                size="sm"
                                onClick={() => handleVerifyOffice(office.id, false)}
                              >
                                Unverify
                              </Button>
                            ) : (
                              <Button
                                size="sm"
                                onClick={() => handleVerifyOffice(office.id, true)}
                              >
                                Verify
                              </Button>
                            )
                          ) : !office.verified ? (
                            <span className="text-[11px] text-[var(--color-text-muted)] px-1">
                              Superadmin verification required
                            </span>
                          ) : null}
                        </div>
                      )}
                    </DataTableCell>
                  </DataTableRow>
                  );
                })}
                {adminOffices.length === 0 && (
                  <tr>
                    <td colSpan={6} className="py-8 text-center text-[var(--color-text-muted)]">
                      {officeDirectoryError ? 'Unable to load offices.' : 'No offices recorded.'}
                    </td>
                  </tr>
                )}
              </tbody>
            </DataTable>
          )}
        </div>
      )}

      {currentTab === 'assignments' && (
        <div className="space-y-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-lg font-bold text-[var(--color-text-primary)]">
                Office Staff Department Assignments
              </h2>
              <p className="text-xs text-[var(--color-text-secondary)]">
                Assign authorized offices to staff accounts so they can review and approve visitor pass requests for their department.
              </p>
            </div>
          </div>

          {(usersLoadError || officeDirectoryError) && (
            <div role="alert" className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between rounded-lg border border-[var(--color-danger-border)] bg-[var(--color-danger-light)] px-4 py-3 text-xs text-[var(--color-danger-dark)]">
              <div className="flex items-center gap-2">
                <AlertCircle className="h-4 w-4 flex-shrink-0 text-[var(--color-danger)]" />
                <span>{officeDirectoryError || usersLoadError}</span>
              </div>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  void loadUsers();
                  void loadAdminOffices();
                }}
                icon={<RefreshCw className="h-3.5 w-3.5" />}
              >
                Retry
              </Button>
            </div>
          )}

          {(loading || loadingAdminOffices) ? (
            <div className="flex h-32 items-center justify-center">
              <div className="h-8 w-8 animate-spin rounded-full border-4 border-[var(--color-border)] border-t-[var(--color-brand)]" role="status" aria-label="Loading office assignments" />
            </div>
          ) : (
          <DataTable>
            <DataTableHead>
              <DataTableRow>
                <DataTableCell isHeader>Staff Name</DataTableCell>
                <DataTableCell isHeader>Email</DataTableCell>
                <DataTableCell isHeader>Status</DataTableCell>
                <DataTableCell isHeader>Assigned Department(s)</DataTableCell>
                <DataTableCell isHeader className="text-right">Actions</DataTableCell>
              </DataTableRow>
            </DataTableHead>
            <tbody>
              {users.filter((u) => u.role === 'office_staff').map((user) => {
                const assignedNames = (user.assignedOfficeIds || [])
                  .map((id) => adminOffices.find((o) => o.id === id)?.name)
                  .filter(Boolean);

                return (
                  <DataTableRow key={user.uid}>
                    <DataTableCell className="font-semibold">{user.name}</DataTableCell>
                    <DataTableCell className="text-xs text-[var(--color-text-secondary)]">{user.email}</DataTableCell>
                    <DataTableCell>
                      <StatusBadge
                        status={user.active ? 'active' : 'inactive'}
                        label={user.active ? 'Active' : 'Inactive'}
                      />
                    </DataTableCell>
                    <DataTableCell>
                      {assignedNames.length > 0 ? (
                        <div className="flex flex-wrap gap-1">
                          {assignedNames.map((name, idx) => (
                            <span key={idx} className="rounded bg-[var(--color-brand-light)] text-[var(--color-brand)] px-2 py-0.5 text-xs font-medium">
                              {name}
                            </span>
                          ))}
                        </div>
                      ) : (
                        <span className="inline-flex items-center gap-1 rounded-full bg-red-50 px-2 py-0.5 text-xs font-medium text-red-700 border border-red-200">
                          <AlertCircle className="h-3 w-3" /> No Office Assigned
                        </span>
                      )}
                    </DataTableCell>
                    <DataTableCell className="text-right">
                      {canManageAdministrativeRoles && (
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => {
                            setAssigningUser(user);
                            setSelectedOfficeIdsForUser(user.assignedOfficeIds || []);
                          }}
                        >
                          Manage Assignments
                        </Button>
                      )}
                    </DataTableCell>
                  </DataTableRow>
                );
              })}
              {users.filter((u) => u.role === 'office_staff').length === 0 && (
                <tr>
                  <td colSpan={5} className="py-8 text-center text-[var(--color-text-muted)]">
                    {usersLoadError || officeDirectoryError
                      ? 'Could not load office staff assignments.'
                      : 'No Office Staff accounts found. Create an Office Staff user first under Staff Accounts.'}
                  </td>
                </tr>
              )}
            </tbody>
          </DataTable>
          )}
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

      <Modal
        isOpen={showAddOfficeModal}
        onClose={() => {
          if (!isCreatingOffice) setShowAddOfficeModal(false);
        }}
        title="Add Campus Office"
        preventClose={isCreatingOffice}
        size="sm"
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void handleCreateOffice();
          }}
          className="space-y-4"
        >
          {createOfficeError && (
            <div role="alert" className="rounded-lg border border-[var(--color-danger-border)] bg-[var(--color-danger-light)] p-3 text-xs text-[var(--color-danger-dark)]">
              {createOfficeError}
            </div>
          )}
          <FormField label="Office Name" id="new-office-name" requirement="required">
            <Input
              id="new-office-name"
              type="text"
              value={newOfficeName}
              onChange={(e) => setNewOfficeName(e.target.value)}
              placeholder="e.g. Office of the University Registrar"
              required
            />
          </FormField>
          <FormField label="Description" id="new-office-desc">
            <Input
              id="new-office-desc"
              type="text"
              value={newOfficeDesc}
              onChange={(e) => setNewOfficeDesc(e.target.value)}
              placeholder="Optional department description"
            />
          </FormField>
          <p className="text-[11px] text-[var(--color-text-muted)] leading-relaxed">
            New offices are created as <strong>Active / Unverified</strong> and remain hidden from visitors until verified by a Superadmin.
          </p>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="secondary" onClick={() => setShowAddOfficeModal(false)} disabled={isCreatingOffice}>
              Cancel
            </Button>
            <Button type="submit" loading={isCreatingOffice} disabled={isCreatingOffice || !newOfficeName.trim()}>
              Create Office
            </Button>
          </div>
        </form>
      </Modal>

      <Modal
        isOpen={!!assigningUser}
        onClose={() => setAssigningUser(null)}
        title={`Assign Offices — ${assigningUser?.name}`}
        preventClose={isSavingAssignments}
        size="md"
      >
        <div className="space-y-4">
          <p className="text-xs text-[var(--color-text-secondary)]">
            Select the campus office(s) that <strong>{assigningUser?.name}</strong> is authorized to manage and approve visit requests for:
          </p>
          <div className="max-h-60 overflow-y-auto space-y-2 border border-[var(--color-border)] rounded-md p-3">
            {adminOffices.filter((o) => o.active).map((office) => {
              const isChecked = selectedOfficeIdsForUser.includes(office.id);
              return (
                <label key={office.id} className="flex items-center gap-2.5 text-xs cursor-pointer hover:bg-[var(--color-surface-hover)] p-1.5 rounded">
                  <input
                    type="checkbox"
                    checked={isChecked}
                    onChange={(e) => {
                      if (e.target.checked) {
                        setSelectedOfficeIdsForUser((prev) => [...prev, office.id]);
                      } else {
                        setSelectedOfficeIdsForUser((prev) => prev.filter((id) => id !== office.id));
                      }
                    }}
                    className="rounded border-[var(--color-border)] text-[var(--color-brand)] focus:ring-[var(--color-brand)]"
                  />
                  <span className="font-semibold text-[var(--color-text-primary)]">{office.name}</span>
                  {office.verified && (
                    <span className="ml-auto inline-flex items-center gap-0.5 text-[10px] text-emerald-700 bg-emerald-50 px-1.5 py-0.5 rounded border border-emerald-200">
                      Verified
                    </span>
                  )}
                </label>
              );
            })}
            {adminOffices.filter((o) => o.active).length === 0 && (
              <p className="text-xs text-[var(--color-text-muted)] text-center py-4">No active offices available.</p>
            )}
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="secondary" onClick={() => setAssigningUser(null)} disabled={isSavingAssignments}>
              Cancel
            </Button>
            <Button onClick={handleSaveOfficeAssignments} loading={isSavingAssignments} disabled={isSavingAssignments}>
              Save Assignments
            </Button>
          </div>
        </div>
      </Modal>

      {/* Provision Dedicated Office Account Modal */}
      {provisioningOffice && (
        <Modal
          isOpen={true}
          onClose={() => {
            if (!isProvisioning) {
              setProvisioningOffice(null);
              setProvisionError(null);
            }
          }}
          title={`Provision Dedicated Account — ${provisioningOffice.name}`}
          size="md"
        >
          <div className="space-y-4">
            <div className="rounded-xl border border-blue-200 bg-blue-50/60 p-3 text-xs text-blue-900 space-y-1">
              <div className="font-bold flex items-center gap-1.5 text-blue-950">
                <KeyRound className="h-4 w-4 text-blue-700" /> Dedicated Office Staff Account
              </div>
              <p>
                This provisions a dedicated account with the <code className="font-mono bg-blue-100 px-1 rounded">office_staff</code> role, strictly bound to review and approve visit requests for <strong>{provisioningOffice.name}</strong>.
              </p>
              <p>
                A strong temporary password will be automatically generated. The staff member will be required to change their password on first login.
              </p>
            </div>

            {provisionError && (
              <div role="alert" className="flex items-start gap-2 rounded-lg border border-[var(--color-danger-border)] bg-[var(--color-danger-light)] px-3 py-2.5 text-xs text-[var(--color-danger-dark)]">
                <AlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0 text-[var(--color-danger)]" />
                <span>{provisionError}</span>
              </div>
            )}

            <FormField label="Staff Account Display Name" id="provision-display-name">
              <Input
                id="provision-display-name"
                value={provisionDisplayName}
                onChange={(e) => setProvisionDisplayName(e.target.value)}
                placeholder="e.g. Office of the Registrar Staff"
              />
            </FormField>

            <FormField label="Staff Reachable Email Address" id="provision-email" requirement="required">
              <Input
                id="provision-email"
                type="email"
                required
                value={provisionCustomEmail}
                onChange={(e) => {
                  const nextEmail = e.target.value;
                  if (provisionError && nextEmail.trim().toLowerCase() !== provisionCustomEmail.trim().toLowerCase()) {
                    setProvisionOperationId(createClientUuid());
                  }
                  setProvisionError(null);
                  setProvisionCustomEmail(nextEmail);
                }}
                placeholder="e.g. registrar.custodian@earist.edu.ph"
              />
              <p className="mt-1 text-[11px] text-[var(--color-text-secondary)]">
                Enter the official, reachable email address of the designated office custodian. This email will be used as their staff login identifier and for password recovery.
              </p>
            </FormField>

            <div className="flex justify-end gap-2 pt-2">
              <Button
                variant="secondary"
                onClick={() => {
                  setProvisioningOffice(null);
                  setProvisionError(null);
                }}
                disabled={isProvisioning}
              >
                Cancel
              </Button>
              <Button
                onClick={handleProvisionDedicatedAccount}
                loading={isProvisioning}
                disabled={isProvisioning || !provisionCustomEmail.trim()}
                icon={<KeyRound className="h-4 w-4" />}
              >
                Provision Account
              </Button>
            </div>
          </div>
        </Modal>
      )}

      {/* One-Time Secure Credentials Modal */}
      {credentialsModalData && (
        <Modal
          isOpen={true}
          onClose={() => {
            setCredentialsModalData(null);
            setRevealPassword(false);
          }}
          title="Dedicated Office Account Credentials"
          size="md"
        >
          <div className="space-y-4">
            {(credentialsModalData.warning || credentialsModalData.verificationEmailSent === false) && (
              <div role="status" className="rounded-xl border border-amber-400 bg-amber-50 p-3.5 text-xs text-amber-950 space-y-2">
                <div className="font-bold flex items-center gap-1.5 text-amber-900">
                  <AlertCircle className="h-4 w-4 text-amber-700" /> Verification Email Pending
                </div>
                <p>
                  {credentialsModalData.warning || 'The office account was created, but the verification email could not be delivered.'}
                </p>
                {credentialsModalData.userId && credentialsModalData.officeId && (
                  <Button
                    size="sm"
                    variant="secondary"
                    loading={resendingUserId === credentialsModalData.userId}
                    disabled={resendingUserId !== null}
                    onClick={() => void handleResendVerification(credentialsModalData.userId!, credentialsModalData.officeId!)}
                  >
                    Retry Verification Email
                  </Button>
                )}
              </div>
            )}

            {credentialsModalData.temporaryPasswordIssued !== false && credentialsModalData.temporaryPassword ? (
              <div className="rounded-xl border border-amber-300 bg-amber-50 p-3.5 text-xs text-amber-950 space-y-1.5">
                <div className="font-bold flex items-center gap-1.5 text-amber-900">
                  <ShieldAlert className="h-4 w-4 text-amber-700" /> ONE-TIME CREDENTIALS DISPLAY
                </div>
                <p>
                  These credentials will <strong>only be displayed this one time</strong>. Copy them now and securely transmit them to the designated office personnel.
                </p>
                <p className="font-semibold text-amber-900">
                  The account holder will be strictly required to change this temporary password upon first login before accessing office features.
                </p>
              </div>
            ) : (
              <div className="rounded-xl border border-blue-200 bg-blue-50/60 p-3.5 text-xs text-blue-950 space-y-1">
                <div className="font-bold flex items-center gap-1.5 text-blue-900">
                  <ShieldAlert className="h-4 w-4 text-blue-700" /> Provisioning Request Already Completed
                </div>
                <p>
                  Temporary passwords are never replayed after completion. If the custodian needs a new temporary password, use <strong>Reset Credentials</strong> in the Office Directory.
                </p>
              </div>
            )}

            <div className="divide-y divide-[var(--color-border)] rounded-xl border border-[var(--color-border)] bg-[var(--color-canvas)] text-xs">
              <div className="p-3 flex justify-between items-center">
                <span className="text-[var(--color-text-secondary)] font-medium">Assigned Department:</span>
                <span className="font-bold text-[var(--color-text-primary)]">{credentialsModalData.officeName}</span>
              </div>
              <div className="p-3 flex justify-between items-center">
                <span className="text-[var(--color-text-secondary)] font-medium">Login Email:</span>
                <span className="font-mono font-bold text-[var(--color-text-primary)] select-all">{credentialsModalData.email}</span>
              </div>
              {credentialsModalData.temporaryPasswordIssued !== false && credentialsModalData.temporaryPassword && (
                <div className="p-3 space-y-1.5">
                  <div className="flex justify-between items-center">
                    <span className="text-[var(--color-text-secondary)] font-medium">Temporary Password:</span>
                    <button
                      type="button"
                      onClick={() => setRevealPassword(!revealPassword)}
                      className="text-[11px] text-[#7A0A0A] font-semibold flex items-center gap-1 hover:underline"
                    >
                      {revealPassword ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
                      {revealPassword ? 'Hide' : 'Reveal'}
                    </button>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="flex-1 font-mono font-bold text-sm bg-white p-2.5 rounded-lg border border-[var(--color-border)] tracking-wider">
                      {revealPassword ? credentialsModalData.temporaryPassword : '••••••••••••••••'}
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      onClick={() => handleCopyPassword(credentialsModalData.temporaryPassword!)}
                      icon={copiedPassword ? <Check className="h-4 w-4 text-emerald-600" /> : <Copy className="h-4 w-4" />}
                    >
                      {copiedPassword ? 'Copied' : 'Copy'}
                    </Button>
                  </div>
                </div>
              )}
              <div className="p-3 flex justify-between items-center">
                <span className="text-[var(--color-text-secondary)] font-medium">Mandatory Password Change:</span>
                <span className="inline-flex items-center gap-1 text-emerald-700 font-bold bg-emerald-50 px-2 py-0.5 rounded">
                  <CheckCircle2 className="h-3.5 w-3.5" /> Enforced on 1st Login
                </span>
              </div>
            </div>

            <div className="flex justify-end pt-2">
              <Button
                onClick={() => {
                  setCredentialsModalData(null);
                  setRevealPassword(false);
                }}
              >
                Done & Acknowledged
              </Button>
            </div>
          </div>
        </Modal>
      )}

      {/* Reset Credentials Confirmation Modal */}
      <ConfirmModal
        isOpen={!!resettingOffice}
        onClose={() => setResettingOffice(null)}
        title="Reset Office Account Credentials?"
        description={
          resettingOffice ? (
            <>
              This will generate a new temporary password for <strong>{resettingOffice.name}</strong> ({resettingOffice.email}) and enforce mandatory password change on next login. The new password will be displayed once.
            </>
          ) : ''
        }
        confirmText="Reset & Generate Password"
        onConfirm={handleConfirmResetCredentials}
        loading={isResetting}
      />
    </div>
  );
}
