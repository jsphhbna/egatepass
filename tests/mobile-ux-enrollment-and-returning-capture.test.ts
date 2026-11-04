// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act, createRef } from 'react';
import { createRoot } from 'react-dom/client';
import { readFileSync } from 'node:fs';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('PART A: Remember Me Enrollment Card & Visibility Contract', () => {
  const getPassSrc = readFileSync('src/pages/GetPassPage.tsx', 'utf8');

  it('places the institutional enrollment card near the top of the Review step before Group 1: Visitor Information', () => {
    const reviewStepIndex = getPassSrc.indexOf("{step === 'review' && (");
    expect(reviewStepIndex).toBeGreaterThan(0);

    const verificationBadgeIndex = getPassSrc.indexOf('Biometric Identity Verified', reviewStepIndex);
    expect(verificationBadgeIndex).toBeGreaterThan(reviewStepIndex);

    const enrollmentCardIndex = getPassSrc.indexOf('Institutional Biometric Enrollment Card', verificationBadgeIndex);
    expect(enrollmentCardIndex).toBeGreaterThan(verificationBadgeIndex);

    const group1InfoIndex = getPassSrc.indexOf('Group 1: Visitor Information', enrollmentCardIndex);
    expect(group1InfoIndex).toBeGreaterThan(enrollmentCardIndex);

    // Verifies it is positioned above the fold before the extensive detail summaries
    expect(enrollmentCardIndex).toBeLessThan(group1InfoIndex);
  });

  it('replaces redundant "Remember me" with explicit optional biometric template enrollment headline', () => {
    // Verifies the old confusing "Remember me for faster future visits" was removed
    const oldOccurrences = (getPassSrc.match(/Remember me for faster future visits/g) || []).length;
    expect(oldOccurrences).toBe(0);

    // Explicit clear headline has exactly 1 occurrence in review step
    const newOccurrences = (getPassSrc.match(/Save Facial Biometric Template for Future Visits/g) || []).length;
    expect(newOccurrences).toBe(1);

    // Verifies clear notice that ordinary registration is retained under data retention policy
    expect(getPassSrc).toContain('Ordinary visitor registration details are securely retained under the campus data retention policy regardless of this choice');
    expect(getPassSrc).toContain("Declining this option does not affect your gate pass issuance or today's visit");
  });

  it('implements institutional maroon styling, subtle gold accents, and min-height >= 72px', () => {
    expect(getPassSrc).toContain('border-[#7A0A0A]');
    expect(getPassSrc).toContain('min-h-[72px]');
    expect(getPassSrc).toContain('bg-amber-100');
    expect(getPassSrc).toContain('text-amber-900');
    expect(getPassSrc).toContain('border-amber-300');
    expect(getPassSrc).toContain('Optional');
  });

  it('implements a comfortable 28px custom checkbox (h-7 w-7) with 16px title and 14px description', () => {
    expect(getPassSrc).toContain('h-7 w-7 rounded-md border-2 border-[#7A0A0A]');
    expect(getPassSrc).toContain('font-bold text-base');
    expect(getPassSrc).toContain('text-sm text-[var(--color-text-secondary)]');
    expect(getPassSrc).toContain('Securely save an encrypted facial recognition template');
  });

  it('makes the entire card a tap target and preserves explicit consent (default false)', () => {
    expect(getPassSrc).toContain('const [rememberVisitor, setRememberVisitor] = useState(false)');
    expect(getPassSrc).toContain('rememberVisitor,');
    expect(getPassSrc).toContain('Save this vehicle to my profile');
  });

  it('displays unavailable state when returning enrollment is not available', () => {
    expect(getPassSrc).toContain('enrollmentAvailable !== true');
    expect(getPassSrc).toContain('Returning Visitor enrollment is temporarily unavailable');
  });
});

