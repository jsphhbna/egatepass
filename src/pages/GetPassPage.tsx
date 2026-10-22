import { useState, useRef, useEffect, useMemo } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useWebcam } from '@/hooks/useWebcam';
import { useObjectUrl } from '@/hooks/useObjectUrl';
import { compressImageToWebP } from '@/lib/imageProcessing';
import { issueVisitorPass, loadRegistrationSettings } from '@/services/visitorRegistration';
import { TurnstileWidget } from '@/components/TurnstileWidget';
import { toDataURL } from 'qrcode';
import {
  Camera,
  CheckCircle2,
  Download,
  ArrowLeft,
  ArrowRight,
  X,
  RotateCcw,
  ShieldCheck,
  Mail,
  Share2,
} from 'lucide-react';
import { toast } from 'sonner';
import { Link } from 'react-router-dom';
import { Button, Card, Input, FormField, Stepper, PageShell } from '@/components/ui';
import { EmailPassModal } from '@/components/EmailPassModal';
import { BrandMark } from '@/components/BrandMark';
import { VisitPurposeField } from '@/components/VisitPurposeField';
import { DEFAULT_VISIT_PURPOSES, normalizeVisitPurposes } from '@/lib/settingsDefaults';
import type { VisitPurposeOption } from '@/types';
import { DEFAULT_WORKING_HOURS, formatValidityWindow, formatWorkingHours, MAX_VISIT_ADVANCE_DAYS, normalizeWorkingHours } from '@/lib/workingHours';
import { getManilaDateString, getLatestVisitDateString, validateVisitDate } from '@/lib/scheduling';

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

type GetPassFormData = z.infer<ReturnType<typeof createGetPassSchema>>;

type Step = 'form' | 'photo' | 'id' | 'review' | 'generating' | 'done';

