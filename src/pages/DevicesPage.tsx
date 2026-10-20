import { useState, useEffect } from 'react';
import {
  collection,
  onSnapshot,
  query,
  orderBy,
} from 'firebase/firestore';
import { auth, db } from '@/lib/firebase';
import { useAuth } from '@/hooks/useAuth';
import type { Device, DeviceType } from '@/types';
import { Tablet, Plus, X, Lock, Unlock, Key, AtSign, Trash2, Eye, EyeOff } from 'lucide-react';
import { toast } from 'sonner';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { Button, Card, FormField, Input, Select, StatusBadge, Modal, ConfirmModal } from '@/components/ui';
import { isSuperAdmin } from '@/lib/permissions';
import { getPasswordPolicyError, PASSWORD_MIN_LENGTH } from '@/lib/passwordPolicy';

// ============================================================
// TYPES AND SCHEMA
// ============================================================
interface DeviceWithId extends Device {
  id: string;
}

const deviceSchema = z.object({
  name: z.string().min(2, 'Name is required').max(50),
  type: z.enum({ entry: 'entry', exit: 'exit', kiosk: 'kiosk' }, {
    message: 'Select a device type',
  }),
  gate: z.string().min(1, 'Gate/location is required').max(50),
  email: z.string().email('Username must use an email format, such as maingate-entry@earist-devices.local'),
  password: z.string()
    .min(PASSWORD_MIN_LENGTH, `Password must be at least ${PASSWORD_MIN_LENGTH} characters`)
    .regex(/[A-Za-z]/, 'Password must include at least one letter')
    .regex(/\d/, 'Password must include at least one number'),
});

type DeviceFormData = z.infer<typeof deviceSchema>;

