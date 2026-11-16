import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { BrandMark } from '@/components/BrandMark';
import { Button, Card } from '@/components/ui';
import { AccountMfaCard } from '@/components/auth/AccountMfaCard';
import { PasswordResetCard } from '@/components/ChangePasswordCard';
import { ArrowLeft, UserCircle2 } from 'lucide-react';

export function AccountSecurityPage() {
  const navigate = useNavigate();
  const { role, userData, aal } = useAuth();

  const handleBack = () => {
    if (role === 'office_staff') {
      navigate('/office');
    } else {
      navigate('/admin/settings?tab=personal');
    }
  };

  const email = (userData && 'email' in userData && typeof userData.email === 'string') ? userData.email : 'N/A';
  const name = (userData && 'name' in userData && typeof userData.name === 'string') ? userData.name : 'Staff Member';

  return (
    <div className="min-h-screen bg-[var(--color-canvas)] text-[var(--color-text-primary)]">
      <header className="sticky top-0 z-30 border-b border-[#7A0A0A]/20 bg-white/95 backdrop-blur-md shadow-xs">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-3 sm:px-6">
          <div className="flex items-center gap-3">
            <BrandMark />
            <div className="hidden h-5 w-px bg-gray-200 sm:block" />
            <span className="text-xs font-extrabold uppercase tracking-wider text-[#7A0A0A]">
              Account Security
            </span>
          </div>

          <Button
            variant="secondary"
            size="sm"
            onClick={handleBack}
            icon={<ArrowLeft className="h-3.5 w-3.5" />}
          >
            Back to Dashboard
          </Button>
        </div>
      </header>

      <main id="main-content" className="mx-auto max-w-5xl px-4 py-8 space-y-6 sm:px-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-[var(--color-text-primary)]">
            Account Security Settings
          </h1>
          <p className="mt-1 text-sm text-[var(--color-text-secondary)]">
            Manage your credentials, multi-factor authentication, and session security.
          </p>
        </div>

        {/* Identity & Session Info Card */}
        <Card className="p-6 space-y-4">
          <div className="flex items-center gap-3">
            <UserCircle2 className="h-6 w-6 text-[#7A0A0A]" />
            <h2 className="text-lg font-bold text-[var(--color-text-primary)]">User Profile & Session</h2>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 text-xs">
            <div className="p-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]">
              <span className="text-[var(--color-text-secondary)] block mb-1">Display Name</span>
              <span className="font-semibold text-[var(--color-text-primary)]">{name}</span>
            </div>
            <div className="p-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]">
              <span className="text-[var(--color-text-secondary)] block mb-1">Email Address</span>
              <span className="font-semibold text-[var(--color-text-primary)]">{email}</span>
            </div>
            <div className="p-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]">
              <span className="text-[var(--color-text-secondary)] block mb-1">Assigned Role</span>
              <span className="font-bold text-[#7A0A0A] uppercase">{role ?? 'staff'}</span>
            </div>
            <div className="p-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]">
              <span className="text-[var(--color-text-secondary)] block mb-1">Session Assurance Level</span>
              <span className="font-semibold text-emerald-700 uppercase">{aal ?? 'aal1'}</span>
            </div>
          </div>
        </Card>

        {/* Self-Service MFA Management Card */}
        <AccountMfaCard />

        {/* Password Reset Card */}
        <PasswordResetCard />
      </main>
    </div>
  );
}

export default AccountSecurityPage;
