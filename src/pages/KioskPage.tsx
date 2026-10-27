import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useWebcam } from '@/hooks/useWebcam';
import { useObjectUrl } from '@/hooks/useObjectUrl';
import { compressImageToWebP } from '@/lib/imageProcessing';
import {
  issueVisitorPass,
  loadRegistrationSettings,
  PassIssuanceError,
  type IssueTransaction,
  type IssuedPass,
} from '@/services/visitorRegistration';
import QRCode from 'qrcode';
import {
  Camera,
  CheckCircle2,
  ArrowLeft,
  ArrowRight,
  AlertCircle,
  X,
  RotateCcw,
  Printer,
  Mail,
  Scan,
  Loader2,
  LogOut,
  RefreshCw,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button, Card, Input, FormField, Stepper, Modal } from '@/components/ui';
import { EmailPassModal } from '@/components/EmailPassModal';
import { BrandMark } from '@/components/BrandMark';
import { VisitPurposeField } from '@/components/VisitPurposeField';
import { DEFAULT_VISIT_PURPOSES, normalizeVisitPurposes } from '@/lib/settingsDefaults';
import type { VisitPurposeOption } from '@/types';
import { DEFAULT_WORKING_HOURS, formatWorkingHours, MAX_VISIT_ADVANCE_DAYS, normalizeWorkingHours } from '@/lib/workingHours';
import { signOutCurrentActor } from '@/services/auth';
import { getManilaDateString, getLatestVisitDateString, validateVisitDate } from '@/lib/scheduling';
import { formatManilaTime } from '@/lib/manilaTime';
import { useThermalPrinter } from '@/printer/hooks/useThermalPrinter';
import { KioskPrinterSettingsModal } from '@/components/KioskPrinterSettingsModal';
import { InstitutionalPassCard } from '@/components/InstitutionalPassCard';
import { createPassPresentation, type PassPresentation } from '@/lib/passPresentation';
import { recognizeIdImage, terminateLocalOcrWorker } from '@/lib/ocr';
import { generateBrandedQrDataUrl } from '@/lib/brandedQr';

// ============================================================
// FORM SCHEMA (Zod)
// ============================================================
const nameRegex = /^[\p{L}\s\-'.]+$/u;

export function createKioskPassSchema(schedulingDaysAhead: number = MAX_VISIT_ADVANCE_DAYS) {
  return z.object({
    firstName: z
      .string()
      .trim()
      .min(2, 'First name must be at least 2 characters')
      .max(50, 'First name is too long')
      .regex(nameRegex, 'Invalid characters in name'),
    middleName: z
      .string()
      .trim()
      .max(50, 'Middle name is too long')
      .regex(nameRegex, 'Invalid characters in name')
      .optional()
      .or(z.literal('')),
    lastName: z
      .string()
      .trim()
      .min(2, 'Last name must be at least 2 characters')
      .max(50, 'Last name is too long')
      .regex(nameRegex, 'Invalid characters in name'),
    contactNumber: z
      .string()
      .min(7, 'Contact number must be at least 7 digits')
      .max(15, 'Contact number is too long')
      .regex(/^[0-9+\-() ]+$/, 'Invalid contact number format'),
    purpose: z
      .string()
      .min(3, 'Please describe your purpose')
      .max(300, 'Purpose description is too long'),
    visitDate: z
      .string()
      .min(1, 'Please select a visit date')
      .superRefine((val, ctx) => {
        const res = validateVisitDate(val, new Date(), schedulingDaysAhead);
        if (!res.valid && res.error) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: res.error,
          });
        }
      }),
    consent: z.literal(true, {
      message: 'Visitor must accept the Data Privacy Act notice to proceed',
    }),
  });
}

type KioskPassFormData = z.infer<ReturnType<typeof createKioskPassSchema>>;

type Step = 'scan-intro' | 'scan-camera' | 'scan-processing' | 'form' | 'photo' | 'id' | 'review' | 'generating' | 'done';

