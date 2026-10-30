import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useWebcam } from '@/hooks/useWebcam';
import { useObjectUrl } from '@/hooks/useObjectUrl';
import { useBuildVersion } from '@/hooks/useBuildVersion';
import { normalizeIdentityDocumentImage } from '@/lib/imageProcessing';
import {
  issueVisitorPass,
  loadRegistrationSettings,
  createPortalIssueTransaction,
  uploadCheckpointedEvidence,
  verifyPortalIdentity,
  preflightLiveFace,
  type PortalIssueTransaction,
} from '@/services/visitorRegistration';
import { TurnstileWidget } from '@/components/TurnstileWidget';
import { generateBrandedQrDataUrl } from '@/lib/brandedQr';
import QRCode from 'qrcode';
import { recognizeIdImage, terminateLocalOcrWorker } from '@/lib/ocr';
import { evaluateLiveFaceQuality, evaluateIdImageQuality } from '@/lib/imageQuality';
import {
  Camera,
  CheckCircle2,
  Download,
  ArrowLeft,
  ArrowRight,
  RotateCcw,
  Mail,
  Loader2,
  RefreshCw,
  AlertCircle,
  Upload,
  Info,
  Sparkles,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button, Card, Input, FormField, Stepper, PageShell } from '@/components/ui';
import { EmailPassModal } from '@/components/EmailPassModal';
import { TimedSkipWarningModal } from '@/components/TimedSkipWarningModal';
import { VisitPurposeField } from '@/components/VisitPurposeField';
import { DEFAULT_VISIT_PURPOSES, normalizeVisitPurposes } from '@/lib/settingsDefaults';
import type { VisitPurposeOption } from '@/types';
import { DEFAULT_WORKING_HOURS, formatValidityWindow, formatWorkingHours, MAX_VISIT_ADVANCE_DAYS, normalizeWorkingHours } from '@/lib/workingHours';
import { getManilaDateString, getLatestVisitDateString, validateVisitDate } from '@/lib/scheduling';
import { createPassPresentation, type PassPresentation, renderPassCardToDataUrl } from '@/lib/passPresentation';
import { InstitutionalPassCard } from '@/components/InstitutionalPassCard';

const MAX_RAW_ID_FILE_BYTES = 10 * 1024 * 1024;

// ============================================================
// FORM SCHEMA (Zod)
// ============================================================
const nameRegex = /^[\p{L}\s\-'.]+$/u;

export function createGetPassSchema(schedulingDaysAhead: number = MAX_VISIT_ADVANCE_DAYS) {
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
      message: 'You must accept the Data Privacy Act notice to proceed',
    }),
  });
}

export type GetPassFormData = z.infer<ReturnType<typeof createGetPassSchema>>;

type Step = 'form' | 'photo' | 'id' | 'verify' | 'review' | 'generating' | 'delivery' | 'done';

