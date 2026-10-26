import type { PassPresentation } from '@/lib/passPresentation';
import { BrandMark } from './BrandMark';
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
  if (!effectivePass) return null;
  const p = effectivePass;
  return (
    <div className={`flex flex-col items-center ${className}`}>
      {/* Institutional Pass Visual Container */}
      <div
        className="w-full max-w-sm rounded-2xl border-2 border-[var(--color-border)] bg-white p-6 shadow-md transition-shadow hover:shadow-lg print:border-2 print:border-black print:p-4 print:shadow-none"
        style={{
          borderTop: '6px solid #800000', // EARIST institutional maroon
        }}
      >
        {/* Institution Header */}
        <div className="flex flex-col items-center text-center pb-4 border-b border-[var(--color-border)] print:pb-2">
          <div className="flex items-center gap-2 mb-1">
            <BrandMark size="sm" />
            <span className="font-extrabold text-sm tracking-wider text-[#800000] uppercase">
              {p.institutionName}
            </span>
          </div>
          <span className="text-[10px] font-semibold text-[var(--color-text-secondary)] uppercase tracking-tight">
            Official Campus Visitor Pass
          </span>
        </div>

        {/* Visitor Details */}
        <div className="py-4 text-center space-y-1">
          <h3
            className="text-lg font-black tracking-tight text-[var(--color-text-primary)] uppercase"
            data-testid="pass-card-visitor-name"
          >
            {p.visitorName}
          </h3>
          <p
            className="text-xs font-semibold text-[var(--color-text-secondary)]"
            data-testid="pass-card-visit-date"
          >
            Visit Date: <span className="text-[var(--color-text-primary)]">{p.visitDate}</span>
          </p>
          {p.validityWindow && (
            <p className="text-[11px] font-medium text-[#800000]">
              Valid: {p.validityWindow}
            </p>
          )}
        </div>

        {/* Centered QR Container */}
        <div className="my-2 flex justify-center">
          <div className="rounded-xl border border-[var(--color-border)] bg-white p-3 shadow-xs print:border-black print:p-2">
            <img
              src={qrDataUrl}
              alt="Official Visitor Gate Pass QR Code"
              className="h-56 w-56 object-contain print:h-48 print:w-48"
              data-testid="pass-card-qr-image"
            />
          </div>
        </div>

        {/* Pass Reference */}
        <div className="pt-3 text-center border-t border-[var(--color-border)] print:pt-2">
          <p
            className="font-mono text-xs font-bold text-[var(--color-text-primary)] tracking-wider"
            data-testid="pass-card-reference"
          >
            Ref: {p.passReference}
          </p>
          {p.purpose && (
            <p className="text-[11px] text-[var(--color-text-muted)] truncate max-w-[280px] mx-auto mt-0.5">
              Purpose: {p.purpose}
            </p>
          )}
        </div>
      </div>

      {/* Recovery Guidance (Phase 1.3) */}
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