// ============================================================
// COMPONENT
// ============================================================
export function GetPassPage() {
  const [step, setStep] = useState<Step>('form');
  const [photoBlob, setPhotoBlob] = useState<Blob | null>(null);
  const photoUrl = useObjectUrl();
  const photoPreview = photoUrl.url;
  const [idBlob, setIdBlob] = useState<Blob | null>(null);
  const idUrl = useObjectUrl();
  const idPreview = idUrl.url;
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [turnstileKey, setTurnstileKey] = useState(0);

  function resetTurnstile() {
    setCaptchaToken(null);
    setTurnstileKey((prev) => prev + 1);
  }
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
  const issueRequestId = useRef(crypto.randomUUID());

  useEffect(() => {
    loadRegistrationSettings('portal').then((data) => {
      if (!data) return;
      setIsPeakMode(data.peak_mode === 'portal' || data.peak_mode === 'both');
      setVisitPurposes(normalizeVisitPurposes(data.visit_purposes));
      setWorkingHours(normalizeWorkingHours({
        start: data.working_hours_start?.slice(0, 5),
        end: data.working_hours_end?.slice(0, 5),
        timezone: data.timezone,
      }));
      if (Number.isInteger(data.scheduling_days_ahead)) setSchedulingDaysAhead(data.scheduling_days_ahead);
    }).catch(() => undefined);
  }, []);

  const faceWebcam = useWebcam({ facingMode: 'user', width: 640, height: 480 });
  const idWebcam = useWebcam({ facingMode: 'environment', width: 1280, height: 720 });

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      faceWebcam.stop();
      idWebcam.stop();
    };
  }, []);

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
  // STEP HANDLERS
  // ============================================================

  function onFormNext(data: GetPassFormData) {
    void data;
    setStep('photo');
    faceWebcam.start();
  }

  function onCapturePhoto() {
    const blob = faceWebcam.capture();
    if (blob) {
      setPhotoBlob(blob);
      photoUrl.setFromBlob(blob);
      faceWebcam.stop();
      if (isPeakMode) {
        setStep('review');
      } else {
        setStep('id');
        idWebcam.start();
      }
    } else {
      toast.error('Failed to capture photo. Please try again.');
    }
  }

  function onRetakePhoto() {
    photoUrl.clear();
    setPhotoBlob(null);
    faceWebcam.stop();
    setStep('photo');
    faceWebcam.start();
  }

  async function onCaptureId() {
    const blob = idWebcam.capture();
    if (blob) {
      try {
        const compressed = await compressImageToWebP(blob);
        setIdBlob(compressed);
        idUrl.setFromBlob(compressed);
        idWebcam.stop();
      } catch {
        toast.error('Failed to process ID image.');
      }
    } else {
      toast.error('Failed to capture ID photo. Please try again.');
    }
  }

  function onRetakeId() {
    idUrl.clear();
    setIdBlob(null);
    idWebcam.stop();
    setStep('id');
    idWebcam.start();
  }

  // ============================================================
  // SUBMIT — Anonymous Sign-in → Upload → Create Docs → QR
  // ============================================================
  async function onSubmit() {
    if (!photoBlob) {
      toast.error('Photo is required.');
      return;
    }
    if (!isPeakMode && !idBlob) {
      toast.error('Valid ID capture is required.');
      return;
    }

    setStep('generating');
    setSubmitError(null);

    try {
      const formData = getValues();
      const result = await issueVisitorPass('portal', formData, photoBlob, idBlob, issueRequestId.current, captchaToken ?? undefined);
      const qrUrl = await toDataURL(result.qrToken, {
        width: 300,
        margin: 2,
        color: {
          dark: '#1a1a2e',
          light: '#ffffff',
        },
      });

      setQrDataUrl(qrUrl);
      setPassId(result.passId);
      setRawQrToken(result.qrToken);
      setIssuedValidity(result.validFrom && result.validUntil
        ? formatValidityWindow(result.validFrom, result.validUntil)
        : formatWorkingHours(workingHours));
      setStep('done');
      toast.success('Gate pass generated successfully!');
    } catch (err) {
      console.error('Pass generation error:', err);
      setSubmitError(
        err instanceof Error ? err.message : 'An unexpected error occurred.'
      );
      setStep('review');
      toast.error('Failed to generate pass. Please try again.');
    } finally {
      resetTurnstile();
    }
  }

  // ============================================================
  // DOWNLOAD QR
  // ============================================================
  function handleDownload() {
    if (!qrDataUrl || !passId) return;
    const link = document.createElement('a');
    link.download = `egatepass-${passId}.png`;
    link.href = qrDataUrl;
    link.click();
    toast.success('QR code downloaded!');
  }

  // ============================================================
  // SHARE (Web Share API)
  // ============================================================
  async function handleShare() {
    if (!passId) return;
    if (navigator.share) {
      try {
        await navigator.share({
          title: 'EARIST E-GatePass',
          text: `My EARIST Visitor Gate Pass: ${passId}`,
          url: window.location.href,
        });
      } catch {
        // User cancelled share
      }
    } else {
      // Fallback: copy link
      await navigator.clipboard.writeText(window.location.href);
      toast.success('Pass link copied to clipboard!');
    }
  }

  // ============================================================
  // STEP DEFINITIONS
  // ============================================================
  const steps = [
    { id: 'form', title: 'Details' },
    { id: 'photo', title: 'Photo' },
    ...(!isPeakMode ? [{ id: 'id', title: 'Capture ID' }] : []),
    { id: 'review', title: 'Review' },
  ];

  const currentStepIndex =
    step === 'done' || step === 'generating' ? steps.length :
    steps.findIndex((s) => s.id === step);

  return (
    <PageShell>
      <div className="mx-auto max-w-xl">
        {/* Header */}
        <div className="text-center mb-6">
          <Link to="/" className="inline-block mb-3">
            <BrandMark size="md" />
          </Link>
          <h1 className="text-2xl font-bold tracking-tight text-[var(--color-text-primary)]">
            Visitor Pass Registration
          </h1>
          <p className="mt-2 text-[var(--color-text-secondary)]">
            Fill in your details to generate a QR-coded gate pass
          </p>
        </div>

        {/* Step Indicator */}
        {step !== 'done' && step !== 'generating' && (
          <Stepper steps={steps} currentStepIndex={currentStepIndex} className="mb-8 px-4" />
        )}

        {/* Card container */}
        <Card className="border-t-4 border-t-[var(--color-brand)]">
          {/* ============================== STEP 1: FORM ============================== */}
          {step === 'form' && (
            <form onSubmit={handleSubmit(onFormNext)} className="space-y-5" noValidate>
              
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <FormField label="First Name" id="visitor-first-name" error={errors.firstName?.message}>
                  <Input
                    id="visitor-first-name"
                    {...register('firstName')}
                    placeholder="Juan"
                    error={!!errors.firstName}
                  />
                </FormField>

                <FormField label="Middle Name" id="visitor-middle-name" hint="Optional" error={errors.middleName?.message}>
                  <Input
                    id="visitor-middle-name"
                    {...register('middleName')}
                    placeholder="Santos"
                    error={!!errors.middleName}
                  />
                </FormField>

                <FormField label="Last Name" id="visitor-last-name" error={errors.lastName?.message}>
                  <Input
                    id="visitor-last-name"
                    {...register('lastName')}
                    placeholder="Dela Cruz"
                    error={!!errors.lastName}
                  />
                </FormField>
              </div>

              <FormField label="Contact Number" id="visitor-phone" hint="Philippine mobile number" error={errors.contactNumber?.message}>
                <Input
                  id="visitor-phone"
                  type="tel"
                  {...register('contactNumber')}
                  placeholder="0917 123 4567"
                  error={!!errors.contactNumber}
                />
              </FormField>

              <VisitPurposeField
                purposes={visitPurposes}
                value={purpose}
                error={errors.purpose?.message}
                onChange={(value) => setValue('purpose', value, { shouldDirty: true, shouldValidate: true })}
              />

              <FormField label="Visit Date" id="visitor-date" error={errors.visitDate?.message}>
                <Input
                  id="visitor-date"
                  type="date"
                  {...register('visitDate')}
                  min={today}
                  max={latestVisitDate}
                  error={!!errors.visitDate}
                />
              </FormField>

              {/* Data Privacy Act Notice */}
              <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4 space-y-3">
                <div className="flex items-start gap-2">
                  <ShieldCheck className="h-5 w-5 text-[var(--color-brand)] shrink-0 mt-0.5" />
                  <div className="text-xs text-[var(--color-text-secondary)] leading-relaxed space-y-1">
                    <p className="font-semibold text-[var(--color-text-primary)]">
                      Data Privacy Act of 2012 (RA 10173) Notice
                    </p>
                    <p>
                      The Eulogio "Amang" Rodriguez Institute of Science and
                      Technology (EARIST) collects your personal data (name, contact
                      number, photo, ID image, and purpose of visit) solely for
                      campus security, visitor tracking, and emergency response
                      purposes.
                    </p>
                    <p>
                      Your data is securely stored, retained only for the duration
                      required by institutional policy, and never shared with
                      unauthorized third parties. By checking the box below, you
                      freely give your consent to this processing.
                    </p>
                  </div>
                </div>

                <label className="flex items-start gap-2.5 pt-2 border-t border-[var(--color-border)] cursor-pointer">
                  <input
                    type="checkbox"
                    {...register('consent')}
                    className="mt-0.5 h-4 w-4 rounded border-[var(--color-border-strong)] text-[var(--color-brand)] focus:ring-[var(--color-brand)]"
                  />
                  <span className="text-xs text-[var(--color-text-primary)] font-medium">
                    I understand and agree to the collection and processing of my
                    personal data in accordance with the EARIST Privacy Policy.
                  </span>
                </label>
                {errors.consent && (
                  <p className="text-xs text-[var(--color-danger)]">
                    {errors.consent.message}
                  </p>
                )}
              </div>

              <Button type="submit" disabled={!isValid} className="w-full" icon={<ArrowRight className="h-4 w-4" />}>
                Continue
              </Button>
            </form>
          )}

          {/* ============================== STEP 2: PHOTO ============================== */}
          {step === 'photo' && (
            <div className="space-y-6">
              <div className="text-center">
                <h2 className="text-lg font-bold text-[var(--color-text-primary)]">Take Your Photo</h2>
                <p className="text-sm text-[var(--color-text-secondary)] mt-1">
                  Look directly at the camera. This photo will be shown to the guard for verification.
                </p>
              </div>

              {faceWebcam.error && (
                <div className="rounded-md border border-[var(--color-danger)] bg-[var(--color-danger-light)] p-3 text-sm text-[var(--color-danger-dark)]" role="alert">
                  <p className="font-semibold mb-1">Camera access required</p>
                  <p className="mb-2">{faceWebcam.error}</p>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => faceWebcam.start()}
                    icon={<RotateCcw className="h-4 w-4" />}
                  >
                    Retry Camera
                  </Button>
                </div>
              )}

              <div className="mx-auto w-full max-w-xs overflow-hidden rounded-xl border border-[var(--color-border)] shadow-sm bg-black aspect-[3/4] relative">
                {faceWebcam.videoRef && (
                  <video
                    ref={faceWebcam.videoRef}
                    autoPlay
                    playsInline
                    muted
                    className="h-full w-full object-cover"
                    style={{ transform: 'scaleX(-1)' }}
                  />
                )}
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
                  onClick={onCapturePhoto}
                  disabled={!faceWebcam.isActive}
                  className="flex-1"
                  icon={<Camera className="h-4 w-4" />}
                >
                  Capture
                </Button>
              </div>
            </div>
          )}

          {/* ============================== STEP 3: VALID ID ============================== */}
          {step === 'id' && (
            <div className="space-y-6">
              <div className="text-center">
                <h2 className="text-lg font-bold text-[var(--color-text-primary)]">Capture Valid ID</h2>
                <p className="text-sm text-[var(--color-text-secondary)] mt-1">
                  Position your valid government, school, or company ID clearly in the camera frame.
                </p>
              </div>

              {idPreview ? (
                <div className="space-y-4">
                  <div className="relative mx-auto max-w-xs overflow-hidden rounded-xl border border-[var(--color-border)] shadow-sm">
                    <img src={idPreview} alt="Valid ID preview" className="w-full object-cover" />
                    <button
                      type="button"
                      onClick={() => {
                        idUrl.clear();
                        setIdBlob(null);
                        idWebcam.start();
                      }}
                      className="absolute right-2 top-2 rounded-full p-1 text-white bg-black/60 hover:bg-black/80 transition-colors"
                      aria-label="Remove ID image"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                  <div className="flex gap-3">
                    <Button variant="secondary" onClick={onRetakeId} className="flex-1" icon={<RotateCcw className="h-4 w-4" />}>
                      Retake ID
                    </Button>
                    <Button onClick={() => setStep('review')} className="flex-1" icon={<ArrowRight className="h-4 w-4" />}>
                      Review
                    </Button>
                  </div>
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
                        icon={<RotateCcw className="h-4 w-4" />}
                      >
                        Retry Camera
                      </Button>
                    </div>
                  )}

                  <div className="mx-auto w-full max-w-md overflow-hidden rounded-xl border-2 border-dashed border-[var(--color-brand)] shadow-sm bg-black aspect-[3/2] relative flex items-center justify-center">
                    {idWebcam.videoRef && (
                      <video
                        ref={idWebcam.videoRef}
                        autoPlay
                        playsInline
                        muted
                        className="h-full w-full object-cover"
                      />
                    )}
                  </div>

                  <div className="flex gap-3">
                    <Button
                      variant="secondary"
                      onClick={() => {
                        idWebcam.stop();
                        setStep('photo');
                        faceWebcam.start();
                      }}
                      className="flex-1"
                      icon={<ArrowLeft className="h-4 w-4" />}
                    >
                      Back
                    </Button>
                    <Button
                      onClick={onCaptureId}
                      disabled={!idWebcam.isActive}
                      className="flex-1"
                      icon={<Camera className="h-4 w-4" />}
                    >
                      Capture ID
                    </Button>
                  </div>
                  <Button variant="ghost" type="button" onClick={onRetakePhoto} className="w-full" icon={<RotateCcw className="h-4 w-4" />}>
                    Retake Selfie
                  </Button>
                </div>
              )}
            </div>
          )}

          {/* ============================== STEP 4: REVIEW ============================== */}
          {step === 'review' && (
            <div className="space-y-6">
              <h2 className="text-center text-lg font-bold text-[var(--color-text-primary)]">
                Review Your Details
              </h2>

              {submitError && (
                <div className="rounded-md border border-[var(--color-danger)] bg-[var(--color-danger-light)] p-3 text-sm text-[var(--color-danger-dark)]" role="alert">
                  {submitError}
                </div>
              )}

              {/* Photos preview */}
              <div className="flex gap-4 justify-center items-center py-2">
                {photoPreview && (
                  <div className="text-center">
                    <p className="text-xs text-[var(--color-text-secondary)] mb-1">Face Photo</p>
                    <img
                      src={photoPreview}
                      alt="Your photo"
                      className="h-24 w-20 object-cover rounded-lg border border-[var(--color-border)] shadow-sm"
                    />
                  </div>
                )}
                {idPreview && (
                  <div className="text-center">
                    <p className="text-xs text-[var(--color-text-secondary)] mb-1">Valid ID</p>
                    <img
                      src={idPreview}
                      alt="Valid ID"
                      className="h-24 w-36 object-cover rounded-lg border border-[var(--color-border)] shadow-sm"
                    />
                  </div>
                )}
              </div>

              {/* Data summary */}
              <div className="rounded-lg bg-[var(--color-surface)] p-4 text-sm divide-y divide-[var(--color-border)] border border-[var(--color-border)]">
                <div className="pb-2">
                  <span className="text-[var(--color-text-secondary)]">Name:</span>
                  <p className="font-semibold text-[var(--color-text-primary)] mt-1">
                    {[getValues('firstName'), getValues('middleName'), getValues('lastName')].filter(Boolean).join(' ')}
                  </p>
                </div>
                <div className="py-2">
                  <span className="text-[var(--color-text-secondary)]">Contact Number:</span>
                  <p className="font-semibold text-[var(--color-text-primary)] mt-1">{getValues('contactNumber')}</p>
                </div>
                <div className="py-2">
                  <span className="text-[var(--color-text-secondary)]">Purpose:</span>
                  <p className="font-semibold text-[var(--color-text-primary)] mt-1">{getValues('purpose')}</p>
                </div>
                <div className="pt-2">
                  <span className="text-[var(--color-text-secondary)]">Visit Date:</span>
                  <p className="font-semibold text-[var(--color-text-primary)] mt-1">{getValues('visitDate')}</p>
                </div>
              </div>

              <TurnstileWidget key={turnstileKey} onVerify={setCaptchaToken} />

              <div className="flex gap-3">
                <Button
                  variant="secondary"
                  onClick={() => {
                    if (isPeakMode) {
                      setStep('photo');
                      faceWebcam.start();
                    } else {
                      setStep('id');
                      idWebcam.start();
                    }
                  }}
                  className="flex-1"
                  icon={<ArrowLeft className="h-4 w-4" />}
                >
                  Back
                </Button>
                <Button
                  onClick={onSubmit}
                  className="flex-1"
                  icon={<CheckCircle2 className="h-4 w-4" />}
                >
                  Generate Pass
                </Button>
              </div>
            </div>
          )}

          {/* ============================== STEP 5: GENERATING ============================== */}
          {step === 'generating' && (
            <div className="py-12 text-center space-y-4">
              <div className="mx-auto h-12 w-12 animate-spin rounded-full border-4 border-[var(--color-brand)] border-t-transparent" />
              <h2 className="text-lg font-bold text-[var(--color-text-primary)]">
                Generating Your Gate Pass...
              </h2>
              <p className="text-sm text-[var(--color-text-secondary)]">
                Processing your details and generating your secure QR code.
              </p>
            </div>
          )}

          {/* ============================== STEP 6: DONE ============================== */}
          {step === 'done' && (
            <div className="space-y-6 text-center">
              <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-[var(--color-success-light)]">
                <CheckCircle2 className="h-8 w-8 text-[var(--color-success)]" />
              </div>

              <div>
                <h2 className="text-xl font-bold text-[var(--color-text-primary)]">
                  Gate Pass Ready!
                </h2>
                <p className="text-sm text-[var(--color-text-secondary)] mt-1">
                  Present this QR code to the security guard at the gate.
                </p>
              </div>

              {/* QR Code Container */}
              {qrDataUrl && (
                <div className="mx-auto w-64 rounded-xl border border-[var(--color-border)] bg-white p-4 shadow-xs">
                  <img
                    src={qrDataUrl}
                    alt="Visitor Gate Pass QR Code"
                    className="w-full aspect-square"
                  />
                  {passId && (
                    <p className="mt-2 text-xs font-mono text-[var(--color-text-muted)]">
                      {passId}
                    </p>
                  )}
                  {issuedValidity && (
                    <p className="mt-1 text-xs font-semibold text-[var(--color-brand)]">
                      Valid: {issuedValidity}
                    </p>
                  )}
                </div>
              )}

              {/* Pass details summary */}
              <div className="rounded-lg bg-[var(--color-surface)] p-3 text-xs text-[var(--color-text-secondary)] border border-[var(--color-border)]">
                <p>
                  Visitor:{' '}
                  <span className="font-bold text-[var(--color-text-primary)]">
                    {[getValues('firstName'), getValues('middleName'), getValues('lastName')].filter(Boolean).join(' ')}
                  </span>
                </p>
                <p className="mt-0.5">
                  Date:{' '}
                  <span className="font-bold text-[var(--color-text-primary)]">
                    {getValues('visitDate')}
                  </span>
                </p>
              </div>

              {/* Action buttons */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <Button
                  onClick={handleDownload}
                  className="w-full"
                  icon={<Download className="h-4 w-4" />}
                >
                  Download
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => setShowEmailModal(true)}
                  className="w-full"
                  icon={<Mail className="h-4 w-4" />}
                >
                  Email Pass
                </Button>
                <Button
                  variant="secondary"
                  onClick={handleShare}
                  className="w-full"
                  icon={<Share2 className="h-4 w-4" />}
                >
                  Share
                </Button>
              </div>

              {/* Instructions */}
              <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-canvas)] p-3 text-left text-xs text-[var(--color-text-muted)] space-y-1">
                <p className="font-semibold text-[var(--color-text-secondary)]">Next Steps:</p>
                <ol className="list-decimal list-inside space-y-0.5">
                  <li>Save or screenshot this QR code.</li>
                  <li>Show it to the guard at the EARIST gate entrance.</li>
                  <li>Have your valid physical ID ready for inspection.</li>
                </ol>
              </div>

              <div className="pt-2">
                <Link
                  to="/"
                  className="text-sm font-medium text-[var(--color-brand)] hover:underline"
                >
                  Register Another Visitor
                </Link>
              </div>
            </div>
          )}
        </Card>
      </div>

      {showEmailModal && rawQrToken && passId && (
        <EmailPassModal
          isOpen={showEmailModal}
          onClose={() => setShowEmailModal(false)}
          passId={passId}
          qrToken={rawQrToken}
          source="portal"
        />
      )}
    </PageShell>
  );
}