// ============================================================
// COMPONENT
// ============================================================
export function DevicesPage() {
  const { role } = useAuth();
  const canManageCredentials = isSuperAdmin(role);
  const [devices, setDevices] = useState<DeviceWithId[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [creating, setCreating] = useState(false);
  const [revokingDevice, setRevokingDevice] = useState<DeviceWithId | null>(null);
  const [isRevoking, setIsRevoking] = useState(false);
  const [editingDevice, setEditingDevice] = useState<DeviceWithId | null>(null);
  const [editEmail, setEditEmail] = useState('');
  const [editPassword, setEditPassword] = useState('');
  const [showEditPassword, setShowEditPassword] = useState(false);
  const [isUpdatingAuth, setIsUpdatingAuth] = useState(false);
  const [deletingDevice, setDeletingDevice] = useState<DeviceWithId | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<DeviceFormData>({
    resolver: zodResolver(deviceSchema),
  });

  // Live listener on devices collection
  useEffect(() => {
    const q = query(collection(db, 'devices'), orderBy('createdAt', 'desc'));
    const unsub = onSnapshot(q, (snap) => {
      const list: DeviceWithId[] = [];
      snap.forEach((docSnap) => {
        list.push({ id: docSnap.id, ...docSnap.data() } as DeviceWithId);
      });
      setDevices(list);
    });
    return unsub;
  }, []);

  // ============================================================
  // CREATE DEVICE
  // ============================================================
  async function onCreateDevice(data: DeviceFormData) {
    setCreating(true);
    try {
      const token = await auth.currentUser?.getIdToken();
      if (!token) throw new Error('Your session has expired. Please sign in again.');
      const response = await fetch('/api/create-device', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      const result = await response.json().catch(() => null) as { error?: string } | null;
      if (!response.ok) throw new Error(result?.error || 'Failed to register device');

      toast.success(`Device "${data.name}" registered successfully`);
      reset();
      setShowForm(false);
    } catch (err) {
      console.error('Device registration error:', err);
      const message = err instanceof Error ? err.message : 'Failed to register device. Please try again.';
      toast.error(message);
    } finally {
      setCreating(false);
    }
  }

  // ============================================================
  // TOGGLE DEVICE STATUS
  // ============================================================
  async function toggleDeviceStatus(device: DeviceWithId) {
    if (device.status === 'active') {
      setRevokingDevice(device);
    } else {
      // Reactivate instantly
      try {
        await updateDeviceStatus(device.id, 'active');
        toast.success(`Device "${device.name}" reactivated`);
      } catch (err) {
        console.error('Reactivate device error:', err);
        toast.error('Failed to reactivate device.');
      }
    }
  }

  async function handleRevoke(device: DeviceWithId) {
    setIsRevoking(true);
    try {
      await updateDeviceStatus(device.id, 'revoked');
      toast.success(`Device "${device.name}" revoked`);
      setRevokingDevice(null);
    } catch (err) {
      console.error('Revoke device error:', err);
      toast.error('Failed to revoke device.');
    } finally {
      setIsRevoking(false);
    }
  }

  async function handleUpdateCredentials(e: React.FormEvent) {
    e.preventDefault();
    if (!editingDevice) return;

    const normalizedEmail = editEmail.trim();
    const emailChanged = normalizedEmail !== (editingDevice.email || '');
    if (emailChanged && !normalizedEmail) {
      toast.error('Device username cannot be empty.');
      return;
    }
    if (!emailChanged && !editPassword) {
      toast.error('Please enter a new device username or password.');
      return;
    }
    if (editPassword) {
      const passwordError = getPasswordPolicyError(editPassword);
      if (passwordError) {
        toast.error(passwordError);
        return;
      }
    }

    setIsUpdatingAuth(true);
    try {
      const token = await auth.currentUser?.getIdToken();
      if (!token) throw new Error('Not authenticated');

      const res = await fetch('/api/update-device-auth', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          targetUid: editingDevice.id,
          email: emailChanged ? normalizedEmail : undefined,
          password: editPassword || undefined,
        }),
      });

      const result = await res.json().catch(() => null) as { error?: string; reconciliationRequired?: boolean; reference?: string } | null;
      if (!res.ok) {
        throw new Error(result?.error || 'Failed to update credentials');
      }
      if (result?.reconciliationRequired) {
        toast.warning(`Credentials changed, but follow-up is required. Reference: ${result.reference}`);
      } else {
        toast.success('Device credentials updated successfully');
      }
      setEditingDevice(null);
      setEditPassword('');
      setShowEditPassword(false);
    } catch (err) {
      console.error('Update credentials error:', err);
      toast.error(err instanceof Error ? err.message : 'Failed to update credentials');
    } finally {
      setIsUpdatingAuth(false);
    }
  }

  async function handleDeleteDevice(device: DeviceWithId) {
    setIsDeleting(true);
    try {
      const token = await auth.currentUser?.getIdToken();
      if (!token) throw new Error('Not authenticated');

      const res = await fetch('/api/delete-device', {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ targetUid: device.id }),
      });

      const result = await res.json().catch(() => null) as { error?: string; reconciliationRequired?: boolean; reference?: string } | null;
      if (!res.ok) {
        throw new Error(result?.error || 'Failed to delete device');
      }

      if (result?.reconciliationRequired) {
        toast.warning(`Login deleted, but follow-up is required. Reference: ${result.reference}`);
      } else {
        toast.success(`Device "${device.name}" deleted`);
      }
      setDeletingDevice(null);
    } catch (err) {
      console.error('Delete device error:', err);
      toast.error(err instanceof Error ? err.message : 'Failed to delete device');
    } finally {
      setIsDeleting(false);
    }
  }

  async function updateDeviceStatus(targetUid: string, status: 'active' | 'revoked') {
    const token = await auth.currentUser?.getIdToken();
    if (!token) throw new Error('Your session has expired. Please sign in again.');
    const response = await fetch('/api/update-device', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetUid, status }),
    });
    const result = await response.json().catch(() => null) as { error?: string } | null;
    if (!response.ok) throw new Error(result?.error || 'Failed to update device status');
  }



  function typeBadge(type: DeviceType) {
    const map: Record<DeviceType, string> = {
      entry: 'Entry scanner',
      exit: 'Exit scanner',
      kiosk: 'Registration kiosk',
    };
    return map[type];
  }

  const hasCredentialChanges = !!editingDevice && (
    editEmail.trim() !== (editingDevice.email || '') || editPassword.length > 0
  );

  // ============================================================
  // RENDER
  // ============================================================
  return (
    <div>
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-[var(--color-text-primary)]">
            Devices
          </h1>
          <p className="mt-1 text-sm text-[var(--color-text-secondary)]">
            Manage enrolled scanner tablets and kiosk devices
          </p>
        </div>
        <Button
          onClick={() => setShowForm(!showForm)}
          variant={showForm ? 'secondary' : 'primary'}
          icon={showForm ? <X className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
        >
          {showForm ? 'Cancel' : 'Register Device'}
        </Button>
      </div>

      {/* Registration Form */}
      <Modal
        isOpen={showForm}
        onClose={() => {
          setShowForm(false);
          reset();
        }}
        title="Register New Device"
        description="Create the username and password this scanner or kiosk will use to sign in."
        size="sm"
        preventClose={creating}
      >
        <form
          onSubmit={handleSubmit(onCreateDevice)}
          className="grid gap-6 sm:grid-cols-2"
        >
          <div className="sm:col-span-2">
            <FormField label="Device Name" id="device-name" error={errors.name?.message}>
              <Input
                id="device-name"
                {...register('name')}
                placeholder="Main Gate Entry Tablet"
                error={!!errors.name}
              />
            </FormField>
          </div>

          <FormField label="Type" id="device-type" error={errors.type?.message}>
            <Select
              id="device-type"
              {...register('type')}
              error={!!errors.type}
            >
              <option value="">Select type…</option>
              <option value="entry">Entry Scanner</option>
              <option value="exit">Exit Scanner</option>
              <option value="kiosk">Kiosk</option>
            </Select>
          </FormField>

          <FormField label="Gate / Location" id="device-gate" error={errors.gate?.message}>
            <Input
              id="device-gate"
              {...register('gate')}
              placeholder="Main Gate"
              error={!!errors.gate}
            />
          </FormField>

          <div className="sm:col-span-2">
            <FormField
              label="Device Username"
              id="device-username"
              hint="This is not an email inbox. Firebase requires the username to follow an email format."
              error={errors.email?.message}
            >
              <Input
                id="device-username"
                type="email"
                {...register('email')}
                placeholder="maingate-entry@earist-devices.local"
                autoComplete="username"
                error={!!errors.email}
              />
            </FormField>
          </div>

          <div className="sm:col-span-2">
            <FormField label="Device Password" id="device-password" error={errors.password?.message}>
              <Input
                id="device-password"
                type="password"
                {...register('password')}
                placeholder="••••••••"
                error={!!errors.password}
              />
            </FormField>
          </div>

          <div className="sm:col-span-2">
            <Button
              type="submit"
              disabled={creating}
              loading={creating}
              className="w-full"
            >
              {creating ? 'Registering...' : 'Register Device'}
            </Button>
          </div>
        </form>
      </Modal>

      {/* Device List */}
      {devices.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-xl border-2 border-dashed border-[var(--color-border)] py-16">
          <Tablet className="mb-3 h-10 w-10 text-[var(--color-text-muted)]" />
          <p className="text-sm font-medium text-[var(--color-text-secondary)]">
            No devices registered yet
          </p>
          <p className="text-xs text-[var(--color-text-muted)] mt-1">
            Register a scanner tablet or kiosk to get started
          </p>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {devices.map((device) => (
            <Card key={device.id} className="p-5 flex flex-col justify-between">
              <div>
                <div className="mb-4 flex items-start justify-between">
                  <div>
                    <h3 className="text-base font-bold text-[var(--color-text-primary)]">
                      {device.name}
                    </h3>
                    <p className="text-xs font-medium text-[var(--color-text-secondary)] mt-0.5">
                      {device.gate}
                    </p>
                  </div>
                  <StatusBadge status={device.status} label={device.status} />
                </div>

                <div className="mb-6 space-y-3">
                  <p className="inline-flex rounded-full border border-[var(--color-brand)]/20 bg-[var(--color-brand-light)] px-2.5 py-1 text-xs font-semibold text-[var(--color-brand)]">
                    {typeBadge(device.type)}
                  </p>
                  
                  {device.email && (
                    <div className="flex items-center gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-canvas)] p-2 text-sm text-[var(--color-text-secondary)]">
                      <AtSign className="h-4 w-4 shrink-0 text-[var(--color-text-muted)]" aria-hidden="true" />
                      <div className="min-w-0">
                        <span className="block text-xs text-[var(--color-text-muted)]">Device username</span>
                        <span className="block truncate" title={device.email}>{device.email}</span>
                      </div>
                    </div>
                  )}
                </div>
              </div>

              <div className="flex gap-2">
                {canManageCredentials && (
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setEditingDevice(device);
                      setEditEmail(device.email || '');
                      setEditPassword('');
                      setShowEditPassword(false);
                    }}
                    className="flex-1"
                    icon={<Key className="h-4 w-4" />}
                  >
                    Edit
                  </Button>
                )}
                <Button
                  variant={device.status === 'active' ? 'destructive' : 'primary'}
                  onClick={() => toggleDeviceStatus(device)}
                  className={canManageCredentials ? 'flex-[2]' : 'flex-1'}
                  icon={device.status === 'active' ? <Lock className="h-4 w-4" /> : <Unlock className="h-4 w-4" />}
                >
                  {device.status === 'active' ? 'Revoke' : 'Reactivate'}
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}

      <ConfirmModal
        isOpen={!!revokingDevice}
        onClose={() => setRevokingDevice(null)}
        title="Revoke Device?"
        description={
          <>
            Are you sure you want to revoke <strong className="text-[var(--color-text-primary)]">{revokingDevice?.name}</strong>?
            It will immediately lose access to the system. You can reactivate it later.
          </>
        }
        onConfirm={() => {
          if (revokingDevice) handleRevoke(revokingDevice);
        }}
        confirmText="Revoke"
        isDestructive
        loading={isRevoking}
      />

      {/* Edit Credentials Modal */}
      <Modal
        isOpen={canManageCredentials && !!editingDevice}
        onClose={() => {
          setEditingDevice(null);
          setEditEmail('');
          setEditPassword('');
          setShowEditPassword(false);
        }}
        title="Edit Device Login"
        description="Update the username or password used by this device."
        size="sm"
        preventClose={isUpdatingAuth}
      >
        <form onSubmit={handleUpdateCredentials} className="space-y-5">
          <p className="mb-2 text-sm text-[var(--color-text-secondary)]">
            Update login credentials for <strong>{editingDevice?.name}</strong>. The username is not an email inbox, but it must follow an email format because Firebase uses it for sign-in.
          </p>

          <FormField label="Device Username" hint="Example: maingate-entry@earist-devices.local">
            <Input
              type="email"
              value={editEmail}
              onChange={(e) => setEditEmail(e.target.value)}
              placeholder="maingate-entry@earist-devices.local"
              autoComplete="username"
            />
          </FormField>

          <FormField label="New Password">
            <div className="relative">
              <Input
                type={showEditPassword ? 'text' : 'password'}
                value={editPassword}
                onChange={(e) => setEditPassword(e.target.value)}
                placeholder="Leave blank to keep the current password"
                minLength={PASSWORD_MIN_LENGTH}
                maxLength={128}
                autoComplete="new-password"
                className="pr-12"
              />
              <button
                type="button"
                onClick={() => setShowEditPassword((visible) => !visible)}
                className="absolute inset-y-0 right-0 flex w-11 items-center justify-center rounded-r-md text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-brand)]"
                aria-label={showEditPassword ? 'Hide replacement password' : 'Show replacement password'}
              >
                {showEditPassword ? <EyeOff className="h-4 w-4" aria-hidden="true" /> : <Eye className="h-4 w-4" aria-hidden="true" />}
              </button>
            </div>
            <p className="mt-2 text-xs leading-relaxed text-[var(--color-text-muted)]">
              For your security, we cannot show the current password. A replacement must have at least {PASSWORD_MIN_LENGTH} characters, including a letter and a number.
            </p>
          </FormField>

          <div className="flex flex-col gap-3 sm:flex-row">
            <Button
              type="button"
              variant="destructive-outline"
              disabled={isUpdatingAuth}
              onClick={() => {
                if (!editingDevice) return;
                setDeletingDevice(editingDevice);
                setEditingDevice(null);
                setEditPassword('');
                setShowEditPassword(false);
              }}
              icon={<Trash2 className="h-4 w-4" />}
              className="sm:w-auto"
            >
              Delete Device
            </Button>
            <Button
              type="submit"
              disabled={isUpdatingAuth || !hasCredentialChanges}
              loading={isUpdatingAuth}
              className="flex-1"
            >
              {isUpdatingAuth ? 'Updating...' : 'Save Changes'}
            </Button>
          </div>
        </form>
      </Modal>

      <ConfirmModal
        isOpen={canManageCredentials && !!deletingDevice}
        onClose={() => setDeletingDevice(null)}
        title="Permanently Delete Device?"
        description={
          <>
            This permanently deletes <strong className="text-[var(--color-text-primary)]">{deletingDevice?.name}</strong> and its login account. Historical visit and audit records will remain. This action cannot be undone.
          </>
        }
        onConfirm={() => {
          if (deletingDevice) handleDeleteDevice(deletingDevice);
        }}
        confirmText="Delete Permanently"
        isDestructive
        loading={isDeleting}
      />
    </div>
  );
}
