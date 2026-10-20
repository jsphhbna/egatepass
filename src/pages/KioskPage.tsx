import { useState, useRef, useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { useWebcam } from '@/hooks/useWebcam';
import { compressImageToWebP } from '@/lib/imageProcessing';
import { recognizeIdImage, terminateLocalOcrWorker } from '@/lib/ocr';
import { issueVisitorPass, loadRegistrationSettings } from '@/services/visitorRegistration';
import { requireSupabase } from '@/lib/supabase';
import { toDataURL } from 'qrcode';
import {
  Camera,
  Upload,
  CheckCircle2,
  Printer,
  ArrowRight,
  ArrowLeft,
  AlertCircle,
  X,
  RotateCcw,
  Mail,
  Scan,
} from 'lucide-react';
import { toast } from 'sonner';
import { addDays, format } from 'date-fns';
import { Button, Card, Input, FormField, Stepper } from '@/components/ui';
import { EmailPassModal } from '@/components/EmailPassModal';
import { BrandMark } from '@/components/BrandMark';
import { VisitPurposeField } from '@/components/VisitPurposeField';
import { DEFAULT_VISIT_PURPOSES, normalizeVisitPurposes } from '@/lib/settingsDefaults';
import type { VisitPurposeOption } from '@/types';
import { DEFAULT_WORKING_HOURS, formatValidityWindow, formatWorkingHours, MAX_VISIT_ADVANCE_DAYS, normalizeWorkingHours } from '@/lib/workingHours';

const nameRegex = /^[\p{L}\s\-'.]+$/u;

const kioskPassSchema = z.object({
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
  visitDate: z.string().min(1, 'Please select a visit date'),
  consent: z.literal(true, {
    message: 'You must accept the Data Privacy Act notice to proceed',
  }),
});

type KioskPassFormData = z.infer<typeof kioskPassSchema>;

type Step = 'scan-intro' | 'scan-camera' | 'scan-processing' | 'form' | 'photo' | 'id' | 'review' | 'generating' | 'done';

export function KioskPage() {
  const [step, setStep] = useState<Step>('scan-intro');
  const [photoBlob, setPhotoBlob] = useState<Blob | null>(null);
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const [idBlob, setIdBlob] = useState<Blob | null>(null);
  const [idPreview, setIdPreview] = useState<string | null>(null);
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

  const fileInputRef = useRef<HTMLInputElement>(null);
  const manualIdInputRef = useRef<HTMLInputElement>(null);
  const issueRequestId = useRef(crypto.randomUUID());

  useEffect(() => {
    loadRegistrationSettings('kiosk').then((data) => {
      if (!data) return;
      setIsPeakMode(data.peak_mode === 'kiosk' || data.peak_mode === 'both');
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
      void terminateLocalOcrWorker();
      if (photoPreview) URL.revokeObjectURL(photoPreview);
      if (idPreview) URL.revokeObjectURL(idPreview);
    };
  }, []);

  const {
    register,
    handleSubmit,
    getValues,
    reset,
    setValue,
    watch,
    formState: { errors, isValid },
  } = useForm<KioskPassFormData>({
    resolver: zodResolver(kioskPassSchema),
    mode: 'onChange',
    defaultValues: {
      visitDate: format(new Date(), 'yyyy-MM-dd'),
      purpose: '',
    },
  });
  const purpose = watch('purpose');

  const today = format(new Date(), 'yyyy-MM-dd');
  const latestVisitDate = format(addDays(new Date(), schedulingDaysAhead), 'yyyy-MM-dd');

  function startIdScan() {
    setStep('scan-camera');
    idWebcam.start();
  }

  async function processIdImageAndOcr(blobOrFile: Blob | File) {
    idWebcam.stop();
    setStep('scan-processing');
    try {
      const compressed = await compressImageToWebP(blobOrFile);
      setIdBlob(compressed);
      if (idPreview) URL.revokeObjectURL(idPreview);
      const previewUrl = URL.createObjectURL(compressed);
      setIdPreview(previewUrl);

      // Offline OCR via self-hosted worker
      const parsed = await recognizeIdImage(compressed);
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
      console.warn('Local OCR warning:', err);
      setOcrSuccessNotice(false);
      toast.info('Automatic reading skipped. Please enter your details manually.');
    } finally {
      setStep('form');
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

  function onIdScanFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) {
      void processIdImageAndOcr(file);
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
      setPhotoBlob(blob);
      if (photoPreview) URL.revokeObjectURL(photoPreview);
      setPhotoPreview(URL.createObjectURL(blob));
      faceWebcam.stop();
      if (idBlob || isPeakMode) {
        setStep('review');
      } else {
        setStep('id');
      }
    } else {
      toast.error('Failed to capture photo.');
    }
  }

  function onRetakePhoto() {
    if (photoPreview) URL.revokeObjectURL(photoPreview);
    setPhotoBlob(null);
    setPhotoPreview(null);
    setStep('photo');
    faceWebcam.start();
  }

  async function onManualIdFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      const compressed = await compressImageToWebP(file);
      setIdBlob(compressed);
      if (idPreview) URL.revokeObjectURL(idPreview);
      setIdPreview(URL.createObjectURL(compressed));
    } catch {
      toast.error('Failed to process ID image.');
    }
  }

  async function onSubmit() {
    if (!photoBlob) {
      toast.error('Photo is required.');
      return;
    }
    if (!isPeakMode && !idBlob) {
      toast.error('ID is required.');
      return;
    }

    setStep('generating');
    setSubmitError(null);

    try {
      const formData = getValues();
      const result = await issueVisitorPass('kiosk', formData, photoBlob, idBlob, issueRequestId.current);
      const qrUrl = await toDataURL(result.qrToken, {
        width: 300,
        margin: 2,
        color: { dark: '#000000', light: '#ffffff' },
      });

      setQrDataUrl(qrUrl);
      setPassId(result.passId);
      setRawQrToken(result.qrToken);
      setIssuedValidity(result.validFrom && result.validUntil
        ? formatValidityWindow(result.validFrom, result.validUntil)
        : formatWorkingHours(workingHours));
      setStep('done');
      toast.success('Pass generated!');
    } catch (err) {
      console.error(err);
      setSubmitError('Failed to generate pass.');
      setStep('review');
    }
  }

  function handlePrint() {
    window.print();
  }

  function handleNextVisitor() {
    issueRequestId.current = crypto.randomUUID();
    reset();
    faceWebcam.stop();
    idWebcam.stop();
    void terminateLocalOcrWorker();
    setPhotoBlob(null);
    if (photoPreview) URL.revokeObjectURL(photoPreview);
    setPhotoPreview(null);
    setIdBlob(null);
    if (idPreview) URL.revokeObjectURL(idPreview);
    setIdPreview(null);
    setQrDataUrl(null);
    setPassId(null);
    setRawQrToken(null);
    setShowEmailModal(false);
    setIssuedValidity(null);
    setOcrSuccessNotice(false);
    setStep('scan-intro');
  }

  const steps = [
    { id: 'scan-intro', title: 'Scan ID' },
    { id: 'form', title: 'Details' },
    { id: 'photo', title: 'Photo' },
    ...(!isPeakMode && !idBlob ? [{ id: 'id', title: 'Upload ID' }] : []),
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
          <div 
            onDoubleClick={() => {
              if (window.confirm('Admin: Sign out of this device?')) {
                void requireSupabase().auth.signOut();
              }
            }}
            className="inline-block cursor-default"
          >
            <BrandMark size="lg" className="mx-auto lg:mx-0 mb-4" />
          </div>
          <h1 className="text-3xl font-bold text-[var(--color-text-primary)]">
            Walk-in Registration Kiosk
          </h1>
          <p className="mt-2 text-sm leading-relaxed text-[var(--color-text-secondary)]">Register one visitor at a time, then print the completed gate pass.</p>
        </div>

        {/* Step Indicator */}
        {step !== 'done' && step !== 'generating' && (
          <div className="w-full">
            {/* Horizontal Stepper for Mobile/Portrait */}
            <div className="lg:hidden w-full mb-8">
              <Stepper steps={steps} currentStepIndex={currentStepIndex} className="w-full px-4" orientation="horizontal" />
            </div>
            {/* Vertical Stepper for Landscape Desktop */}
            <div className="hidden lg:block w-full">
              <Stepper steps={steps} currentStepIndex={currentStepIndex} className="w-full" orientation="vertical" />
            </div>
          </div>
        )}
      </div>

      {/* Right Column (Dynamic Content) */}
      <div className="w-full max-w-lg lg:max-w-4xl flex-1 print:w-full print:max-w-none print:p-0">
        {/* Card container */}
        <Card className="border-t-4 border-t-[var(--color-brand)] print:border-0 print:bg-transparent print:p-0 print:shadow-none">
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

          {/* STEP 2: Rear Camera ID Capture & Fallback */}
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
                    <p className="text-sm">{idWebcam.error}</p>
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      onClick={() => fileInputRef.current?.click()}
                      icon={<Upload className="h-4 w-4" />}
                    >
                      Upload ID Image Instead
                    </Button>
                  </div>
                ) : (
                  <video ref={idWebcam.videoRef} autoPlay playsInline muted className="h-full w-full object-cover" />
                )}
              </div>

              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                onChange={onIdScanFileChange}
                className="hidden"
              />

              <div className="flex flex-col gap-3 sm:flex-row">
                <Button
                  variant="secondary"
                  type="button"
                  onClick={() => {
                    idWebcam.stop();
                    setStep('scan-intro');
                  }}
                  className="flex-1 min-h-[44px]"
                  icon={<ArrowLeft className="h-4 w-4" />}
                >
                  Cancel
                </Button>

                <Button
                  variant="secondary"
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="flex-1 min-h-[44px]"
                  icon={<Upload className="h-4 w-4" />}
                >
                  Upload File
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
                  Using local on-device recognition. Your ID is not uploaded to any cloud service.
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
                  <span>Details automatically filled from your ID. Please review and complete any missing fields.</span>
                </div>
              )}

              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <FormField label="First Name" id="kiosk-first-name" error={errors.firstName?.message}>
                  <Input id="kiosk-first-name" {...register('firstName')} placeholder="Juan" error={!!errors.firstName} />
                </FormField>
                <FormField label="Middle Name" id="kiosk-middle-name" hint="Optional" error={errors.middleName?.message}>
                  <Input id="kiosk-middle-name" {...register('middleName')} placeholder="Santos" error={!!errors.middleName} />
                </FormField>
                <FormField label="Last Name" id="kiosk-last-name" error={errors.lastName?.message}>
                  <Input id="kiosk-last-name" {...register('lastName')} placeholder="Dela Cruz" error={!!errors.lastName} />
                </FormField>
              </div>

              <FormField label="Contact Number" id="kiosk-contact" error={errors.contactNumber?.message}>
                <Input id="kiosk-contact" type="tel" {...register('contactNumber')} placeholder="09171234567" error={!!errors.contactNumber} />
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

              <div className="rounded-xl border border-[var(--color-brand)]/20 bg-[var(--color-brand-light)] p-4">
                <label className="flex items-start gap-3 cursor-pointer">
                  <input type="checkbox" {...register('consent')} className="mt-1 h-5 w-5 shrink-0 rounded border-[var(--color-border-strong)] text-[var(--color-brand)] focus:ring-[var(--color-brand)]" />
                  <span className="text-sm text-[var(--color-text-primary)]">
                    I consent to the collection and processing of my personal information in accordance with the Data Privacy Act of 2012 (RA 10173).
                  </span>
                </label>
                {errors.consent && (
                  <p className="mt-2 flex items-center gap-1 text-xs text-[var(--color-danger)]" role="alert">
                    <AlertCircle className="h-3 w-3" />
                    {errors.consent.message}
                  </p>
                )}
              </div>

              <div className="flex gap-3">
                <Button
                  variant="secondary"
                  type="button"
                  onClick={() => setStep('scan-intro')}
                  className="min-h-[44px]"
                  icon={<ArrowLeft className="h-4 w-4" />}
                >
                  Back
                </Button>
                <Button type="submit" disabled={!isValid} className="flex-1 min-h-[44px]" size="lg" icon={<ArrowRight className="h-4 w-4" />}>
                  Next: Take Photo
                </Button>
              </div>
            </form>
          )}

          {/* STEP 5: Mandatory Visitor Face Photo */}
          {step === 'photo' && (
            <div className="space-y-6">
              <div className="text-center">
                <h2 className="text-lg font-bold text-[var(--color-text-primary)]">Take Your Photo</h2>
                <p className="text-xs text-[var(--color-text-secondary)] mt-1">Look directly into the camera.</p>
              </div>
              <div className="mx-auto w-full max-w-xs overflow-hidden rounded-xl border border-[var(--color-border)] shadow-sm bg-black aspect-[3/4] relative">
                <video ref={faceWebcam.videoRef} autoPlay playsInline muted className="h-full w-full object-cover -scale-x-100" />
              </div>
              <div className="flex gap-3">
                <Button
                  variant="secondary"
                  type="button"
                  onClick={() => {
                    faceWebcam.stop();
                    setStep('form');
                  }}
                  className="flex-1 min-h-[44px]"
                  icon={<ArrowLeft className="h-4 w-4" />}
                >
                  Back
                </Button>
                <Button type="button" onClick={onCapturePhoto} disabled={!faceWebcam.isActive} className="flex-1 min-h-[44px]" icon={<Camera className="h-4 w-4" />}>
                  Capture
                </Button>
              </div>
            </div>
          )}

          {/* STEP 6: Manual ID Upload (Only shown on manual route when Peak Mode is OFF) */}
          {step === 'id' && (
            <div className="space-y-6">
              <div className="text-center">
                <h2 className="text-lg font-bold text-[var(--color-text-primary)]">Upload ID</h2>
              </div>
              {idPreview ? (
                <div className="space-y-4">
                  <div className="relative mx-auto max-w-xs overflow-hidden rounded-xl border border-[var(--color-border)] shadow-sm">
                    <img src={idPreview} alt="ID preview" className="w-full object-cover" />
                    <button type="button" onClick={() => setIdPreview(null)} className="absolute right-2 top-2 flex min-h-11 min-w-11 items-center justify-center rounded-full bg-black/60 text-white transition-colors hover:bg-black/80" aria-label="Remove ID image">
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                  <div className="flex gap-3">
                    <Button variant="secondary" type="button" onClick={onRetakePhoto} className="flex-1 min-h-[44px]" icon={<RotateCcw className="h-4 w-4" />}>
                      Retake Photo
                    </Button>
                    <Button type="button" onClick={() => setStep('review')} className="flex-1 min-h-[44px]" icon={<ArrowRight className="h-4 w-4" />}>
                      Review
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="space-y-4">
                  <div
                    className="flex aspect-[3/2] w-full cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed border-[var(--color-border-strong)] bg-[var(--color-canvas)] transition-colors hover:border-[var(--color-brand)] hover:bg-[var(--color-brand-light)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-brand)]"
                    onClick={() => manualIdInputRef.current?.click()}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') manualIdInputRef.current?.click();
                    }}
                  >
                    <Upload className="mb-3 h-10 w-10 text-[var(--color-text-muted)]" />
                    <span className="text-sm font-bold text-[var(--color-text-primary)]">Tap to upload ID</span>
                  </div>
                  <input ref={manualIdInputRef} type="file" accept="image/*" onChange={onManualIdFileChange} className="hidden" />
                </div>
              )}
            </div>
          )}

          {/* STEP 7: Review Step */}
          {step === 'review' && (
            <div className="space-y-6">
              <h2 className="text-center text-lg font-bold text-[var(--color-text-primary)]">Review Pass</h2>
              {submitError && <div className="rounded-md border border-[var(--color-danger)] bg-[var(--color-danger-light)] p-3 text-sm text-[var(--color-danger-dark)]" role="alert">{submitError}</div>}
              
              <div className="flex gap-4 justify-center items-center py-2">
                {photoPreview && (
                  <div className="text-center">
                    <p className="text-xs text-[var(--color-text-secondary)] mb-1">Face Photo</p>
                    <img src={photoPreview} alt="Face photo" className="h-24 w-20 object-cover rounded-lg border border-[var(--color-border)] shadow-sm" />
                  </div>
                )}
                {idPreview && (
                  <div className="text-center">
                    <p className="text-xs text-[var(--color-text-secondary)] mb-1">ID Card</p>
                    <img src={idPreview} alt="ID preview" className="h-24 w-36 object-cover rounded-lg border border-[var(--color-border)] shadow-sm" />
                  </div>
                )}
              </div>

              <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-canvas)] p-4 text-sm">
                <p className="mb-2"><strong className="text-[var(--color-text-secondary)]">Name:</strong> {[getValues('firstName'), getValues('middleName'), getValues('lastName')].filter(Boolean).join(' ')}</p>
                <p className="mb-2"><strong className="text-[var(--color-text-secondary)]">Visit Date:</strong> {getValues('visitDate')}</p>
                <p><strong className="text-[var(--color-text-secondary)]">Purpose:</strong> {getValues('purpose')}</p>
              </div>

              <div className="flex gap-3">
                <Button
                  variant="secondary"
                  type="button"
                  onClick={() => {
                    if (idBlob) {
                      setStep('photo');
                      faceWebcam.start();
                    } else if (isPeakMode) {
                      setStep('photo');
                      faceWebcam.start();
                    } else {
                      setStep('id');
                    }
                  }}
                  className="flex-1 min-h-[44px]"
                  icon={<ArrowLeft className="h-4 w-4" />}
                >
                  Back
                </Button>
                <Button type="button" onClick={onSubmit} className="flex-1 min-h-[44px]" icon={<CheckCircle2 className="h-4 w-4" />}>
                  Generate
                </Button>
              </div>
            </div>
          )}

          {/* STEP 8: Generating Spinner */}
          {step === 'generating' && (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <div className="mb-6 h-12 w-12 animate-spin rounded-full border-4 border-[var(--color-border)] border-t-[var(--color-brand)]" role="status" aria-label="Generating gate pass" />
              <p className="text-xl font-bold text-[var(--color-text-primary)]">Generating gate pass…</p>
            </div>
          )}

          {/* STEP 9: Done / QR Display */}
          {step === 'done' && qrDataUrl && (
            <div className="space-y-6 text-center print:text-left print:m-0 print:space-y-2">
              <div className="mx-auto mb-2 flex h-16 w-16 items-center justify-center rounded-full bg-[var(--color-success-light)] text-[var(--color-success)] print:hidden">
                <CheckCircle2 className="h-8 w-8" />
              </div>
              
              <h2 className="text-2xl font-bold text-[var(--color-text-primary)] print:text-xl">Gate Pass (Walk-in)</h2>

              <div className="mx-auto inline-block rounded-2xl border border-[var(--color-border)] bg-white p-4 shadow-md print:mx-0 print:border-0 print:p-0 print:shadow-none">
                <img src={qrDataUrl} alt="QR Code" className="h-64 w-64 print:h-48 print:w-48" />
              </div>

              <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-canvas)] p-4 text-left text-sm print:border-0 print:bg-transparent print:p-0">
                <p className="mb-1"><strong className="text-[var(--color-text-secondary)]">Name:</strong> {[getValues('firstName'), getValues('middleName'), getValues('lastName')].filter(Boolean).join(' ')}</p>
                <p className="mb-1"><strong className="text-[var(--color-text-secondary)]">Date:</strong> {getValues('visitDate')}</p>
                <p className="mb-1"><strong className="text-[var(--color-text-secondary)]">Purpose:</strong> {getValues('purpose')}</p>
                <p><strong className="text-[var(--color-text-secondary)]">Valid:</strong> {issuedValidity || formatWorkingHours(workingHours)}</p>
              </div>

              <div className="flex gap-3 print:hidden">
                <Button variant="secondary" type="button" onClick={handlePrint} className="flex-1 min-h-[44px]" icon={<Printer className="h-4 w-4" />}>
                  Print Pass
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
        </Card>

        {showEmailModal && passId && rawQrToken && (
          <EmailPassModal
            isOpen={showEmailModal}
            onClose={() => setShowEmailModal(false)}
            passId={passId}
            qrToken={rawQrToken}
            source="kiosk"
          />
        )}
      </div>
    </main>
  );
}
export default KioskPage;
