import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

describe('FEATURE 4 CONTRACT: Online Pass Delivery Gate, Timed Skip Warning & Refresh Protection', () => {
  const getPassSrc = readFileSync('src/pages/GetPassPage.tsx', 'utf8');
  const modalSrc = readFileSync('src/components/EmailPassModal.tsx', 'utf8');
  const warningSrc = readFileSync('src/components/TimedSkipWarningModal.tsx', 'utf8');
  const kioskSrc = readFileSync('src/pages/KioskPage.tsx', 'utf8');

  it('does NOT immediately reveal final QR code upon pass issuance, transitioning instead to delivery gate', () => {
    // onSubmit transitions to delivery step, not done
    const submitMatch = getPassSrc.match(/async function onSubmit[\s\S]*?finally/);
    expect(submitMatch).toBeTruthy();
    const submitFn = submitMatch![0];

    expect(submitFn).toContain("setStep('delivery')");
    expect(submitFn).toContain('setShowEmailModal(true)');
  });

  it('configures EmailPassModal with delivery-gate mode on portal issuance', () => {
    expect(getPassSrc).toContain("mode={step === 'delivery' ? 'delivery-gate' : 'modal'}");
    expect(modalSrc).toContain("mode = 'modal'");
    expect(modalSrc).toContain("const isDeliveryGate = mode === 'delivery-gate';");
  });

  it('prohibits silent bypass of delivery gate via standard cancel', () => {
    expect(modalSrc).toContain('isDeliveryGate && onSkip');
    expect(modalSrc).toContain('Continue without email');
    expect(modalSrc).toContain('preventClose={loading || (isDeliveryGate && (step === \'input\' || step === \'verify\'))}');
  });

  it('triggers TimedSkipWarningModal when visitor chooses to continue without email', () => {
    expect(getPassSrc).toContain('<TimedSkipWarningModal');
    expect(getPassSrc).toContain('isOpen={showSkipWarning}');
    expect(getPassSrc).toContain('onConfirmSkip=');
  });

  it('enforces a 5-second countdown in TimedSkipWarningModal before skip button becomes active', () => {
    expect(warningSrc).toContain('const [countdown, setCountdown] = useState(5);');
    expect(warningSrc).toContain('disabled={countdown > 0}');
    expect(warningSrc).toContain("countdown > 0 ? `Continue Without Email — ${countdown}` : 'Continue Without Email'");
  });

  it('displays persistent visible warning on done screen when email was skipped', () => {
    expect(getPassSrc).toContain('emailSkipped && !emailDeliverySecured');
    expect(getPassSrc).toContain('Save your E-GatePass before leaving this page.');
    expect(getPassSrc).toContain('You chose not to provide a verified email, so a copy was not sent to you.');
  });

  it('displays truthful confirmation when email was verified and accepted by provider', () => {
    expect(getPassSrc).toContain('emailDeliverySecured && (');
    expect(getPassSrc).toContain('A copy of your E-GatePass was sent to your verified email.');
  });

  it('installs beforeunload guard on issued pass until email is verified or download is initiated', () => {
    expect(getPassSrc).toContain('const isDeliverySecured = emailDeliverySecured || isDownloaded;');
    expect(getPassSrc).toContain("window.addEventListener('beforeunload', handleBeforeUnload);");
    expect(getPassSrc).toContain("window.removeEventListener('beforeunload', handleBeforeUnload);");
    expect(getPassSrc).toContain('setIsDownloaded(true);');
  });

  it('preserves single pass issuance idempotency across email retries, skip, and download actions', () => {
    // issueRequestId is initialized once and passed to issueVisitorPass
    expect(getPassSrc).toContain('const issueRequestId = useRef(crypto.randomUUID());');
    expect(getPassSrc).toContain('issueVisitorPass(\'portal\', formData, photoBlob, idBlob, issueRequestId.current');
    
    // Neither skip nor download calls issueVisitorPass
    const downloadMatch = getPassSrc.match(/function handleDownload[\s\S]*?}/);
    expect(downloadMatch).toBeTruthy();
    expect(downloadMatch![0]).not.toContain('issueVisitorPass');

    // Email resend operates with its own separate idempotency key and does not re-issue pass
    expect(modalSrc).toContain('action: \'verify_and_send\'');
    expect(modalSrc).toContain('passId,');
  });

  it('preserves outcome_unknown safety: never auto-retries unknown email outcome', () => {
    expect(modalSrc).toContain("step === 'unknown'");
    expect(modalSrc).toContain('Outcome Unknown');
    expect(modalSrc).toContain('To avoid sending the bearer QR twice, automatic retry is disabled.');
  });

  it('keeps kiosk email modal strictly optional post-issuance', () => {
    expect(kioskSrc).toContain('Email my QR code');
    expect(kioskSrc).toContain('<EmailPassModal');
    expect(kioskSrc).not.toContain("mode='delivery-gate'");
    expect(kioskSrc).not.toContain('mode="delivery-gate"');
  });
});