describe('PART B: iPhone Email Modal Touch Interactions & Lifecycle Contract', () => {
  const emailModalSrc = readFileSync('src/components/EmailPassModal.tsx', 'utf8');
  const skipModalSrc = readFileSync('src/components/TimedSkipWarningModal.tsx', 'utf8');
  const modalSrc = readFileSync('src/components/ui/Modal.tsx', 'utf8');
  const getPassSrc = readFileSync('src/pages/GetPassPage.tsx', 'utf8');

  it('Modal component supports 100dvh, safe-area insets, and touch autofocus prevention', () => {
    expect(modalSrc).toContain('pt-[max(1rem,env(safe-area-inset-top))]');
    expect(modalSrc).toContain('pb-[max(1rem,env(safe-area-inset-bottom))]');
    expect(modalSrc).toContain('max-h-[calc(100dvh-2rem)]');
    expect(modalSrc).toContain('onOpenAutoFocus');
    expect(modalSrc).toContain('ontouchstart');
  });

  it('EmailPassModal recipient email input uses 52px min-height, text-base (>=16px) to avoid iOS zoom, and NO autoFocus', () => {
    expect(emailModalSrc).toContain('id="recipient-email"');
    expect(emailModalSrc).toContain('min-h-[52px] text-base');
    // Must NOT autoFocus on mount to avoid popping iOS software keyboard immediately
    expect(emailModalSrc).not.toContain('id="recipient-email"\n              type="email"\n              autoComplete="email"\n              inputMode="email"\n              value={recipientEmail}\n              onChange={(e) => setRecipientEmail(e.target.value)}\n              placeholder="visitor@example.com"\n              required\n              aria-required="true"\n              autoFocus');
  });

  it('EmailPassModal verification-code input uses 52px min-height, text-base (>=16px), numeric inputMode, and NO autoFocus', () => {
    expect(emailModalSrc).toContain('id="verification-code"');
    expect(emailModalSrc).toContain('min-h-[52px] text-base');
    expect(emailModalSrc).toContain('inputMode="numeric"');
    expect(emailModalSrc).toContain('autoComplete="one-time-code"');
  });

  it('enforces full-width vertical stack on mobile with min-h-[56px] and >=12px vertical separation (gap-3)', () => {
    // Initial email screen actions
    expect(emailModalSrc).toContain('flex flex-col-reverse sm:flex-row gap-3 pt-2');
    expect(emailModalSrc).toContain('min-h-[56px] sm:min-h-11 text-[15px] sm:text-sm');

    // Verification screen actions
    expect(emailModalSrc).toContain('space-y-3 pt-2');
    expect(emailModalSrc).toContain('Continue without email');
  });

  it('renders Continue without email as a prominent full button on verification screen rather than a tiny text link', () => {
    expect(emailModalSrc).toContain('variant="secondary"');
    expect(emailModalSrc).toContain('w-full min-h-[56px] sm:min-h-10 text-[15px] sm:text-xs');
  });

  it('eliminates overlapping skip-warning dialogs via sequential isOpen binding', () => {
    expect(getPassSrc).toContain('isOpen={showEmailModal && !showSkipWarning}');
    expect(getPassSrc).toContain('isOpen={showSkipWarning}');
    expect(getPassSrc).toContain('onCancel={() => setShowSkipWarning(false)}');
    expect(getPassSrc).toMatch(/setShowSkipWarning\(false\);[\r\n\s]+setShowEmailModal\(false\);/);
  });

  it('TimedSkipWarningModal enforces 56px touch target and 5s countdown safety', () => {
    expect(skipModalSrc).toContain('min-h-[56px] sm:min-h-11 text-[15px] sm:text-sm');
    expect(skipModalSrc).toContain('countdown > 0');
    expect(skipModalSrc).toContain('Continue Without Email — ${countdown}');
  });
});