// ============================================================
// COMPONENT
// ============================================================
export function GetPassPage() {
  const { updateAvailable, reloadApp } = useBuildVersion();
  const [step, setStep] = useState<Step>('form');

  // Live Face State (Single custom camera)
  const [photoBlob, setPhotoBlob] = useState<Blob | null>(null);
  const photoUrl = useObjectUrl();
  const photoPreview = photoUrl.url;
  const [liveFaceQualityError, setLiveFaceQualityError] = useState<string | null>(null);
  const [isEvaluatingFaceQuality, setIsEvaluatingFaceQuality] = useState(false);

  // Valid ID State (File picker only, no custom camera)
  const [idBlob, setIdBlob] = useState<Blob | null>(null);
  const idUrl = useObjectUrl();
  const idPreview = idUrl.url;
  const [idQualityError, setIdQualityError] = useState<string | null>(null);
  const [isProcessingId, setIsProcessingId] = useState(false);
  const [idReusedFromOcr, setIdReusedFromOcr] = useState(false);
  const idFileInputRef = useRef<HTMLInputElement>(null);

  // Optional OCR State (File picker only, no custom camera)
  const [isProcessingOcr, setIsProcessingOcr] = useState(false);
  const [ocrSuccessNotice, setOcrSuccessNotice] = useState<string | null>(null);
  const ocrFileInputRef = useRef<HTMLInputElement>(null);
  const ocrGenerationRef = useRef(0);

  // Identity Verification State
  const [isVerifyingIdentity, setIsVerifyingIdentity] = useState(false);
  const [identityVerified, setIdentityVerified] = useState(false);
  const [verificationError, setVerificationError] = useState<string | null>(null);

  // Turnstile & Pass State
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [turnstileKey, setTurnstileKey] = useState(0);

  function resetTurnstile() {
    setCaptchaToken(null);
    setTurnstileKey((prev) => prev + 1);
  }

  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [passId, setPassId] = useState<string | null>(null);
  const [passPresentation, setPassPresentation] = useState<PassPresentation | null>(null);
  const [rawQrToken, setRawQrToken] = useState<string | null>(null);
  const [showEmailModal, setShowEmailModal] = useState(false);
  const [showSkipWarning, setShowSkipWarning] = useState(false);
  const [emailDeliverySecured, setEmailDeliverySecured] = useState(false);
  const [emailSkipped, setEmailSkipped] = useState(false);
  const [emailOutcomeUnknown, setEmailOutcomeUnknown] = useState(false);
  const [isDownloaded, setIsDownloaded] = useState(false);

  const [submitError, setSubmitError] = useState<string | null>(null);
  type RegistrationConfigState = 'loading' | 'ready' | 'error';
  const [configState, setConfigState] = useState<RegistrationConfigState>('loading');
  const [isRetryingConfig, setIsRetryingConfig] = useState(false);
  const [photoRetentionDays, setPhotoRetentionDays] = useState<number | null>(null);
  const [idRetentionDays, setIdRetentionDays] = useState<number | null>(null);
  const [visitorRetentionDays, setVisitorRetentionDays] = useState<number | null>(null);

  const [visitPurposes, setVisitPurposes] = useState<VisitPurposeOption[]>(DEFAULT_VISIT_PURPOSES);
  const [workingHours, setWorkingHours] = useState(DEFAULT_WORKING_HOURS);
  const [schedulingDaysAhead, setSchedulingDaysAhead] = useState(MAX_VISIT_ADVANCE_DAYS);
  const issueRequestId = useRef(crypto.randomUUID());
  const portalTransactionRef = useRef<PortalIssueTransaction | null>(null);
  const livePhotoIntentIdRef = useRef<string | null>(null);

  const [visitorInstructions, setVisitorInstructions] = useState<string[]>([
    'Follow the EARIST visitor dress code and campus policies.',
    'Bring a valid ID for identity verification at the gate.',
    'Keep your E-GatePass ready before approaching the entrance.',
    'This visitor pass is personal and non-transferable.',
    'Scan your E-GatePass when leaving the campus.',
  ]);

  function onRetakeId() {
    setIdBlob(null);
    idUrl.clear();
    setIdReusedFromOcr(false);
    setIdentityVerified(false);
  }

  function resetRegistrationFlow() {
    ocrGenerationRef.current += 1;
    void terminateLocalOcrWorker();
    livePhotoIntentIdRef.current = null;
    setStep('form');
    setPhotoBlob(null);
    setIdBlob(null);
    photoUrl.clear();
    idUrl.clear();
    setIdentityVerified(false);
    setIdReusedFromOcr(false);
  }

  // Unmount cleanup for OCR worker
  useEffect(() => {
    return () => {
      ocrGenerationRef.current += 1;
      void terminateLocalOcrWorker();
    };
  }, []);

  const loadConfig = useCallback(async (isRetry = false) => {
    if (isRetry) setIsRetryingConfig(true);
    else setConfigState('loading');
    try {
      const data = await loadRegistrationSettings('portal');
      setVisitPurposes(normalizeVisitPurposes(data.visit_purposes));
      setWorkingHours(
        normalizeWorkingHours({
          start: data.working_hours_start?.slice(0, 5),
          end: data.working_hours_end?.slice(0, 5),
          timezone: data.timezone,
        })
      );
      if (Number.isInteger(data.scheduling_days_ahead)) {
        setSchedulingDaysAhead(data.scheduling_days_ahead!);
      }
      if (typeof data.photo_retention_days === 'number') setPhotoRetentionDays(data.photo_retention_days);
      if (typeof data.id_retention_days === 'number') setIdRetentionDays(data.id_retention_days);
      if (typeof data.visitor_retention_days === 'number') setVisitorRetentionDays(data.visitor_retention_days);
      if (Array.isArray(data.visitor_instructions) && data.visitor_instructions.length > 0) {
        setVisitorInstructions(data.visitor_instructions);
      }
      setConfigState('ready');
    } catch (err) {
      console.error('Failed to load portal registration settings:', err);
      setConfigState('error');
    } finally {
      setIsRetryingConfig(false);
    }
  }, []);

  useEffect(() => {
    void loadConfig();
  }, [loadConfig]);

  // SINGLE CAMERA RULE: Live face camera is the ONLY custom camera in the entire flow
  const faceWebcam = useWebcam({ facingMode: 'user', width: 640, height: 480, allowCaptureMirroring: false });

  useEffect(() => {
    return () => {
      faceWebcam.stop();
    };
  }, []);

  // Accidental refresh/close protection before pass delivery is secured
  const isDeliverySecured = emailDeliverySecured || isDownloaded;
  useEffect(() => {
    if (!passId || isDeliverySecured) return;

    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, [passId, isDeliverySecured]);

  const formSchema = useMemo(() => createGetPassSchema(schedulingDaysAhead), [schedulingDaysAhead]);

  const {
    register,
    handleSubmit,
    getValues,
    setValue,
    watch,
    formState: { errors, isValid },
  } = useForm<GetPassFormData>({
    resolver: zodResolver(formSchema),
    mode: 'onChange',
    defaultValues: { purpose: '' },
  });
  const purpose = watch('purpose');

  // Manila-aware calendar date limits
  const today = getManilaDateString();
  const latestVisitDate = getLatestVisitDateString(today, schedulingDaysAhead);

  // ============================================================
  // STEP 1: FORM & OPTIONAL OCR
  // ============================================================
  function onFormNext(data: GetPassFormData) {
    void data;
    setStep('photo');
    void faceWebcam.start();
  }

  async function handleOcrFileSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    const allowedTypes = ['image/jpeg', 'image/png', 'image/webp'];
    if (!allowedTypes.includes(file.type)) {
      toast.error('This image format is not supported. Please choose a JPEG, PNG, or WebP image.');
      return;
    }

    if (file.size > MAX_RAW_ID_FILE_BYTES) {
      toast.error('This image is too large to process safely. Please choose an image 10 MB or smaller.');
      return;
    }

    const generation = ++ocrGenerationRef.current;
    setIsProcessingOcr(true);
    setOcrSuccessNotice(null);

    try {
      // 1. Normalize and store ID image so it can be reused later
      const normalized = await normalizeIdentityDocumentImage(file);
      if (generation !== ocrGenerationRef.current) return;

      setIdBlob(normalized);
      idUrl.setFromBlob(normalized);
      setIdReusedFromOcr(true);
      setIdQualityError(null);

      // Invalidate existing verified state if ID changes
      setIdentityVerified(false);

      // 2. Perform local OCR recognition in browser memory
      const parsed = await recognizeIdImage(file);
      if (generation !== ocrGenerationRef.current) return;

      // 3. Prefill empty fields, preserving user-entered values
      const currentValues = getValues();
      let filledCount = 0;

      if (!currentValues.firstName?.trim() && parsed.firstName) {
        setValue('firstName', parsed.firstName, { shouldValidate: true });
        filledCount++;
      }
      if (!currentValues.middleName?.trim() && parsed.middleName) {
        setValue('middleName', parsed.middleName, { shouldValidate: true });
        filledCount++;
      }
      if (!currentValues.lastName?.trim() && parsed.lastName) {
        setValue('lastName', parsed.lastName, { shouldValidate: true });
        filledCount++;
      }

      if (filledCount > 0) {
        setOcrSuccessNotice('Information autofilled from your ID. ID image saved for verification.');
        toast.success('Information autofilled from your ID.');
      } else {
        setOcrSuccessNotice('ID image saved. Please check and enter your name details manually.');
        toast.info('ID image saved. You can enter or confirm your name details.');
      }
    } catch (err) {
      if (generation !== ocrGenerationRef.current) return;
      console.warn('OCR processing failure:', err);
      toast.info('Automatic text recognition skipped. Your ID image was saved for later verification.');
    } finally {
      if (generation === ocrGenerationRef.current) {
        setIsProcessingOcr(false);
      }
    }
  }

  // ============================================================
  // STEP 2: LIVE FACE CAPTURE & QUALITY GATE
  // ============================================================
  function onCaptureLivePhoto() {
    const blob = faceWebcam.capture({ mirror: false });
    if (blob) {
      setPhotoBlob(blob);
      photoUrl.setFromBlob(blob);
      setLiveFaceQualityError(null);
      setIdentityVerified(false);
      livePhotoIntentIdRef.current = null;
      faceWebcam.stop();
    } else {
      toast.error('Failed to capture photo. Please hold steady and try again.');
    }
  }

  function onRetakeLivePhoto() {
    photoUrl.clear();
    setPhotoBlob(null);
    setLiveFaceQualityError(null);
    setIdentityVerified(false);
    livePhotoIntentIdRef.current = null;
    faceWebcam.stop();
    setStep('photo');
    void faceWebcam.start();
  }

  async function onConfirmLivePhoto() {
    if (!photoBlob) return;
    setIsEvaluatingFaceQuality(true);
    setLiveFaceQualityError(null);

    try {
      // 1. Client-side technical checks first
      const evaluation = await evaluateLiveFaceQuality(photoBlob);
      if (!evaluation.passed) {
        setLiveFaceQualityError(evaluation.message);
        toast.error(evaluation.message);
        return;
      }

      // 2. Prepare transaction & upload live photo intent for trusted server preflight
      if (!portalTransactionRef.current) {
        portalTransactionRef.current = await createPortalIssueTransaction();
        issueRequestId.current = portalTransactionRef.current.requestId as ReturnType<typeof crypto.randomUUID>;
      }

      const tx = portalTransactionRef.current;
      const { client } = await import('@/lib/supabase').then((m) => ({ client: m.supabase }));
      if (!client) throw new Error('Supabase client unavailable');

      if (!livePhotoIntentIdRef.current) {
        const photoRes = await uploadCheckpointedEvidence(client, 'portal', 'photo', photoBlob, tx);
        livePhotoIntentIdRef.current = photoRes.intentId;
      }

      // 3. Call trusted server face-presence/geometry preflight
      const preflight = await preflightLiveFace(client, tx.requestId, livePhotoIntentIdRef.current);
      if (!preflight.ok) {
        setLiveFaceQualityError(preflight.message || 'Face presence check failed. Please ensure your face is clearly visible.');
        toast.error(preflight.message || 'Face presence check failed.');
        return;
      }

      // Passed Live Face quality gate and server preflight -> continue to Valid ID step
      setStep('id');
    } catch (err: any) {
      console.warn('Live face quality check error:', err);
      setLiveFaceQualityError(err?.message || 'Could not verify photo quality. Please retake under good lighting.');
    } finally {
      setIsEvaluatingFaceQuality(false);
    }
  }

  // ============================================================
  // STEP 3: VALID ID & QUALITY GATE
  // ============================================================
  async function handleIdFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    const allowedTypes = ['image/jpeg', 'image/png', 'image/webp'];
    if (!allowedTypes.includes(file.type)) {
      toast.error('This image format is not supported. Please choose a JPEG, PNG, or WebP image.');
      return;
    }

    if (file.size > MAX_RAW_ID_FILE_BYTES) {
      toast.error('This image is too large to process safely. Please choose an image 10 MB or smaller.');
      return;
    }

    setIsProcessingId(true);
    setIdQualityError(null);
    setIdentityVerified(false);

    try {
      const normalized = await normalizeIdentityDocumentImage(file);
      const quality = await evaluateIdImageQuality(normalized);
      if (!quality.passed) {
        setIdQualityError(quality.message);
        toast.error(quality.message);
        return;
      }

      setIdBlob(normalized);
      idUrl.setFromBlob(normalized);
      setIdReusedFromOcr(false);
      toast.success('Valid ID added successfully.');
    } catch {
      toast.error('The selected file could not be processed as an image.');
    } finally {
      setIsProcessingId(false);
    }
  }

  function onConfirmValidId() {
    if (!idBlob) {
      toast.error('Please provide a valid ID image to proceed.');
      return;
    }
    setStep('verify');
    void runIdentityVerification();
  }

  // ============================================================
  // STEP 4: IDENTITY VERIFICATION PIPELINE
  // ============================================================
  async function runIdentityVerification() {
    if (!photoBlob || !idBlob) {
      setStep('photo');
      return;
    }

    setIsVerifyingIdentity(true);
    setVerificationError(null);

    try {
      // 1. Obtain authenticated portal session / transaction
      if (!portalTransactionRef.current) {
        portalTransactionRef.current = await createPortalIssueTransaction();
        issueRequestId.current = portalTransactionRef.current.requestId as ReturnType<typeof crypto.randomUUID>;
      }

      const tx = portalTransactionRef.current;
      const { client } = await import('@/lib/supabase').then((m) => ({ client: m.supabase }));
      if (!client) throw new Error('Supabase client unavailable');

      // 2. Upload photo and ID to storage checkpoints (reuse preflight photo intent if available)
      const photoIntentId = livePhotoIntentIdRef.current
        ? livePhotoIntentIdRef.current
        : (await uploadCheckpointedEvidence(client, 'portal', 'photo', photoBlob, tx)).intentId;

      const idRes = await uploadCheckpointedEvidence(client, 'portal', 'id', idBlob, tx);

      // 3. Call server identity verification endpoint
      const result = await verifyPortalIdentity(client, tx.requestId, photoIntentId, idRes.intentId);

      if (result.outcome === 'matched') {
        setIdentityVerified(true);
        setVerificationError(null);
        toast.success('Identity verified successfully!');
      } else {
        setIdentityVerified(false);
        setVerificationError(
          result.message ||
            'The face in your live photo could not be matched with the portrait on your ID. Please ensure your ID image is clear and you are using your own document.'
        );
      }
    } catch (err: any) {
      console.error('Identity verification failed:', err);
      setIdentityVerified(false);
      setVerificationError(
        err?.message || 'We could not complete identity verification. Please ensure steady lighting and clear images.'
      );
    } finally {
      setIsVerifyingIdentity(false);
    }
  }

  // Start Over is disabled during ambiguous issuance to prevent duplicate passes.
  // Outside ambiguous phase, handleStartOver resets form and generates fresh transaction.
  function handleStartOver() {
    portalTransactionRef.current = null;
    livePhotoIntentIdRef.current = null;
    issueRequestId.current = crypto.randomUUID();
    resetRegistrationFlow();
  }

  function handleAmbiguousCancelAndAskGuard() {
    toast.info('Submission cancelled. The previous pass may have been created. Please proceed to the Guard Station with your valid ID for assistance.');
    setStep('form');
  }

  function handleRetryExactSubmission() {
    void onSubmit();
  }

  // ============================================================
  // STEP 5: REVIEW & PASS ISSUANCE
  // ============================================================
  async function onSubmit() {
    if (portalTransactionRef.current?.phase === 'existing_pass_conflict') {
      toast.error('An existing pass was already created for this request. Please ask the Guard for assistance.');
      return;
    }

    if (!identityVerified) {
      toast.error('Identity verification is required before generating a pass.');
      setStep('verify');
      return;
    }

    if (!photoBlob || !idBlob) {
      toast.error('Evidence photos are required.');
      return;
    }

    setStep('generating');
    setSubmitError(null);

    try {
      const formData = getValues();
      if (!portalTransactionRef.current) {
        portalTransactionRef.current = await createPortalIssueTransaction(captchaToken ?? undefined);
        issueRequestId.current = portalTransactionRef.current.requestId as ReturnType<typeof crypto.randomUUID>;
      }

      const result = await issueVisitorPass('portal', formData, photoBlob, idBlob, issueRequestId.current, captchaToken ?? undefined, portalTransactionRef.current);

      setPassId(result.passId);
      setRawQrToken(result.qrToken);
      const validity = result.validFrom && result.validUntil
        ? formatValidityWindow(result.validFrom, result.validUntil)
        : formatWorkingHours(workingHours);

      let qrUrl: string | null = null;
      try {
        qrUrl = await generateBrandedQrDataUrl(result.qrToken, { size: 360 });
      } catch (qrErr) {
        console.warn('Branded QR generation failed, falling back to standard QR:', qrErr);
        try {
          qrUrl = await QRCode.toDataURL(result.qrToken, { width: 360, margin: 2, errorCorrectionLevel: 'H' });
        } catch (fallbackErr) {
          console.error('Standard QR generation fallback failed:', fallbackErr);
        }
      }

      setQrDataUrl(qrUrl);

      const effectiveVisitor = portalTransactionRef.current?.submittedPayload?.visitor ?? formData;
      const presentation = createPassPresentation({
        firstName: effectiveVisitor.firstName,
        middleName: effectiveVisitor.middleName,
        lastName: effectiveVisitor.lastName,
        visitDate: effectiveVisitor.visitDate,
        passReference: result.publicReference || result.passId,
        qrToken: result.qrToken,
        validityWindow: validity,
        purpose: effectiveVisitor.purpose,
      });
      setPassPresentation(presentation);

      setEmailDeliverySecured(false);
      setIsDownloaded(false);

      setStep('delivery');
      setShowEmailModal(true);
      toast.success('Gate pass generated successfully!');
    } catch (err) {
      console.error('Pass generation error:', err);
      const errMsg = err instanceof Error ? err.message : 'An unexpected error occurred.';
      setSubmitError(errMsg);
      setStep('review');
      toast.error('Failed to generate pass. Please try again.');
    } finally {
      resetTurnstile();
    }
  }

  // ============================================================
  // DOWNLOAD QR
  // ============================================================
  async function handleDownload() {
    if (!passPresentation) {
      toast.error('Your E-GatePass image could not be prepared. Please try again.');
      return;
    }
    try {
      const passCardDataUrl = await renderPassCardToDataUrl(passPresentation, { qrDataUrl: qrDataUrl || undefined });
      const link = document.createElement('a');
      link.download = `egatepass-${passPresentation.passReference}.png`;
      link.href = passCardDataUrl;
      link.click();
      setIsDownloaded(true);
      toast.success('Official gate pass downloaded!');
    } catch (err) {
      console.error('Pass card rendering error:', err);
      if (qrDataUrl) {
        const link = document.createElement('a');
        link.download = `egatepass-qr-${passPresentation.passReference}.png`;
        link.href = qrDataUrl;
        link.click();
        setIsDownloaded(true);
        toast.info('QR Code image downloaded.');
      } else {
        toast.error('Failed to generate pass image. Please try again.');
      }
    }
  }

  const steps = [
    { id: 'form', title: 'Details' },
    { id: 'photo', title: 'Live Face' },
    { id: 'id', title: 'Valid ID' },
    { id: 'verify', title: 'Verify' },
    { id: 'review', title: 'Review' },
  ];

  const currentStepIndex =
    step === 'done' || step === 'delivery' || step === 'generating'
      ? steps.length
      : steps.findIndex((s) => s.id === step);

  return (
    <PageShell>
      {/* Stale Client Non-Destructive Update Banner */}
      {updateAvailable && (
        <div className="mb-6 flex items-center justify-between gap-4 rounded-xl border border-amber-300 bg-amber-50 p-4 text-xs text-amber-900 shadow-sm" role="alert">
          <div className="flex items-center gap-2">
            <RefreshCw className="h-4 w-4 text-amber-600 animate-spin" />
            <span>A newer version of E-GatePass is available. You can update now without losing your current session.</span>
          </div>
          <Button size="sm" variant="secondary" onClick={reloadApp}>
            Update Now
          </Button>
        </div>
      )}

      {configState === 'loading' && (
        <div className="py-24 text-center">
          <Loader2 className="mx-auto h-10 w-10 animate-spin text-[var(--color-brand)]" />
          <p className="mt-4 text-base font-semibold text-[var(--color-text-primary)]">Preparing visitor registration…</p>
          <p className="mt-1 text-sm text-[var(--color-text-secondary)]">Loading visit options and campus schedule.</p>
        </div>
      )}

      {configState === 'error' && (
        <div className="rounded-2xl border border-[var(--color-danger)] bg-white p-8 text-center shadow-xs max-w-lg mx-auto">
          <AlertCircle className="mx-auto h-12 w-12 text-[var(--color-danger)]" />
          <h2 className="mt-4 text-lg font-bold text-[var(--color-text-primary)]">Visitor registration unavailable</h2>
          <p className="mt-1 text-sm text-[var(--color-text-secondary)]">
            Campus visit settings could not be loaded. Please check your network and try again.
          </p>
          <div className="mt-6 flex justify-center">
            <Button onClick={() => loadConfig(true)} loading={isRetryingConfig}>
              {isRetryingConfig ? 'Retrying…' : 'Try Again'}
            </Button>
          </div>
        </div>
      )}

      {configState === 'ready' && (
        <Card className="max-w-2xl mx-auto p-6 sm:p-8">
          {step !== 'done' && step !== 'delivery' && step !== 'generating' && (
            <Stepper steps={steps} currentStepIndex={currentStepIndex} className="mb-8 px-4" />
          )}

        {/* ============================== STEP 1: FORM ============================== */}
        {step === 'form' && (
          <form onSubmit={handleSubmit(onFormNext)} className="space-y-6">
            <div className="text-center">
              <h2 className="text-lg font-bold text-[var(--color-text-primary)]">Visitor Details</h2>
              <p className="text-sm text-[var(--color-text-secondary)] mt-1">
                Enter your information or optionally upload your ID image to autofill details.
              </p>
            </div>

            {/* Optional OCR Autofill Control */}
            <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-canvas)] p-4">
              <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
                <div className="space-y-0.5">
                  <div className="flex items-center gap-1.5 font-bold text-xs text-[var(--color-text-primary)]">
                    <Sparkles className="h-4 w-4 text-[var(--color-brand)]" />
                    <span>Autofill from ID (Optional)</span>
                  </div>
                  <p className="text-xs text-[var(--color-text-secondary)]">
                    Upload an ID image to attempt autofilling your name. (OCR is optional; failure does not stop registration).
                  </p>
                </div>

                <input
                  id="ocr-file-upload"
                  ref={ocrFileInputRef}
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  onChange={handleOcrFileSelected}
                  className="hidden"
                />

                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  aria-label="Autofill from ID"
                  onClick={() => ocrFileInputRef.current?.click()}
                  disabled={isProcessingOcr}
                  icon={isProcessingOcr ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
                >
                  {isProcessingOcr ? 'Scanning ID…' : 'Upload ID Image'}
                </Button>
              </div>

              {ocrSuccessNotice && (
                <div className="mt-3 flex items-center gap-2 rounded-lg bg-emerald-50 border border-emerald-200 p-2.5 text-xs text-emerald-800">
                  <CheckCircle2 className="h-4 w-4 text-emerald-600 flex-shrink-0" />
                  <span>{ocrSuccessNotice}</span>
                </div>
              )}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <FormField label="First Name" id="first-name" requirement="required" error={errors.firstName?.message}>
                <Input id="first-name" placeholder="Juan" {...register('firstName')} error={Boolean(errors.firstName)} />
              </FormField>
              <FormField label="Last Name" id="last-name" requirement="required" error={errors.lastName?.message}>
                <Input id="last-name" placeholder="Dela Cruz" {...register('lastName')} error={Boolean(errors.lastName)} />
              </FormField>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <FormField label="Middle Name (Optional)" id="middle-name" error={errors.middleName?.message}>
                <Input id="middle-name" placeholder="Santos" {...register('middleName')} error={Boolean(errors.middleName)} />
              </FormField>
              <FormField label="Contact Number" id="contact-number" requirement="required" error={errors.contactNumber?.message}>
                <Input id="contact-number" placeholder="09171234567" {...register('contactNumber')} error={Boolean(errors.contactNumber)} />
              </FormField>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <VisitPurposeField
                value={purpose}
                purposes={visitPurposes}
                error={errors.purpose?.message}
                onChange={(val) => setValue('purpose', val, { shouldValidate: true })}
              />
              <FormField label="Visit Date" id="visit-date" requirement="required" error={errors.visitDate?.message}>
                <Input id="visit-date" type="date" min={today} max={latestVisitDate} {...register('visitDate')} error={Boolean(errors.visitDate)} />
              </FormField>
            </div>

            {/* Data Privacy Notice */}
            <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-canvas)] p-4 text-xs text-[var(--color-text-secondary)] space-y-2">
              <p className="font-semibold text-[var(--color-text-primary)]">Data Privacy Notice</p>
              <p>
                Visitor information is processed under EARIST institutional privacy procedures and applicable privacy requirements.{' '}
                {typeof photoRetentionDays === 'number'
                  ? `Face photos are normally retained for ${photoRetentionDays} days.`
                  : 'Face photos are normally retained under institutional policy.'}{' '}
                {typeof idRetentionDays === 'number'
                  ? `Valid ID images, when collected, are normally retained for ${idRetentionDays} days.`
                  : 'Valid ID images, when collected, are normally retained under institutional policy.'}{' '}
                {typeof visitorRetentionDays === 'number'
                  ? `Visitor records are retained for ${visitorRetentionDays} days under institutional policy.`
                  : 'Visitor records are retained under institutional policy.'}{' '}
                Evidence is retained at least through the scheduled visit, and authorized incident holds may extend retention when required.
              </p>
            </div>

            <div className="rounded-lg border border-[var(--color-border)] p-4 bg-[var(--color-surface)]">
              <label className="flex items-start gap-3 cursor-pointer">
                <input type="checkbox" {...register('consent')} className="mt-1 h-4 w-4 text-[var(--color-brand)] rounded" />
                <span className="text-xs text-[var(--color-text-secondary)] leading-relaxed">
                  I consent to the collection and processing of my personal information, face photo, and valid ID pursuant to the <strong>Data Privacy Act of 2012</strong> for the purpose of campus security and visitor management.
                </span>
              </label>
              {errors.consent && (
                <p className="text-xs text-[var(--color-danger-dark)] mt-2 font-medium">{errors.consent.message}</p>
              )}
            </div>

            <Button type="submit" disabled={!isValid} className="w-full" icon={<ArrowRight className="h-4 w-4" />}>
              Continue to Live Face Capture
            </Button>
          </form>
        )}

        {/* ============================== STEP 2: LIVE FACE CAPTURE ============================== */}
        {step === 'photo' && (
          <div className="space-y-6">
            <div className="text-center">
              <h2 className="text-lg font-bold text-[var(--color-text-primary)]">
                {photoPreview ? 'Live Face Captured' : 'Verify Your Identity'}
              </h2>
              <p className="text-sm text-[var(--color-text-secondary)] mt-1">
                {photoPreview
                  ? 'Check your photo. Make sure your full face is visible and well-lit.'
                  : 'Place your face inside the guide. Look directly at the camera. Use good lighting.'}
              </p>
            </div>

            {liveFaceQualityError && (
              <div className="rounded-xl border border-[var(--color-danger)] bg-[var(--color-danger-light)] p-4 text-xs text-[var(--color-danger-dark)] space-y-1" role="alert">
                <div className="flex items-center gap-2 font-bold">
                  <AlertCircle className="h-4 w-4 text-[var(--color-danger)] flex-shrink-0" />
                  <span>Photo Quality Check Failed</span>
                </div>
                <p>{liveFaceQualityError}</p>
              </div>
            )}

            {photoPreview ? (
              <div className="space-y-4">
                <div className="relative mx-auto max-w-xs overflow-hidden rounded-2xl border-2 border-[var(--color-border)] shadow-sm aspect-[4/3] bg-black">
                  <img src={photoPreview} alt="Captured face" className="w-full h-full object-cover" />
                </div>

                <div className="flex gap-3">
                  <Button variant="secondary" onClick={onRetakeLivePhoto} className="flex-1" icon={<RotateCcw className="h-4 w-4" />}>
                    Retake
                  </Button>
                  <Button
                    onClick={onConfirmLivePhoto}
                    loading={isEvaluatingFaceQuality}
                    className="flex-1"
                    icon={<ArrowRight className="h-4 w-4" />}
                  >
                    Use This Photo
                  </Button>
                </div>
              </div>
            ) : (
              <div className="space-y-4">
                {faceWebcam.error && (
                  <div className="rounded-md border border-[var(--color-danger)] bg-[var(--color-danger-light)] p-3 text-xs text-[var(--color-danger-dark)]">
                    <p className="font-semibold mb-1">Camera access required</p>
                    <p className="mb-2">{faceWebcam.error}</p>
                    <Button size="sm" variant="secondary" onClick={() => faceWebcam.start()} disabled={faceWebcam.isStarting}>
                      {faceWebcam.isStarting ? 'Starting…' : 'Retry Camera'}
                    </Button>
                  </div>
                )}

                {/* Single camera viewport with oval guide */}
                <div className="mx-auto w-full max-w-md overflow-hidden rounded-2xl border-2 border-[var(--color-brand)] bg-black aspect-[4/3] relative flex items-center justify-center shadow-inner">
                  {faceWebcam.isStarting && (
                    <div className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-black/60 text-white text-xs">
                      <Loader2 className="h-6 w-6 animate-spin mb-1 text-[var(--color-brand)]" />
                      <span>Starting camera…</span>
                    </div>
                  )}
                  {faceWebcam.videoRef && (
                    <video
                      ref={faceWebcam.videoRef}
                      autoPlay
                      playsInline
                      muted
                      style={{ transform: faceWebcam.mirrorPreview ? 'scaleX(-1)' : 'none' }}
                      className="h-full w-full object-cover"
                    />
                  )}

                  {/* Face Guide Oval */}
                  <div className="absolute inset-0 pointer-events-none flex items-center justify-center">
                    <div className="w-48 h-64 sm:w-56 sm:h-72 border-2 border-dashed border-white/80 rounded-[50%] shadow-[0_0_0_9999px_rgba(0,0,0,0.45)] flex items-center justify-center">
                      <span className="sr-only">Center face in oval</span>
                    </div>
                  </div>
                </div>

                <div className="flex gap-3">
                  <Button
                    variant="secondary"
                    onClick={() => {
                      faceWebcam.stop();
                      setStep('form');
                    }}
                    className="flex-1"
                    icon={<ArrowLeft className="h-4 w-4" />}
                  >
                    Back
                  </Button>
                  <Button
                    onClick={onCaptureLivePhoto}
                    disabled={!faceWebcam.isActive}
                    className="flex-1"
                    icon={<Camera className="h-4 w-4" />}
                  >
                    Take Live Photo
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ============================== STEP 3: VALID ID ============================== */}
        {step === 'id' && (
          <div className="space-y-6">
            <div className="text-center">
              <h2 className="text-lg font-bold text-[var(--color-text-primary)]">Valid ID Document</h2>
              <p className="text-sm text-[var(--color-text-secondary)] mt-1">
                Provide a clear image of your government, student, or company ID.
              </p>
            </div>

            {idQualityError && (
              <div className="rounded-xl border border-[var(--color-danger)] bg-[var(--color-danger-light)] p-4 text-xs text-[var(--color-danger-dark)] space-y-1" role="alert">
                <div className="flex items-center gap-2 font-bold">
                  <AlertCircle className="h-4 w-4 text-[var(--color-danger)] flex-shrink-0" />
                  <span>ID Image Quality Check</span>
                </div>
                <p>{idQualityError}</p>
              </div>
            )}

            <input
              ref={idFileInputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              onChange={handleIdFileUpload}
              className="hidden"
            />

            {idPreview ? (
              <div className="space-y-4">
                {idReusedFromOcr && (
                  <div className="rounded-lg bg-emerald-50 border border-emerald-200 p-3 text-xs text-emerald-800 flex items-center gap-2">
                    <CheckCircle2 className="h-4 w-4 text-emerald-600 flex-shrink-0" />
                    <span>✓ ID image already added from earlier autofill upload.</span>
                  </div>
                )}

                <div className="relative mx-auto max-w-sm overflow-hidden rounded-xl border border-[var(--color-border)] shadow-sm aspect-[3/2] bg-slate-100 flex items-center justify-center">
                  <img src={idPreview} alt="Valid ID" className="h-full w-full object-cover" />
                  <button
                    type="button"
                    onClick={onRetakeId}
                    aria-label="Remove ID image"
                    className="absolute top-2 right-2 min-h-11 min-w-11 rounded-full bg-black/60 hover:bg-black/80 text-white flex items-center justify-center transition-colors"
                  >
                    <X className="h-5 w-5" />
                  </button>
                </div>

                <div className="flex gap-3">
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => idFileInputRef.current?.click()}
                    disabled={isProcessingId}
                    className="flex-1"
                    icon={<Upload className="h-4 w-4" />}
                  >
                    Replace ID
                  </Button>
                  <Button
                    type="button"
                    onClick={onConfirmValidId}
                    disabled={isProcessingId}
                    className="flex-1"
                    icon={<ArrowRight className="h-4 w-4" />}
                  >
                    Verify Identity
                  </Button>
                </div>
              </div>
            ) : (
              <div className="space-y-4 text-center">
                <div
                  onClick={() => idFileInputRef.current?.click()}
                  tabIndex={0}
                  role="button"
                  aria-label="Upload valid ID image"
                  className="aspect-[3/2] max-w-sm mx-auto flex flex-col items-center justify-center rounded-2xl border-2 border-dashed border-[var(--color-border)] hover:border-[var(--color-brand)] bg-[var(--color-canvas)] cursor-pointer p-6 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-brand)] transition-colors"
                >
                  <Upload className="h-10 w-10 text-[var(--color-brand)] mb-2" />
                  <p className="font-bold text-sm text-[var(--color-text-primary)]">
                    {isProcessingId ? 'Processing ID image…' : 'Add Valid ID'}
                    {/* Processing image… */}
                  </p>
                  <p className="text-xs text-[var(--color-text-secondary)] mt-1">
                    Select photo from device library or take photo via your phone camera
                  </p>
                </div>

                <div className="flex gap-3 max-w-sm mx-auto">
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => {
                      setStep('photo');
                      void faceWebcam.start();
                    }}
                    className="flex-1"
                    icon={<ArrowLeft className="h-4 w-4" />}
                  >
                    Back to Face
                  </Button>
                  <Button
                    type="button"
                    onClick={() => idFileInputRef.current?.click()}
                    loading={isProcessingId}
                    className="flex-1"
                    icon={<Upload className="h-4 w-4" />}
                  >
                    Choose Photo
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ============================== STEP 4: VERIFICATION ============================== */}
        {step === 'verify' && (
          <div className="space-y-6">
            <div className="text-center">
              <h2 className="text-lg font-bold text-[var(--color-text-primary)]">Identity Verification</h2>
              <p className="text-sm text-[var(--color-text-secondary)] mt-1">
                Comparing your live selfie with your valid ID portrait.
              </p>
            </div>

            {isVerifyingIdentity ? (
              <div className="py-12 text-center space-y-4">
                <Loader2 className="mx-auto h-12 w-12 animate-spin text-[var(--color-brand)]" />
                <h3 className="font-bold text-base text-[var(--color-text-primary)]">
                  Verifying Your Identity…
                </h3>
                <p className="text-xs text-[var(--color-text-secondary)] max-w-xs mx-auto">
                  Extracting ID portrait and performing local biometric comparison. This takes a few seconds.
                </p>
              </div>
            ) : identityVerified ? (
              <div className="space-y-6 text-center">
                <div className="rounded-2xl border border-emerald-300 bg-emerald-50 p-6 space-y-3">
                  <CheckCircle2 className="mx-auto h-12 w-12 text-emerald-600" />
                  <h3 className="font-bold text-lg text-emerald-950">Identity Verified Successfully</h3>
                  <p className="text-xs text-emerald-800 max-w-sm mx-auto">
                    Your live face matches the portrait on your ID. You are ready to review your pass details.
                  </p>
                </div>

                <div className="flex gap-3 max-w-md mx-auto">
                  <Button onClick={() => setStep('review')} className="w-full" icon={<ArrowRight className="h-4 w-4" />}>
                    Continue to Review
                  </Button>
                </div>
              </div>
            ) : (
              <div className="space-y-6">
                <div className="rounded-2xl border border-[var(--color-danger)] bg-[var(--color-danger-light)] p-6 space-y-3" role="alert">
                  <AlertCircle className="mx-auto h-10 w-10 text-[var(--color-danger)]" />
                  <h3 className="font-bold text-base text-center text-[var(--color-danger-dark)]">
                    Identity Verification Unsuccessful
                  </h3>
                  <p className="text-xs text-[var(--color-danger-dark)] text-center leading-relaxed">
                    {verificationError || 'We could not confirm a match between your live face and ID portrait.'}
                  </p>
                </div>

                <div className="flex flex-col sm:flex-row gap-3">
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setPhotoBlob(null);
                      photoUrl.clear();
                      setStep('photo');
                      void faceWebcam.start();
                    }}
                    className="flex-1"
                    icon={<RotateCcw className="h-4 w-4" />}
                  >
                    Retake Live Photo
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={() => {
                      idFileInputRef.current?.click();
                    }}
                    className="flex-1"
                    icon={<Upload className="h-4 w-4" />}
                  >
                    Replace ID Image
                  </Button>
                  <Button
                    onClick={() => runIdentityVerification()}
                    className="flex-1"
                    icon={<RefreshCw className="h-4 w-4" />}
                  >
                    Retry Verification
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ============================== STEP 5: REVIEW ============================== */}
        {step === 'review' && (
          <div className="space-y-6">
            <div className="text-center">
              <h2 className="text-lg font-bold text-[var(--color-text-primary)]">Review Your Information</h2>
              <p className="text-sm text-[var(--color-text-secondary)] mt-1">
                Please verify your information before generating your E-GatePass.
              </p>
            </div>

            {portalTransactionRef.current?.phase === 'existing_pass_conflict' ? (
              <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 space-y-2 text-sm text-amber-900" role="alert">
                <div className="flex items-center gap-2 font-semibold text-amber-950">
                  <AlertCircle className="h-5 w-5 text-amber-600 shrink-0" />
                  <span>Existing Pass Detected</span>
                </div>
                <p>
                  An existing pass was already created for this request, but the local retry no longer matches it. Do not create another pass. Please ask the Guard for assistance.
                </p>
              </div>
            ) : portalTransactionRef.current?.phase === 'ambiguous' ? (
              <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 space-y-2 text-sm text-amber-900" role="alert">
                <div className="flex items-center gap-2 font-semibold text-amber-950">
                  <AlertCircle className="h-5 w-5 text-amber-600 shrink-0" />
                  <span>Generation result could not be confirmed</span>
                </div>
                <p>
                  Submission cancelled. The previous pass may have been created. Please proceed to the Guard Station with your valid ID for assistance.
                </p>
                <div className="flex gap-2 pt-2">
                  <Button variant="secondary" onClick={handleAmbiguousCancelAndAskGuard}>
                    Cancel & Ask Guard
                  </Button>
                  <Button onClick={handleRetryExactSubmission}>
                    Retry Exact Submission
                  </Button>
                </div>
              </div>
            ) : submitError ? (
              <div className="rounded-md border border-[var(--color-danger)] bg-[var(--color-danger-light)] p-3 text-sm text-[var(--color-danger-dark)]" role="alert">
                {submitError}
              </div>
            ) : null}

            {/* Verification Badge */}
            <div className="rounded-xl border border-emerald-300 bg-emerald-50 p-3.5 flex items-center justify-between text-xs text-emerald-900">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="h-5 w-5 text-emerald-600 flex-shrink-0" />
                <div>
                  <span className="font-bold block">Biometric Identity Verified</span>
                  <span className="text-[11px] text-emerald-800">Your live face matches your submitted ID portrait.</span>
                </div>
              </div>
              <span className="rounded-full bg-emerald-600 text-white font-bold text-[10px] px-2.5 py-0.5 uppercase tracking-wide">
                Verified
              </span>
            </div>

            {/* Group 1: Visitor Information */}
            <div className="rounded-lg bg-[var(--color-surface)] p-4 text-sm border border-[var(--color-border)] space-y-3">
              <div className="flex items-center justify-between border-b border-[var(--color-border)] pb-2">
                <span className="font-bold text-xs uppercase tracking-wider text-[var(--color-text-secondary)]">
                  Visitor Information
                </span>
                {portalTransactionRef.current?.phase !== 'existing_pass_conflict' &&
                  portalTransactionRef.current?.phase !== 'ambiguous' && (
                  <button
                    type="button"
                    onClick={() => setStep('form')}
                    className="text-xs font-semibold text-[var(--color-brand)] hover:underline"
                  >
                    Edit Details
                  </button>
                )}
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <span className="text-xs text-[var(--color-text-secondary)]">Full Name:</span>
                  <p className="font-semibold text-[var(--color-text-primary)] mt-0.5">
                    {[getValues('firstName'), getValues('middleName'), getValues('lastName')].filter(Boolean).join(' ')}
                  </p>
                </div>
                <div>
                  <span className="text-xs text-[var(--color-text-secondary)]">Contact Number:</span>
                  <p className="font-semibold text-[var(--color-text-primary)] mt-0.5">{getValues('contactNumber')}</p>
                </div>
              </div>
            </div>

            {/* Group 2: Visit Information */}
            <div className="rounded-lg bg-[var(--color-surface)] p-4 text-sm border border-[var(--color-border)] space-y-3">
              <div className="border-b border-[var(--color-border)] pb-2">
                <span className="font-bold text-xs uppercase tracking-wider text-[var(--color-text-secondary)]">
                  Visit Information
                </span>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <span className="text-xs text-[var(--color-text-secondary)]">Purpose of Visit:</span>
                  <p className="font-semibold text-[var(--color-text-primary)] mt-0.5">{getValues('purpose')}</p>
                </div>
                <div>
                  <span className="text-xs text-[var(--color-text-secondary)]">Visit Date:</span>
                  <p className="font-semibold text-[var(--color-text-primary)] mt-0.5">{getValues('visitDate')}</p>
                </div>
              </div>
            </div>

            {/* Group 3: Photo Previews */}
            <div className="rounded-lg bg-[var(--color-surface)] p-4 text-sm border border-[var(--color-border)] space-y-3">
              <div className="border-b border-[var(--color-border)] pb-2">
                <span className="font-bold text-xs uppercase tracking-wider text-[var(--color-text-secondary)]">
                  Evidence Photos
                </span>
              </div>
              <div className="flex flex-wrap gap-6 justify-center items-center py-2">
                {photoPreview && (
                  <div className="text-center">
                    <p className="text-xs text-[var(--color-text-secondary)] mb-1">Live Face Photo</p>
                    <img
                      src={photoPreview}
                      alt="Your live face photo"
                      className="h-24 w-20 object-cover rounded-lg border border-[var(--color-border)] shadow-sm mx-auto"
                    />
                    <button
                      type="button"
                      onClick={() => {
                        onRetakeLivePhoto();
                        setStep('photo');
                      }}
                      className="mt-1.5 text-xs font-semibold text-[var(--color-brand)] hover:underline inline-flex items-center gap-1"
                    >
                      <RotateCcw className="h-3 w-3" />
                      Retake Photo
                    </button>
                  </div>
                )}
                {idPreview && (
                  <div className="text-center">
                    <p className="text-xs text-[var(--color-text-secondary)] mb-1">Valid ID</p>
                    <img
                      src={idPreview}
                      alt="Valid ID"
                      className="h-24 w-36 object-cover rounded-lg border border-[var(--color-border)] shadow-sm mx-auto"
                    />
                    <button
                      type="button"
                      onClick={() => {
                        onRetakeId();
                        setStep('id');
                      }}
                      className="mt-1.5 text-xs font-semibold text-[var(--color-brand)] hover:underline inline-flex items-center gap-1"
                    >
                      <RotateCcw className="h-3 w-3" />
                      Retake ID
                    </button>
                  </div>
                )}
              </div>
            </div>

            <TurnstileWidget key={turnstileKey} onVerify={setCaptchaToken} />

            <div className="flex flex-col sm:flex-row gap-3">
              <Button
                variant="secondary"
                onClick={() => setStep('form')}
                className="flex-1"
                icon={<ArrowLeft className="h-4 w-4" />}
              >
                Back to Details
              </Button>
              <Button
                onClick={onSubmit}
                disabled={!identityVerified}
                className="flex-1"
                icon={<CheckCircle2 className="h-4 w-4" />}
              >
                Generate E-GatePass
              </Button>
            </div>
          </div>
        )}

        {/* ============================== STEP 6: GENERATING ============================== */}
        {step === 'generating' && (
          <div role="status" aria-live="polite" aria-label="Generating gate pass" className="py-16 text-center space-y-4">
            <Loader2 className="mx-auto h-12 w-12 animate-spin text-[var(--color-brand)]" />
            <h3 className="text-lg font-bold text-[var(--color-text-primary)]">Issuing Official E-GatePass…</h3>
            <p className="text-sm text-[var(--color-text-secondary)]">Securing your pass record and generating QR token.</p>
          </div>
        )}

        {/* ============================== STEP 7: DELIVERY / DONE ============================== */}
        {(step === 'delivery' || step === 'done') && (
          <div className="space-y-6">
            <div className="text-center">
              <CheckCircle2 className="mx-auto h-14 w-14 text-emerald-600" />
              <h2 className="text-xl font-black text-[var(--color-text-primary)] mt-3">Your E-GatePass is Ready!</h2>
              <p className="text-sm text-[var(--color-text-secondary)] mt-1">
                Save your pass or email it to your inbox. Present the QR code at the campus scanner.
              </p>
            </div>

            {emailDeliverySecured && (
              <div className="rounded-xl border border-emerald-300 bg-emerald-50 p-4 text-xs text-emerald-900">
                <p className="font-semibold text-sm text-emerald-950">Email Delivery Confirmed</p>
                <p>A copy of your E-GatePass was sent to your verified email.</p>
              </div>
            )}

            {emailSkipped && !emailDeliverySecured && !emailOutcomeUnknown && (
              <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-xs text-amber-900 space-y-1">
                <p className="font-semibold text-sm text-amber-950">Save your E-GatePass before leaving this page.</p>
                <p>You chose not to provide a verified email, so a copy was not sent to you.</p>
              </div>
            )}

            {emailOutcomeUnknown && !emailDeliverySecured && (
              <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-xs text-amber-900 space-y-1">
                <p className="font-semibold text-sm text-amber-950">Email delivery could not be confirmed.</p>
                <p>Your E-GatePass is valid, but the email provider did not return a confirmed delivery result.</p>
                <p>Please download or save your E-GatePass before leaving this page.</p>
              </div>
            )}

            {qrDataUrl && passPresentation ? (
              <div className="flex justify-center py-2">
                <InstitutionalPassCard presentation={passPresentation} qrDataUrl={qrDataUrl} />
              </div>
            ) : (
              <div className="rounded-xl border border-amber-300 bg-amber-50 p-6 text-center text-xs text-amber-900 space-y-2">
                <AlertCircle className="mx-auto h-8 w-8 text-amber-600" />
                <p className="font-semibold text-sm">Pass Card Notice</p>
                <p>
                  Your E-GatePass was issued, but the visual pass could not be prepared. Please retry or ask the Guard for assistance.
                </p>
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Button onClick={handleDownload} className="w-full" icon={<Download className="h-4 w-4" />}>
                Download E-GatePass
              </Button>
              <Button
                variant="secondary"
                onClick={() => setShowEmailModal(true)}
                className="w-full"
                icon={<Mail className="h-4 w-4" />}
              >
                Email E-GatePass
              </Button>
            </div>

            <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-canvas)] p-4 text-xs text-[var(--color-text-secondary)] space-y-2">
              <div className="font-bold text-[var(--color-text-primary)] flex items-center gap-1.5">
                <Info className="h-4 w-4 text-[var(--color-brand)]" />
                <span>Visitor Instructions</span>
              </div>
              <ul className="list-disc pl-5 space-y-1">
                {visitorInstructions.map((inst, i) => (
                  <li key={i}>{inst}</li>
                ))}
              </ul>
            </div>

            <div className="pt-2 text-center">
              <button
                type="button"
                onClick={handleStartOver}
                className="text-xs font-semibold text-[var(--color-brand)] hover:underline"
              >
                Register Another Pass / Start Over
              </button>
            </div>
          </div>
        )}
      </Card>
      )}

      {/* Email Pass Modal */}
      {passId && (
        <EmailPassModal
          isOpen={showEmailModal}
          onClose={() => setShowEmailModal(false)}
          passId={passId || ''}
          qrToken={rawQrToken || ''}
          source="portal"
          mode={step === 'delivery' ? 'delivery-gate' : 'modal'}
          onSuccess={() => {
            setEmailDeliverySecured(true);
            setEmailOutcomeUnknown(false);
            setEmailSkipped(false);
            setStep('done');
          }}
          onUnknown={() => {
            setEmailDeliverySecured(false);
            setEmailOutcomeUnknown(true);
            setEmailSkipped(false);
            setStep('done');
          }}
          onSkip={() => setShowSkipWarning(true)}
        />
      )}

      {/* Skip Warning Modal */}
      <TimedSkipWarningModal
        isOpen={showSkipWarning}
        onCancel={() => setShowSkipWarning(false)}
        onConfirmSkip={() => {
          setShowSkipWarning(false);
          setShowEmailModal(false);
          setEmailDeliverySecured(false);
          setEmailOutcomeUnknown(false);
          setEmailSkipped(true);
          setStep('done');
        }}
      />
    </PageShell>
  );
}
