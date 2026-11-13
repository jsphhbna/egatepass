import { Link } from 'react-router-dom';
import { CheckCircle2, ArrowRight } from 'lucide-react';
import { BrandMark } from '@/components/BrandMark';
import { Button, Card } from '@/components/ui';

export function VerifiedSuccessPage() {
  return (
    <div className="min-h-screen bg-[var(--color-canvas)] flex flex-col justify-center py-12 sm:px-6 lg:px-8">
      <div className="sm:mx-auto sm:w-full sm:max-w-md">
        <div className="flex justify-center">
          <BrandMark size="lg" />
        </div>
        <h1 className="mt-4 text-center text-2xl font-bold tracking-tight text-[var(--color-text-primary)]">
          EARIST E-GatePass
        </h1>
        <p className="mt-1 text-center text-xs text-[var(--color-text-secondary)] uppercase tracking-wider">
          Account Verification
        </p>
      </div>

      <div className="mt-8 sm:mx-auto sm:w-full sm:max-w-md px-4 sm:px-0">
        <Card className="p-8 text-center space-y-6 shadow-sm border-[var(--color-border)]">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-emerald-50 border border-emerald-200">
            <CheckCircle2 className="h-10 w-10 text-emerald-600" />
          </div>

          <div className="space-y-2">
            <h2 className="text-xl font-bold text-[var(--color-text-primary)]">
              Email Verified Successfully
            </h2>
            <p className="text-sm text-[var(--color-text-secondary)] leading-relaxed">
              Your email address has been verified. Your institutional account is now active and ready for use.
            </p>
          </div>

          <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-xs text-[var(--color-text-secondary)] text-left space-y-2">
            <p className="font-semibold text-[var(--color-text-primary)]">Next Steps:</p>
            <ul className="list-disc list-inside space-y-1">
              <li>Sign in using your verified email address and temporary or permanent password.</li>
              <li>If this is your first sign-in, you will be prompted to set your personal permanent password.</li>
            </ul>
          </div>

          <Link to="/login" className="block w-full">
            <Button
              variant="primary"
              className="w-full bg-[#7A0A0A] hover:bg-[#600808] text-white font-bold h-11"
              icon={<ArrowRight className="h-4 w-4" />}
            >
              Continue to Login
            </Button>
          </Link>
        </Card>
      </div>
    </div>
  );
}

export default VerifiedSuccessPage;