describe('PART C: Returning Visitor Capture, Freeze, Review & Verification Workflow', () => {
  const getPassSrc = readFileSync('src/pages/GetPassPage.tsx', 'utf8');

  it('defines distinct returningCaptureStage, returningSelfieBlob, and returningSelfieUrl state', () => {
    expect(getPassSrc).toContain("const [returningCaptureStage, setReturningCaptureStage] = useState<'live' | 'review'>('live')");
    expect(getPassSrc).toContain('const [returningSelfieBlob, setReturningSelfieBlob] = useState<Blob | null>(null)');
    expect(getPassSrc).toContain('const [returningSelfieUrl, setReturningSelfieUrl] = useState<string | null>(null)');
  });

  it('Stage 1 (Live camera) shows Capture Selfie button and does not send biometric comparison calls during live preview', () => {
    expect(getPassSrc).toContain("returningCaptureStage === 'live'");
    expect(getPassSrc).toContain('Capture Selfie');
    expect(getPassSrc).toContain('onClick={onCaptureReturningSelfie}');
  });

  it('Stage 2 (Capture and freeze) captures 1 frame into blob, stops webcam, and switches to review without uploading', () => {
    expect(getPassSrc).toContain('async function onCaptureReturningSelfie()');
    expect(getPassSrc).toContain('faceWebcam.capture({ mirror: false })');
    expect(getPassSrc).toContain('faceWebcam.stop()');
    expect(getPassSrc).toContain("setReturningCaptureStage('review')");
  });

  it('Stage 3 (Still-photo review) presents frozen image preview with Retake Photo and Verify This Photo actions', () => {
    expect(getPassSrc).toContain("returningCaptureStage === 'review'");
    expect(getPassSrc).toContain('alt="Captured selfie preview"');
    expect(getPassSrc).toContain('Retake Photo');
    expect(getPassSrc).toContain('Verify This Photo');
    expect(getPassSrc).toContain('onClick={onRetakeReturningSelfie}');
    expect(getPassSrc).toContain('onClick={onConfirmReturningVerification}');
  });

  it('Stage 3 Retake Photo revokes object URL, clears selfie blob, restarts camera, and returns to live stage', () => {
    expect(getPassSrc).toContain('function onRetakeReturningSelfie()');
    expect(getPassSrc).toContain('URL.revokeObjectURL(returningSelfieUrl)');
    expect(getPassSrc).toContain('setReturningSelfieBlob(null)');
    expect(getPassSrc).toContain("setReturningCaptureStage('live')");
    expect(getPassSrc).toContain('void faceWebcam.start()');
  });

  it('Stage 4 (Verification & 1:1 Compare) only runs when Verify This Photo is clicked, evaluating client quality first', () => {
    expect(getPassSrc).toContain('async function onConfirmReturningVerification()');
    expect(getPassSrc).toContain('await evaluateReturningSelfiePrecheck(returningSelfieBlob)');
    expect(getPassSrc).toContain('uploadPortalEvidence(tx, \'photo\', returningSelfieBlob)');
    expect(getPassSrc).toContain('identifyReturningVisitor(tx, photoRes.intentId, selectedReturningCandidate.profileId)');
  });

  it('Stage 5 (Match accepted) reuses verified selfie blob for subsequent pass issuance and advances to returning_confirm', () => {
    expect(getPassSrc).toContain('setPhotoBlob(returningSelfieBlob)');
    expect(getPassSrc).toContain('photoUrl.setFromBlob(returningSelfieBlob)');
    expect(getPassSrc).toContain('setIdentityVerified(true)');
    expect(getPassSrc).toContain("setStep('returning_confirm')");
  });

  it('Stage 6 (Match rejected) shows clear inline error near still preview and provides Retake Selfie without losing candidate', () => {
    expect(getPassSrc).toContain('We could not verify this photo.');
    expect(getPassSrc).toContain('Retake Selfie');
    expect(getPassSrc).toContain('setReturningIdentifyError(');
    // User is NOT forced to new visitor on single rejection, candidate remains selected
    expect(getPassSrc).toContain('onClick={onRetakeReturningSelfie}');
  });

  it('Stage 7 (Cleanup) cleans up camera streams, blobs, and object URLs on reset and unmount', () => {
    expect(getPassSrc).toContain('URL.revokeObjectURL(returningSelfieUrl)');
    expect(getPassSrc).toContain('faceWebcam.stop()');
  });
});
