import { useMemo } from 'react';
import type { PassPresentation } from '@/lib/passPresentation';
import { generateCanonicalDigitalPassSvg } from '@/lib/digitalPassArtifact';
import { AlertCircle } from 'lucide-react';

export interface InstitutionalPassCardProps {
  presentation?: PassPresentation;
  pass?: PassPresentation;
  qrDataUrl: string;
  className?: string;
  showRecoveryGuidance?: boolean;
}

export function InstitutionalPassCard({
  presentation,
  pass,
  qrDataUrl,
  className = '',
  showRecoveryGuidance = true,
}: InstitutionalPassCardProps) {
  const effectivePass = presentation ?? pass;
  const canonicalSvg = useMemo(() => {
    if (!effectivePass) return '';
    return generateCanonicalDigitalPassSvg(effectivePass, qrDataUrl);
  }, [effectivePass, qrDataUrl]);

  if (!effectivePass) return null;

  return (
    <div className={`flex flex-col items-center ${className}`}>
      {/* Canonical Institutional Pass Visual Container */}
      <div
        className="w-full max-w-sm rounded-2xl overflow-hidden border border-[var(--color-border)] bg-white shadow-md transition-shadow hover:shadow-lg p-2 flex justify-center items-center print:border-none print:shadow-none print:p-0"
      >
        <div
          role="img"
          aria-label={`EARIST E-GatePass for ${effectivePass.visitorName}`}
          className="block h-auto w-full [&>svg]:h-auto [&>svg]:w-full [&>svg]:block"
          dangerouslySetInnerHTML={{ __html: canonicalSvg }}
        />
      </div>

      {/* Recovery Guidance */}
      {showRecoveryGuidance && (
        <div
          className="mt-4 flex w-full max-w-sm items-start gap-2.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-3 text-left text-xs text-[var(--color-text-secondary)] print:hidden"
          role="note"
          aria-label="Pass recovery guidance"
        >
          <AlertCircle className="h-4 w-4 shrink-0 text-[var(--color-brand)] mt-0.5" aria-hidden="true" />
          <div>
            <p className="font-semibold text-[var(--color-text-primary)]">
              Lost access to your QR code?
            </p>
            <p className="mt-0.5 leading-relaxed text-[11px]">
              Present a valid ID to the Guard for recovery. Security personnel can verify your identity and grant entry directly.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
