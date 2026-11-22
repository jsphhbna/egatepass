import { ShieldCheck, X } from 'lucide-react';
import { Button } from '@/components/ui';

export interface InstitutionalPrivacyNoticeModalProps {
  isOpen: boolean;
  onClose: () => void;
  photoRetentionDays?: number | null;
  idRetentionDays?: number | null;
  visitorRetentionDays?: number | null;
}

export function InstitutionalPrivacyNoticeModal({
  isOpen,
  onClose,
  photoRetentionDays,
  idRetentionDays,
  visitorRetentionDays,
}: InstitutionalPrivacyNoticeModalProps) {
  if (!isOpen) return null;

  const effectivePhotoRetention = photoRetentionDays ?? 30;
  const effectiveIdRetention = idRetentionDays ?? 30;
  const effectiveVisitorRetention = visitorRetentionDays ?? 90;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-xs animate-in fade-in duration-200"
      role="dialog"
      aria-modal="true"
      aria-labelledby="privacy-notice-title"
    >
      <div className="w-full max-w-lg max-h-[85vh] rounded-2xl bg-white p-6 shadow-2xl border border-[var(--color-border)] flex flex-col space-y-4">
        <div className="flex items-center justify-between border-b border-[var(--color-border)] pb-3">
          <div className="flex items-center gap-2.5">
            <div className="h-9 w-9 rounded-xl bg-[#7A0A0A]/10 text-[#7A0A0A] flex items-center justify-center shrink-0">
              <ShieldCheck className="h-5 w-5" />
            </div>
            <div>
              <h3 id="privacy-notice-title" className="font-bold text-base text-[var(--color-text-primary)]">
                Institutional Data Privacy Notice
              </h3>
              <p className="text-[11px] text-[var(--color-text-secondary)]">
                Eulogio "Amang" Rodriguez Institute of Science and Technology (EARIST)
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] p-1 rounded-lg hover:bg-slate-100 cursor-pointer"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="overflow-y-auto pr-2 space-y-3 text-xs text-[var(--color-text-secondary)] leading-relaxed">
          <p>
            In compliance with <strong>Republic Act No. 10173</strong> (Data Privacy Act of 2012) and its Implementing Rules and Regulations, EARIST is committed to protecting your personal data, privacy, and institutional security.
          </p>

          <div>
            <h4 className="font-bold text-[var(--color-text-primary)] text-xs mb-1">1. Purpose of Data Collection</h4>
            <p>
              We collect your full name, Philippine mobile number, residential locality, visit purpose, vehicle information (if applicable), live portrait photo, and government/valid ID image strictly for campus security, visitor verification, authorized emergency tracing, and gate pass issuance.
            </p>
          </div>

          <div>
            <h4 className="font-bold text-[var(--color-text-primary)] text-xs mb-1">2. Data Retention & Automatic Purging</h4>
            <p>
              Your information is maintained under established institutional retention policies:
            </p>
            <ul className="list-disc pl-5 mt-1 space-y-1">
              <li>
                Face photos are normally retained for {effectivePhotoRetention} days under institutional policy.
              </li>
              <li>
                Valid ID images, when collected, are normally retained for {effectiveIdRetention} days under institutional policy.
              </li>
              <li>
                Visitor records are retained for {effectiveVisitorRetention} days under institutional policy.
              </li>
            </ul>
            <p className="mt-1">
              Evidence is retained at least through the scheduled visit, and authorized incident holds may extend retention when required.
            </p>
          </div>

          <div>
            <h4 className="font-bold text-[var(--color-text-primary)] text-xs mb-1">3. Ephemeral Biometric Verification</h4>
            <p>
              Biometric vector storage is disabled by default; when returning visitor 1:1 verification is enabled and calibrated, live selfies are compared ephemerally in bounded memory against your encrypted registration portrait and are never persisted as raw selfies or vector databases.
            </p>
          </div>

          <div>
            <h4 className="font-bold text-[var(--color-text-primary)] text-xs mb-1">4. Rights of the Data Subject</h4>
            <p>
              Under the Data Privacy Act, you have the right to be informed, to access, to object, to rectify, and to request reasonable erasure of your personal data, subject to legitimate institutional security and statutory retention requirements.
            </p>
          </div>

          <div>
            <h4 className="font-bold text-[var(--color-text-primary)] text-xs mb-1">5. Data Protection Officer</h4>
            <p>
              For privacy inquiries, clarifications, or requests concerning your visitor records, please contact the EARIST Data Protection Office at <em>privacy@earist.edu.ph</em>.
            </p>
          </div>
        </div>

        <div className="pt-3 border-t border-[var(--color-border)] flex justify-end">
          <Button
            variant="primary"
            onClick={onClose}
            className="w-full sm:w-auto"
          >
            I Understand
          </Button>
        </div>
      </div>
    </div>
  );
}
export default InstitutionalPrivacyNoticeModal;