export function KioskPage() {
  const [step, setStep] = useState<Step>('scan-intro');
  const [photoBlob, setPhotoBlob] = useState<Blob | null>(null);
  const photoUrl = useObjectUrl();
  const photoPreview = photoUrl.url;
  const [idBlob, setIdBlob] = useState<Blob | null>(null);
  const idUrl = useObjectUrl();
  const idPreview = idUrl.url;
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [passId, setPassId] = useState<string | null>(null);
  const [rawQrToken, setRawQrToken] = useState<string | null>(null);
  const [showEmailModal, setShowEmailModal] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [isPeakMode, setIsPeakMode] = useState(false);
  const [visitPurposes, setVisitPurposes] = useState<VisitPurposeOption[]>(DEFAULT_VISIT_PURPOSES);
  const [workingHours, setWorkingHours] = useState(DEFAULT_WORKING_HOURS);
  const [schedulingDaysAhead, setSchedulingDaysAhead] = useState(MAX_VISIT_ADVANCE_DAYS);
  const [issuedValidity, setIssuedValidity] = useState<string | null>(null);
  const [ocrSuccessNotice, setOcrSuccessNotice] = useState(false);
  const [showSignOutConfirm, setShowSignOutConfirm] = useState(false);
  const [currentPassPresentation, setCurrentPassPresentation] = useState<PassPresentation | null>(null);
  const [showPrinterSettings, setShowPrinterSettings] = useState(false);
  const [printFailed, setPrintFailed] = useState(false);

  const {
    status: printerStatus,
    config: printerConfig,
    printPass,
  } = useThermalPrinter();
  const isPrinting = printerStatus === 'printing';
  const isAutoPrintEnabled = printerConfig.autoPrint;

  const kioskTransactionRef = useRef<IssueTransaction>({
    requestId: crypto.randomUUID(),
    photoIntentId: null,
    idIntentId: null,
    photoCheckpoint: null,
    idCheckpoint: null,
    phase: 'editable',
  });
  const issueRequestId = useRef(kioskTransactionRef.current.requestId as ReturnType<typeof crypto.randomUUID>);
  const isSubmittingRef = useRef(false);

  type KioskConfigState = 'loading' | 'ready' | 'error';
  const [configState, setConfigState] = useState<KioskConfigState>('loading');
  const [retryingConfig, setRetryingConfig] = useState(false);
  const [isProcessingId, setIsProcessingId] = useState(false);
  const [isSigningOut, setIsSigningOut] = useState(false);

  const loadSettings = useCallback(async (isRetry = false) => {
    if (isRetry) setRetryingConfig(true);
    else setConfigState('loading');

    try {
      const data = await loadRegistrationSettings('kiosk');
      const peakActive = data.peak_mode === 'kiosk' || data.peak_mode === 'both';
      setIsPeakMode(peakActive);
      setStep(peakActive ? 'form' : 'scan-intro');
      setVisitPurposes(normalizeVisitPurposes(data.visit_purposes));
      setWorkingHours(normalizeWorkingHours({
        start: data.working_hours_start?.slice(0, 5),
        end: data.working_hours_end?.slice(0, 5),
        timezone: data.timezone,
      }));
      if (typeof data.scheduling_days_ahead === 'number') {
        setSchedulingDaysAhead(data.scheduling_days_ahead);
      }
      setConfigState('ready');
    } catch {
      setConfigState('error');
    } finally {
      setRetryingConfig(false);
    }
  }, []);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  const faceWebcam = useWebcam({ facingMode: 'user', width: 640, height: 480 });
  const idWebcam = useWebcam({ facingMode: 'environment', width: 1280, height: 720 });
  const ocrGenerationRef = useRef(0);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      ocrGenerationRef.current += 1;
      faceWebcam.stop();
      idWebcam.stop();
      void terminateLocalOcrWorker();
    };
  }, []);

  const formSchema = useMemo(() => createKioskPassSchema(schedulingDaysAhead), [schedulingDaysAhead]);

  // Manila-aware calendar date limits
  const today = getManilaDateString();
  const latestVisitDate = getLatestVisitDateString(today, schedulingDaysAhead);

  const {
    register,
    handleSubmit,
    getValues,
    reset,
    setValue,
    watch,
    formState: { errors, isValid },
  } = useForm<KioskPassFormData>({
    resolver: zodResolver(formSchema),
    mode: 'onChange',
    defaultValues: {
      visitDate: today,
      consent: false as unknown as true,
      purpose: '',
    },
  });

  const purpose = watch('purpose');

  function startIdScan() {
    setStep('scan-camera');
    idWebcam.start();
  }

  async function processIdImageAndOcr(blob: Blob) {
    const generation = ++ocrGenerationRef.current;
    idWebcam.stop();
    setStep('scan-processing');
    try {
      const compressed = await compressImageToWebP(blob);
      if (generation !== ocrGenerationRef.current) return;
      kioskTransactionRef.current.idIntentId = null;
      kioskTransactionRef.current.idCheckpoint = null;
      kioskTransactionRef.current.phase = 'editable';
      setIdBlob(compressed);
      idUrl.setFromBlob(compressed);

      // Offline OCR via self-hosted worker
      const parsed = await recognizeIdImage(compressed);
      if (generation !== ocrGenerationRef.current) return;

      let filledCount = 0;

      if (parsed.firstName) {
        setValue('firstName', parsed.firstName, { shouldDirty: true, shouldValidate: true });
        filledCount++;
      }
      if (parsed.middleName) {
        setValue('middleName', parsed.middleName, { shouldDirty: true, shouldValidate: true });
      }
      if (parsed.lastName) {
        setValue('lastName', parsed.lastName, { shouldDirty: true, shouldValidate: true });
        filledCount++;
      }

      if (filledCount >= 1) {
        setOcrSuccessNotice(true);
        toast.success('Details read from ID! Please review and complete your information.');
      } else {
        setOcrSuccessNotice(false);
        toast.info('Could not clearly read names. Please review and enter details manually.');
      }
    } catch (err) {
      if (generation !== ocrGenerationRef.current) return;
      console.warn('Local OCR warning:', err);
      setOcrSuccessNotice(false);
      toast.info('Automatic reading skipped. Please enter your details manually.');
    } finally {
      if (generation === ocrGenerationRef.current) {
        setStep('form');
      }
    }
  }

  function onCaptureIdAndOcr() {
    const blob = idWebcam.capture();
    if (blob) {
      void processIdImageAndOcr(blob);
    } else {
      toast.error('Failed to capture ID image.');
    }
  }

  function onFormNext(data: KioskPassFormData) {
    void data;
    setStep('photo');
    faceWebcam.start();
  }

  function onCapturePhoto() {
    const blob = faceWebcam.capture();
    if (blob) {
      kioskTransactionRef.current.photoIntentId = null;
      kioskTransactionRef.current.photoCheckpoint = null;
      kioskTransactionRef.current.phase = 'editable';
      setPhotoBlob(blob);
      photoUrl.setFromBlob(blob);
      faceWebcam.stop();
      if (idBlob || isPeakMode) {
        setStep('review');
      } else {
        setStep('id');
        idWebcam.start();
      }
    } else {
      toast.error('Failed to capture photo.');
    }
  }

  function onRetakePhoto() {
    kioskTransactionRef.current.photoIntentId = null;
    kioskTransactionRef.current.photoCheckpoint = null;
    kioskTransactionRef.current.phase = 'editable';
    photoUrl.clear();
    setPhotoBlob(null);
    faceWebcam.stop();
    setStep('photo');
    faceWebcam.start();
  }

  async function onCaptureManualId() {
    if (isProcessingId) return;
    const blob = idWebcam.capture();
    if (blob) {
      setIsProcessingId(true);
      idWebcam.stop();
      try {
        const compressed = await compressImageToWebP(blob);
        kioskTransactionRef.current.idIntentId = null;
        kioskTransactionRef.current.idCheckpoint = null;
        kioskTransactionRef.current.phase = 'editable';
        setIdBlob(compressed);
        idUrl.setFromBlob(compressed);
      } catch {
        toast.error('Failed to process ID image.');
        idWebcam.start();
      } finally {
        setIsProcessingId(false);
      }
    } else {
      toast.error('Failed to capture ID image.');
    }
  }

  async function handleSignOut() {
    if (isSigningOut) return;
    setIsSigningOut(true);
    try {
      await signOutCurrentActor();
    } catch {
      toast.error('Failed to sign out. Please try again.');
      setIsSigningOut(false);
    }
  }

  function onRetakeId() {
    kioskTransactionRef.current.idIntentId = null;
    kioskTransactionRef.current.idCheckpoint = null;
    kioskTransactionRef.current.phase = 'editable';
    idUrl.clear();
    setIdBlob(null);
    idWebcam.stop();
    setStep('id');
    idWebcam.start();
  }

  async function onSubmit() {
    if (isSubmittingRef.current) return;
    if (kioskTransactionRef.current?.phase === 'existing_pass_conflict') {
      toast.error('An existing pass was already created for this request. Please ask the Guard for assistance.');
      return;
    }
    if (!photoBlob) {
      toast.error('Photo is required.');
      return;
    }
    if (!isPeakMode && !idBlob) {
      toast.error('Valid ID capture is required.');
      return;
    }

    isSubmittingRef.current = true;
    setStep('generating');
    setSubmitError(null);

    let result: IssuedPass;
    const formData = getValues();
    try {
      result = await issueVisitorPass(
        'kiosk',
        formData,
        photoBlob,
        idBlob,
        kioskTransactionRef.current.requestId,
        undefined,
        kioskTransactionRef.current
      );
    } catch (err) {
      console.error(err);
      if (err instanceof PassIssuanceError) {
        if (err.outcome === 'existing_pass_replay_conflict') {
          // Do NOT rotate requestId, do NOT clear existing request, do NOT issue a second pass.
          // Preserve transaction state for operator/recovery handling.
          setSubmitError(
            err.message ||
              'An existing pass was already created for this request, but this retry does not match the recorded details. Please consult the guard station.'
          );
        } else if (err.outcome === 'rejected_requires_new_transaction') {
          // Reset kiosk transaction: new request ID, no old intents/checkpoints, phase editable (Section 10)
          kioskTransactionRef.current = {
            requestId: crypto.randomUUID(),
            photoIntentId: null,
            idIntentId: null,
            photoCheckpoint: null,
            idCheckpoint: null,
            phase: 'editable',
            submittedPayload: null,
          };
          issueRequestId.current = kioskTransactionRef.current.requestId as ReturnType<typeof crypto.randomUUID>;
          setSubmitError(err.message || 'Pass registration conflict. Tap Retry to generate a new pass.');
        } else if (err.outcome === 'rejected_correctable_field') {
          setSubmitError(err.message);
        } else {
          // Ambiguous outcome: preserve exact transaction/checkpoints and show truthful retry wording
          setSubmitError('Generation result could not be confirmed. Tap Retry to check status.');
        }
      } else {
        setSubmitError(err instanceof Error ? err.message : 'Failed to issue pass');
      }
      setStep('review');
      toast.error('Failed to issue gate pass');
      return;
    } finally {
      isSubmittingRef.current = false;
    }

    // Phase A — authoritative issuance committed
    setPassId(result.passId);
    setRawQrToken(result.qrToken);
    const validity = result.validFrom && result.validUntil
      ? `${formatManilaTime(result.validFrom)} - ${formatManilaTime(result.validUntil)}`
      : null;
    setIssuedValidity(validity);

    // Phase B — presentation generation
    let qrUrl: string | null = null;
    try {
      qrUrl = await generateBrandedQrDataUrl(result.qrToken, {
        size: 360,
      });
    } catch (qrErr) {
      console.warn('Branded QR generation failed, falling back to standard QR:', qrErr);
      try {
        qrUrl = await QRCode.toDataURL(result.qrToken, { width: 360, margin: 2, errorCorrectionLevel: 'H' });
      } catch (fallbackErr) {
        console.error('Standard QR rendering fallback failed:', fallbackErr);
      }
    }

    const effectiveVisitor = kioskTransactionRef.current?.submittedPayload?.visitor ?? formData;

    const presentation = createPassPresentation({
      visitorName: [effectiveVisitor.firstName, effectiveVisitor.middleName, effectiveVisitor.lastName].filter(Boolean).join(' '),
      visitDate: effectiveVisitor.visitDate,
      passReference: result.publicReference || result.passId,
      qrToken: result.qrToken,
      purpose: effectiveVisitor.purpose,
      validityWindow: validity ?? undefined,
    });

    setCurrentPassPresentation(presentation);
    setQrDataUrl(qrUrl);
    setStep('done');
    toast.success('Gate pass issued!');

    // Critical invariant: PRINT FAILURE MUST NEVER ROLL BACK PASS ISSUANCE.
    if (isAutoPrintEnabled && printerStatus === 'connected') {
      try {
        await printPass(presentation);
        setPrintFailed(false);
        toast.success('Pass printed via MXW01');
      } catch (printErr) {
        console.warn('Auto print failed:', printErr);
        setPrintFailed(true);
        toast.error('Direct thermal print failed. Printer unavailable.');
      }
    }
  }

  async function handlePrint() {
    if (currentPassPresentation && printerStatus === 'connected') {
      try {
        await printPass(currentPassPresentation);
        setPrintFailed(false);
        toast.success('Pass printed via MXW01');
      } catch (printErr) {
        console.warn('Direct print failed, falling back to browser print:', printErr);
        setPrintFailed(true);
        toast.error('Direct thermal printing unavailable. Opening browser print.');
        window.print();
      }
    } else {
      window.print();
    }
  }

  function resetCurrentVisitor() {
    ocrGenerationRef.current += 1;
    kioskTransactionRef.current = {
      requestId: crypto.randomUUID(),
      photoIntentId: null,
      idIntentId: null,
      photoCheckpoint: null,
      idCheckpoint: null,
      phase: 'editable',
      submittedPayload: null,
    };
    issueRequestId.current = kioskTransactionRef.current.requestId as ReturnType<typeof crypto.randomUUID>;
    reset({
      visitDate: today,
      consent: false as unknown as true,
      purpose: '',
      firstName: '',
      middleName: '',
      lastName: '',
      contactNumber: '',
    });
    faceWebcam.stop();
    idWebcam.stop();
    void terminateLocalOcrWorker();
    setPhotoBlob(null);
    photoUrl.clear();
    setIdBlob(null);
    idUrl.clear();
    setQrDataUrl(null);
    setPassId(null);
    setRawQrToken(null);
    setCurrentPassPresentation(null);
    setPrintFailed(false);
    setShowEmailModal(false);
    setSubmitError(null);
    setIssuedValidity(null);
    setOcrSuccessNotice(false);
    setStep(isPeakMode ? 'form' : 'scan-intro');
  }

  function handleAmbiguousCancelAndAskGuard() {
    toast.warning(
      'Session cancelled. The previous pass may have been created. Please ask the Guard for assistance.',
      { duration: 8000 }
    );
    resetCurrentVisitor();
  }

  function handleNextVisitor() {
    resetCurrentVisitor();
  }

  // 120-second inactivity timeout to protect visitor PII from abandonment
  useEffect(() => {
    if (step === 'scan-intro' || step === 'generating') return;

    let timeoutId: NodeJS.Timeout;
    function resetTimer() {
      clearTimeout(timeoutId);
      timeoutId = setTimeout(() => {
        toast.info('Session reset due to inactivity.');
        resetCurrentVisitor();
      }, 120_000);
    }

    resetTimer();
    const events = ['mousedown', 'mousemove', 'keypress', 'scroll', 'touchstart'];
    events.forEach((ev) => window.addEventListener(ev, resetTimer, { passive: true }));

    return () => {
      clearTimeout(timeoutId);
      events.forEach((ev) => window.removeEventListener(ev, resetTimer));
    };
  }, [step, isPeakMode]);

  const steps = [
    ...(!isPeakMode ? [{ id: 'scan-intro', title: 'Scan ID' }] : []),
    { id: 'form', title: 'Details' },
    { id: 'photo', title: 'Photo' },
    ...(!isPeakMode && !idBlob ? [{ id: 'id', title: 'Capture ID' }] : []),
    { id: 'review', title: 'Review' },
  ];

  const currentStepIndex =
    step === 'done' || step === 'generating' ? steps.length :
    step === 'scan-camera' || step === 'scan-processing' ? 0 :
    steps.findIndex((s) => s.id === step);

  return (
    <main id="main-content" className="mx-auto flex min-h-dvh w-full max-w-7xl flex-col items-center justify-center gap-8 bg-[var(--color-canvas)] px-4 py-8 lg:flex-row lg:items-start lg:py-10">
      {/* Left Column (Fixed on Desktop) */}
      <div className="w-full max-w-lg lg:w-[320px] lg:shrink-0 lg:sticky lg:top-12 flex flex-col items-center lg:items-start print:hidden">
        
        {/* Header */}
        <div className="mb-8 text-center lg:text-left w-full">
          <div className="inline-block">
            <BrandMark size="lg" className="mx-auto lg:mx-0 mb-4" />
          </div>
          <h1 className="text-3xl font-bold text-[var(--color-text-primary)]">
            Walk-in Registration Kiosk
          </h1>
          <p className="mt-2 text-sm leading-relaxed text-[var(--color-text-secondary)]">Register one visitor at a time, then print the completed gate pass.</p>
        </div>

        {/* Step Indicator */}
        {configState === 'ready' && step !== 'done' && step !== 'generating' && (
          <div className="w-full">
            {/* Horizontal Stepper for Mobile/Portrait */}
            <div className="lg:hidden w-full mb-8">
              <Stepper steps={steps} currentStepIndex={currentStepIndex} className="w-full px-4" orientation="horizontal" />
            </div>
            {/* Vertical Stepper for Landscape Desktop */}
            <div className="hidden lg:block w-full">
              <Stepper steps={steps} currentStepIndex={currentStepIndex} className="w-full pl-2" orientation="vertical" />
            </div>
          </div>
        )}

        {/* Accessible operator device session and printer controls */}
        <div className="mt-6 pt-4 border-t border-[var(--color-border)]/40 w-full text-center lg:text-left print:hidden flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setShowPrinterSettings(true)}
            className="inline-flex min-h-11 items-center gap-2 text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] rounded px-3 py-2 focus:outline-none focus:ring-2 focus:ring-[var(--color-brand)]"
            aria-label="Thermal printer settings"
          >
            <Printer className="h-4 w-4" />
            <span>Printer ({printerStatus === 'connected' ? 'Ready' : 'Offline'})</span>
          </button>
          <button
            type="button"
            onClick={() => setShowSignOutConfirm(true)}
            className="inline-flex min-h-11 items-center gap-2 text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] rounded px-3 py-2 focus:outline-none focus:ring-2 focus:ring-[var(--color-brand)]"
            aria-label="Kiosk device session options"
          >
            <LogOut className="h-4 w-4" />
            <span>Device Session</span>
          </button>
        </div>
      </div>

      {/* Right Column (Dynamic Main Card) */}
      <div className="w-full max-w-lg print:max-w-none print:w-full">
        <Card className="border-t-4 border-t-[var(--color-brand)] print:border-0 print:shadow-none print:p-0">
          {configState === 'loading' && (
            <div className="py-16 text-center" role="status" aria-live="polite">
              <Loader2 className="mx-auto h-10 w-10 animate-spin text-[var(--color-brand)] mb-4" aria-hidden="true" />
              <h2 className="text-lg font-bold text-[var(--color-text-primary)]">Preparing kiosk registration…</h2>
              <p className="mt-1 text-sm text-[var(--color-text-secondary)]">Loading campus visit settings.</p>
            </div>
          )}

          {configState === 'error' && (
            <div className="py-12 text-center" role="alert">
              <AlertCircle className="mx-auto h-12 w-12 text-[var(--color-danger)] mb-4" aria-hidden="true" />
              <h2 className="text-xl font-bold text-[var(--color-text-primary)]">
                Kiosk configuration unavailable
              </h2>
              <p className="mt-1 text-sm text-[var(--color-text-secondary)] max-w-sm mx-auto">
                Campus visit settings could not be loaded. Check the kiosk connection and try again.
              </p>
              <div className="mt-4 p-4 rounded-xl border border-amber-500/30 bg-amber-500/10 text-amber-900 dark:text-amber-200 text-sm font-medium max-w-sm mx-auto">
                <p className="font-bold text-xs uppercase tracking-wider mb-1 text-amber-800 dark:text-amber-300">
                  ⚠ SERVICE TEMPORARILY UNAVAILABLE
                </p>
                <p className="text-xs mb-1">Visitor registration is currently unavailable.</p>
                <p>Please proceed directly to the Guard for registration and verification.</p>
              </div>
              <Button
                onClick={() => void loadSettings(true)}
                loading={retryingConfig}
                disabled={retryingConfig}
                icon={!retryingConfig ? <RotateCcw className="h-4 w-4" /> : undefined}
                className="mt-6"
              >
                {retryingConfig ? 'Retrying…' : 'Try Again'}
              </Button>
            </div>
          )}

          {configState === 'ready' && (
            <>
          {/* STEP 1: Scan ID Intro (Owner-Approved Default Screen) */}
          {step === 'scan-intro' && (
            <div className="space-y-6 text-center py-4">
              <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-2xl bg-[var(--color-brand-light)] text-[var(--color-brand)] border border-[var(--color-brand)]/20 shadow-sm">
                <Scan className="h-10 w-10" />
              </div>

              <div className="space-y-2">
                <h2 className="text-2xl font-bold text-[var(--color-text-primary)]">
                  Scan Your Valid ID
                </h2>
                <p className="mx-auto max-w-md text-sm text-[var(--color-text-secondary)] leading-relaxed">
                  Hold your government, school, or company ID up to the camera. We will automatically read your name to speed up registration.
                </p>
              </div>

              <div className="mx-auto max-w-sm space-y-4 pt-2">
                <Button
                  type="button"
                  size="lg"
                  onClick={startIdScan}
                  className="w-full text-base font-semibold min-h-[48px] shadow-sm"
                  icon={<Camera className="h-5 w-5" />}
                >
                  Scan My ID
                </Button>

                <div>
                  <button
                    type="button"
                    onClick={() => {
                      setStep('form');
                    }}
                    className="text-sm font-medium text-[var(--color-text-secondary)] hover:text-[var(--color-brand)] underline underline-offset-4 transition-colors min-h-[44px] py-2 px-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-brand)] rounded"
                  >
                    Want to type manually instead?
                  </button>
                </div>
              </div>

              <div className="mx-auto max-w-md rounded-xl border border-[var(--color-border)] bg-[var(--color-canvas)] p-4 text-xs text-[var(--color-text-muted)] text-left">
                <p className="font-semibold text-[var(--color-text-secondary)] mb-1">Supported Valid IDs:</p>
                <p>PhilSys National ID, Driver's License, UMID, Postal ID, Passport, PRC ID, Student ID, or Company ID.</p>
              </div>
            </div>
          )}

          {/* STEP 2: Rear Camera ID Capture */}
          {step === 'scan-camera' && (
            <div className="space-y-6">
              <div className="text-center">
                <h2 className="text-lg font-bold text-[var(--color-text-primary)]">Position Your ID in the Frame</h2>
                <p className="text-xs text-[var(--color-text-secondary)] mt-1">
                  Ensure the ID is well-lit and the text is clear and readable.
                </p>
              </div>

              <div className="mx-auto w-full max-w-md overflow-hidden rounded-xl border-2 border-dashed border-[var(--color-brand)] shadow-sm bg-black aspect-[3/2] relative flex items-center justify-center">
                {idWebcam.error ? (
                  <div className="p-6 text-center text-white space-y-3">
                    <AlertCircle className="mx-auto h-8 w-8 text-[var(--color-danger)]" />
                    <p className="text-sm font-semibold">Valid ID camera access is required.</p>
                    <p className="text-xs text-white/80">{idWebcam.error}</p>
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      onClick={() => idWebcam.start()}
                      icon={<RotateCcw className="h-4 w-4" />}
                    >
                      Retry Camera
                    </Button>
                  </div>
                ) : (
                  <>
                    {idWebcam.isStarting && (
                      <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-black/80 text-white" role="status" aria-live="polite">
                        <Loader2 className="h-8 w-8 animate-spin text-[var(--color-brand)] mb-2" aria-hidden="true" />
                        <span className="text-sm font-medium">Starting ID camera…</span>
                      </div>
                    )}
                    <video ref={idWebcam.videoRef} autoPlay playsInline muted className="h-full w-full object-cover" />
                  </>
                )}
              </div>

              <div className="flex flex-col gap-3 sm:flex-row">
                <Button
                  variant="secondary"
                  type="button"
                  onClick={() => {
                    resetCurrentVisitor();
                  }}
                  className="flex-1 min-h-[44px]"
                  icon={<ArrowLeft className="h-4 w-4" />}
                >
                  Cancel
                </Button>

                <Button
                  type="button"
                  onClick={onCaptureIdAndOcr}
                  disabled={!idWebcam.isActive}
                  className="flex-1 min-h-[44px]"
                  icon={<Camera className="h-4 w-4" />}
                >
                  Capture ID
                </Button>
              </div>
            </div>
          )}

          {/* STEP 3: Local Offline OCR Processing */}
          {step === 'scan-processing' && (
            <div className="flex flex-col items-center justify-center py-12 text-center space-y-4">
              <div className="h-12 w-12 animate-spin rounded-full border-4 border-[var(--color-border)] border-t-[var(--color-brand)]" role="status" aria-label="Reading ID text" />
              <div>
                <h3 className="text-lg font-bold text-[var(--color-text-primary)]">Reading ID Details…</h3>
                <p className="text-sm text-[var(--color-text-secondary)] mt-1">
                  Using local on-device recognition. The ID image is uploaded only to private campus storage upon your review and submission.
                </p>
              </div>
            </div>
          )}

          {/* STEP 4: Form Details (Prefilled if OCR or Blank if Manual) */}
          {step === 'form' && (
            <form onSubmit={handleSubmit(onFormNext)} className="space-y-5" noValidate>
              {ocrSuccessNotice && (
                <div className="rounded-xl border border-[var(--color-brand)]/20 bg-[var(--color-brand-light)] p-3 text-xs text-[var(--color-brand)] flex items-center gap-2">
                  <CheckCircle2 className="h-4 w-4 shrink-0" />
                  <span>ID information detected! Please double-check for accuracy before continuing.</span>
                </div>
              )}

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                <FormField label="First Name" id="kiosk-first-name" error={errors.firstName?.message}>
                  <Input id="kiosk-first-name" {...register('firstName')} error={!!errors.firstName} />
                </FormField>
                <FormField label="Middle Name" id="kiosk-middle-name" hint="Optional" error={errors.middleName?.message}>
                  <Input id="kiosk-middle-name" {...register('middleName')} error={!!errors.middleName} />
                </FormField>
                <FormField label="Last Name" id="kiosk-last-name" error={errors.lastName?.message}>
                  <Input id="kiosk-last-name" {...register('lastName')} error={!!errors.lastName} />
                </FormField>
              </div>

              <FormField label="Contact Number" id="kiosk-phone" hint="Philippine mobile number" error={errors.contactNumber?.message}>
                <Input id="kiosk-phone" type="tel" placeholder="0917 123 4567" {...register('contactNumber')} error={!!errors.contactNumber} />
              </FormField>

              <VisitPurposeField
                purposes={visitPurposes}
                value={purpose}
                error={errors.purpose?.message}
                onChange={(value) => setValue('purpose', value, { shouldDirty: true, shouldValidate: true })}
              />

              <FormField label="Visit Date" id="kiosk-date" error={errors.visitDate?.message}>
                <Input id="kiosk-date" type="date" {...register('visitDate')} min={today} max={latestVisitDate} error={!!errors.visitDate} />
              </FormField>

              {/* Data Privacy Agreement */}
              <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-canvas)] p-4 text-xs text-[var(--color-text-secondary)] space-y-2">
                <p className="font-semibold text-[var(--color-text-primary)]">Data Privacy Notice (RA 10173)</p>
                <p>EARIST collects your photo and visitor information solely for security and campus safety. Information is handled in strict accordance with the Data Privacy Act.</p>
                <label className="flex items-center gap-2 pt-2 border-t border-[var(--color-border)] cursor-pointer">
                  <input type="checkbox" {...register('consent')} className="rounded border-[var(--color-border-strong)] text-[var(--color-brand)] focus:ring-[var(--color-brand)]" />
                  <span className="font-medium text-[var(--color-text-primary)]">I agree to the collection and processing of my data.</span>
                </label>
                {errors.consent && <p className="text-[var(--color-danger)] font-medium">{errors.consent.message}</p>}
              </div>

              <div className="flex gap-3">
                <Button
                  variant="secondary"
                  type="button"
                  onClick={() => {
                    resetCurrentVisitor();
                  }}
                  className="flex-1 min-h-[44px]"
                  icon={<ArrowLeft className="h-4 w-4" />}
                >
                  Back
                </Button>
                <Button type="submit" disabled={!isValid} className="flex-1 min-h-[44px]" icon={<ArrowRight className="h-4 w-4" />}>
                  Next
                </Button>
              </div>
            </form>
          )}

          {/* STEP 5: Face Photo Capture */}
          {step === 'photo' && (
            <div className="space-y-6">
              <div className="text-center">
                <h2 className="text-lg font-bold text-[var(--color-text-primary)]">Take Visitor Photo</h2>
                <p className="text-xs text-[var(--color-text-secondary)] mt-1">Look directly into the camera.</p>
              </div>

              {faceWebcam.error && (
                <div className="rounded-md border border-[var(--color-danger)] bg-[var(--color-danger-light)] p-3 text-sm text-[var(--color-danger-dark)]" role="alert">
                  <p className="font-semibold mb-1">Camera access required</p>
                  <p className="mb-2">{faceWebcam.error}</p>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => faceWebcam.start()}
                    icon={faceWebcam.isStarting ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />}
                    disabled={faceWebcam.isStarting}
                  >
                    {faceWebcam.isStarting ? 'Starting…' : 'Retry Camera'}
                  </Button>
                </div>
              )}

              <div className="mx-auto w-full max-w-xs overflow-hidden rounded-xl border border-[var(--color-border)] shadow-sm bg-black aspect-[3/4] relative">
                {faceWebcam.videoRef && (
                  <>
                    {faceWebcam.isStarting && (
                      <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-black/80 text-white" role="status" aria-live="polite">
                        <Loader2 className="h-8 w-8 animate-spin text-[var(--color-brand)] mb-2" aria-hidden="true" />
                        <span className="text-sm font-medium">Starting camera…</span>
                      </div>
                    )}
                    <video ref={faceWebcam.videoRef} autoPlay playsInline muted className="h-full w-full object-cover" style={{ transform: 'scaleX(-1)' }} />
                  </>
                )}
              </div>

              <div className="flex gap-3">
                <Button variant="secondary" type="button" onClick={() => { faceWebcam.stop(); setStep('form'); }} className="flex-1 min-h-[44px]" icon={<ArrowLeft className="h-4 w-4" />}>
                  Back
                </Button>
                <Button type="button" onClick={onCapturePhoto} disabled={!faceWebcam.isActive} className="flex-1 min-h-[44px]" icon={<Camera className="h-4 w-4" />}>
                  Capture
                </Button>
              </div>
            </div>
          )}

          {/* STEP 6: Camera ID Capture (Only shown when Peak Mode is OFF and ID not yet captured) */}
          {step === 'id' && (
            <div className="space-y-6">
              <div className="text-center">
                <h2 className="text-lg font-bold text-[var(--color-text-primary)]">Capture Valid ID</h2>
                <p className="text-xs text-[var(--color-text-secondary)] mt-1">Position your valid ID clearly in the camera frame.</p>
              </div>
              {idPreview ? (
                <div className="space-y-4">
                  <div className="relative mx-auto max-w-xs overflow-hidden rounded-xl border border-[var(--color-border)] shadow-sm">
                    <img src={idPreview} alt="ID preview" className="w-full object-cover" />
                    <button
                      type="button"
                      onClick={() => {
                        idUrl.clear();
                        setIdBlob(null);
                        idWebcam.start();
                      }}
                      className="absolute right-2 top-2 flex min-h-11 min-w-11 items-center justify-center rounded-full bg-black/60 text-white transition-colors hover:bg-black/80"
                      aria-label="Remove ID image"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                  <div className="flex gap-3">
                    <Button variant="secondary" type="button" onClick={onRetakeId} className="flex-1 min-h-[44px]" icon={<RotateCcw className="h-4 w-4" />}>
                      Retake ID
                    </Button>
                    <Button type="button" onClick={() => setStep('review')} className="flex-1 min-h-[44px]" icon={<ArrowRight className="h-4 w-4" />}>
                      Review
                    </Button>
                  </div>
                </div>
              ) : isProcessingId ? (
                <div className="mx-auto flex w-full max-w-md flex-col items-center justify-center rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] aspect-[3/2] shadow-sm p-6 text-center" role="status" aria-live="polite">
                  <Loader2 className="h-8 w-8 animate-spin text-[var(--color-brand)] mb-3" aria-hidden="true" />
                  <p className="font-semibold text-[var(--color-text-primary)]">Processing ID image…</p>
                </div>
              ) : (
                <div className="space-y-4">
                  {idWebcam.error && (
                    <div className="rounded-md border border-[var(--color-danger)] bg-[var(--color-danger-light)] p-3 text-sm text-[var(--color-danger-dark)]" role="alert">
                      <p className="font-semibold mb-1">Valid ID camera access is required.</p>
                      <p className="mb-2">{idWebcam.error}</p>
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => idWebcam.start()}
                        icon={idWebcam.isStarting ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />}
                        disabled={idWebcam.isStarting}
                      >
                        {idWebcam.isStarting ? 'Starting…' : 'Retry Camera'}
                      </Button>
                    </div>
                  )}

                  <div className="mx-auto w-full max-w-md overflow-hidden rounded-xl border-2 border-dashed border-[var(--color-brand)] shadow-sm bg-black aspect-[3/2] relative flex items-center justify-center">
                    {idWebcam.isStarting && (
                      <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-black/80 text-white" role="status" aria-live="polite">
                        <Loader2 className="h-8 w-8 animate-spin text-[var(--color-brand)] mb-2" aria-hidden="true" />
                        <span className="text-sm font-medium">Starting ID camera…</span>
                      </div>
                    )}
                    {idWebcam.videoRef && (
                      <video ref={idWebcam.videoRef} autoPlay playsInline muted className="h-full w-full object-cover" />
                    )}
                  </div>

                  <div className="flex gap-3">
                    <Button
                      variant="secondary"
                      type="button"
                      onClick={() => {
                        idWebcam.stop();
                        setStep('photo');
                        faceWebcam.start();
                      }}
                      disabled={isProcessingId}
                      className="flex-1 min-h-[44px]"
                      icon={<ArrowLeft className="h-4 w-4" />}
                    >
                      Back
                    </Button>
                    <Button
                      type="button"
                      onClick={onCaptureManualId}
                      disabled={!idWebcam.isActive || isProcessingId}
                      className="flex-1 min-h-[44px]"
                      icon={<Camera className="h-4 w-4" />}
                    >
                      Capture ID
                    </Button>
                  </div>
                  <Button variant="ghost" type="button" onClick={onRetakePhoto} disabled={isProcessingId} className="w-full min-h-[44px]" icon={<RotateCcw className="h-4 w-4" />}>
                    Retake Selfie
                  </Button>
                </div>
              )}
            </div>
          )}

          {/* STEP 7: Review Step */}
          {step === 'review' && (
            <div className="space-y-6">
              <h2 className="text-center text-lg font-bold text-[var(--color-text-primary)]">Review Pass</h2>
              {kioskTransactionRef.current?.phase === 'existing_pass_conflict' ? (
                <div className="rounded-lg border border-amber-300 bg-amber-50 dark:border-amber-700/60 dark:bg-amber-950/40 p-4 space-y-2 text-sm text-amber-900 dark:text-amber-200" role="alert">
                  <div className="flex items-center gap-2 font-semibold text-amber-950 dark:text-amber-100">
                    <AlertCircle className="h-5 w-5 text-amber-600 dark:text-amber-400 shrink-0" />
                    <span>Existing Pass Detected</span>
                  </div>
                  <p>
                    An existing pass was already created for this request, but the local retry no longer matches it. Do not create another pass. Please ask the Guard for assistance.
                  </p>
                </div>
              ) : kioskTransactionRef.current?.phase === 'ambiguous' ? (
                <div className="rounded-lg border border-amber-300 bg-amber-50 dark:border-amber-700/60 dark:bg-amber-950/40 p-4 space-y-2 text-sm text-amber-900 dark:text-amber-200" role="alert">
                  <div className="flex items-center gap-2 font-semibold text-amber-950 dark:text-amber-100">
                    <AlertCircle className="h-5 w-5 text-amber-600 dark:text-amber-400 shrink-0" />
                    <span>Generation result could not be confirmed</span>
                  </div>
                  <p>
                    The previous submission may already have created a pass. To prevent duplicates, the exact previous submission must be retried before any details can be changed.
                  </p>
                  <p className="text-xs text-amber-800 dark:text-amber-300">
                    Retry Exact Submission resubmits the exact previous attempt without altering your identity or evidence.
                  </p>
                </div>
              ) : submitError ? (
                <div className="rounded-md border border-[var(--color-danger)] bg-[var(--color-danger-light)] p-3 text-sm text-[var(--color-danger-dark)]" role="alert">{submitError}</div>
              ) : null}
              
              <div className="flex flex-wrap gap-6 justify-center items-center py-2">
                {photoPreview && (
                  <div className="text-center">
                    <p className="text-xs text-[var(--color-text-secondary)] mb-1">Face Photo</p>
                    <img src={photoPreview} alt="Face photo" className="h-24 w-20 object-cover rounded-lg border border-[var(--color-border)] shadow-sm mx-auto" />
                    {kioskTransactionRef.current?.phase !== 'ambiguous' && kioskTransactionRef.current?.phase !== 'existing_pass_conflict' && (
                      <button
                        type="button"
                        onClick={onRetakePhoto}
                        className="mt-1.5 text-xs font-semibold text-[var(--color-brand)] hover:underline inline-flex items-center gap-1"
                      >
                        <RotateCcw className="h-3 w-3" />
                        Retake Selfie
                      </button>
                    )}
                  </div>
                )}
                {idPreview && !isPeakMode ? (
                  <div className="text-center">
                    <p className="text-xs text-[var(--color-text-secondary)] mb-1">ID Card</p>
                    <img src={idPreview} alt="ID preview" className="h-24 w-36 object-cover rounded-lg border border-[var(--color-border)] shadow-sm mx-auto" />
                    {kioskTransactionRef.current?.phase !== 'ambiguous' && kioskTransactionRef.current?.phase !== 'existing_pass_conflict' && (
                      <button
                        type="button"
                        onClick={onRetakeId}
                        className="mt-1.5 text-xs font-semibold text-[var(--color-brand)] hover:underline inline-flex items-center gap-1"
                      >
                        <RotateCcw className="h-3 w-3" />
                        Retake ID
                      </button>
                    )}
                  </div>
                ) : isPeakMode ? (
                  <div className="text-center">
                    <p className="text-xs text-[var(--color-text-secondary)] mb-1">ID Card</p>
                    <div className="flex h-24 w-36 items-center justify-center rounded-lg border border-dashed border-[var(--color-border)] bg-[var(--color-canvas-subtle)] p-2 text-center text-xs text-[var(--color-text-secondary)]">
                      No ID required (Peak Mode)
                    </div>
                  </div>
                ) : null}
              </div>

              <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-canvas)] p-4 text-sm">
                <div className="flex items-center justify-between mb-2">
                  <p><strong className="text-[var(--color-text-secondary)]">Name:</strong> {[getValues('firstName'), getValues('middleName'), getValues('lastName')].filter(Boolean).join(' ')}</p>
                  {kioskTransactionRef.current?.phase !== 'ambiguous' && kioskTransactionRef.current?.phase !== 'existing_pass_conflict' && (
                    <button
                      type="button"
                      onClick={() => {
                        faceWebcam.stop();
                        idWebcam.stop();
                        setStep('form');
                      }}
                      className="text-xs font-semibold text-[var(--color-brand)] hover:underline"
                    >
                      Edit Details
                    </button>
                  )}
                </div>
                <p className="mb-2"><strong className="text-[var(--color-text-secondary)]">Visit Date:</strong> {getValues('visitDate')}</p>
                <p><strong className="text-[var(--color-text-secondary)]">Purpose:</strong> {getValues('purpose')}</p>
              </div>

              {kioskTransactionRef.current?.phase === 'existing_pass_conflict' ? (
                <div className="flex flex-col gap-3">
                  <Button
                    variant="secondary"
                    type="button"
                    onClick={handleAmbiguousCancelAndAskGuard}
                    className="w-full min-h-[44px] text-amber-700 dark:text-amber-300 border-amber-300 dark:border-amber-700"
                    icon={<AlertCircle className="h-4 w-4" />}
                  >
                    Cancel & Ask Guard
                  </Button>
                </div>
              ) : kioskTransactionRef.current?.phase === 'ambiguous' ? (
                <div className="flex flex-col sm:flex-row gap-3">
                  <Button
                    variant="secondary"
                    type="button"
                    onClick={handleAmbiguousCancelAndAskGuard}
                    className="flex-1 min-h-[44px] text-amber-700 dark:text-amber-300 border-amber-300 dark:border-amber-700"
                    icon={<AlertCircle className="h-4 w-4" />}
                  >
                    Cancel & Ask Guard
                  </Button>
                  <Button
                    type="button"
                    onClick={onSubmit}
                    className="flex-1 min-h-[44px]"
                    icon={<RefreshCw className="h-4 w-4" />}
                  >
                    Retry Exact Submission
                  </Button>
                </div>
              ) : (
                <div className="flex flex-col sm:flex-row gap-3">
                  <Button
                    variant="secondary"
                    type="button"
                    onClick={() => {
                      faceWebcam.stop();
                      idWebcam.stop();
                      setStep('form');
                    }}
                    className="flex-1 min-h-[44px]"
                    icon={<ArrowLeft className="h-4 w-4" />}
                  >
                    Edit Details
                  </Button>
                  <Button type="button" onClick={onSubmit} className="flex-1 min-h-[44px]" icon={<CheckCircle2 className="h-4 w-4" />}>
                    Generate Pass
                  </Button>
                </div>
              )}
            </div>
          )}

          {/* STEP 8: Generating Spinner */}
          {step === 'generating' && (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <div className="mb-6 h-12 w-12 animate-spin rounded-full border-4 border-[var(--color-border)] border-t-[var(--color-brand)]" role="status" aria-label="Generating gate pass" />
              <p className="text-xl font-bold text-[var(--color-text-primary)]">Generating gate pass…</p>
            </div>
          )}

          {/* STEP 9: Done / Pass Card Display */}
          {step === 'done' && currentPassPresentation && qrDataUrl && (
            <div className="space-y-6 text-center print:text-left print:m-0 print:space-y-2">
              <div className="mx-auto mb-2 flex h-16 w-16 items-center justify-center rounded-full bg-[var(--color-success-light)] text-[var(--color-success)] print:hidden">
                <CheckCircle2 className="h-8 w-8" />
              </div>
              
              <h2 className="text-2xl font-bold text-[var(--color-text-primary)] print:hidden">Gate Pass Created</h2>

              {printFailed && (
                <div className="rounded-xl border border-[var(--color-warning)] bg-[var(--color-warning-light)] p-4 text-sm text-[var(--color-warning-dark)] print:hidden flex flex-col sm:flex-row items-center justify-between gap-3 text-left">
                  <div className="flex items-center gap-2">
                    <AlertCircle className="h-5 w-5 shrink-0" />
                    <span>Thermal printer unavailable. Pass was successfully created.</span>
                  </div>
                  <div className="flex gap-2">
                    <Button size="sm" variant="secondary" onClick={() => void handlePrint()}>
                      Print Again
                    </Button>
                    <Button size="sm" variant="secondary" onClick={() => window.print()}>
                      Browser Print
                    </Button>
                  </div>
                </div>
              )}

              <div className="flex justify-center">
                <InstitutionalPassCard pass={currentPassPresentation} qrDataUrl={qrDataUrl} />
              </div>

              <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-canvas)] p-4 text-left text-sm print:hidden">
                <p className="mb-1"><strong className="text-[var(--color-text-secondary)]">Purpose:</strong> {getValues('purpose')}</p>
                <p><strong className="text-[var(--color-text-secondary)]">Valid:</strong> {issuedValidity || formatWorkingHours(workingHours)}</p>
              </div>

              <div className="flex flex-wrap gap-3 print:hidden">
                <Button
                  variant="secondary"
                  type="button"
                  onClick={() => void handlePrint()}
                  disabled={isPrinting}
                  className="flex-1 min-h-[44px]"
                  icon={<Printer className="h-4 w-4" />}
                >
                  {isPrinting ? 'Printing…' : printerStatus === 'connected' ? 'Print Pass (MXW01)' : 'Print Pass'}
                </Button>
                <Button variant="secondary" type="button" onClick={() => setShowEmailModal(true)} className="flex-1 min-h-[44px]" icon={<Mail className="h-4 w-4" />}>
                  Email my QR code
                </Button>
                <Button type="button" onClick={handleNextVisitor} className="flex-1 min-h-[44px]">
                  Next Visitor
                </Button>
              </div>
            </div>
          )}
            </>
          )}
        </Card>

        <Modal
          isOpen={showSignOutConfirm}
          onClose={() => {
            if (!isSigningOut) setShowSignOutConfirm(false);
          }}
          title="Sign Out of Kiosk?"
        >
          <div className="space-y-4">
            <p className="text-sm text-[var(--color-text-secondary)]">
              Are you sure you want to sign out this kiosk device? An administrator will need to sign in again to re-enable walk-in registrations.
            </p>
            <div className="flex justify-end gap-3 pt-2">
              <Button
                variant="secondary"
                onClick={() => setShowSignOutConfirm(false)}
                disabled={isSigningOut}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                onClick={handleSignOut}
                loading={isSigningOut}
                disabled={isSigningOut}
              >
                {isSigningOut ? 'Signing out…' : 'Sign Out Device'}
              </Button>
            </div>
          </div>
        </Modal>

        {showEmailModal && passId && rawQrToken && (
          <EmailPassModal
            isOpen={showEmailModal}
            onClose={() => setShowEmailModal(false)}
            passId={passId}
            qrToken={rawQrToken}
            source="kiosk"
          />
        )}

        <KioskPrinterSettingsModal
          isOpen={showPrinterSettings}
          onClose={() => setShowPrinterSettings(false)}
        />
      </div>
    </main>
  );
}
