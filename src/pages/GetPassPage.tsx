import { useState, useRef, useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { signInAnonymously } from 'firebase/auth';
import { collection, doc, getDoc } from 'firebase/firestore';
import { auth, db } from '@/lib/firebase';
import { useWebcam } from '@/hooks/useWebcam';
import { cleanupUploadedImages, compressImageToWebP, uploadToCloudinary } from '@/lib/cloudinary';
import { toDataURL } from 'qrcode';
import {
  Camera,
  Upload,
  CheckCircle2,
  Download,
  ArrowLeft,
  ArrowRight,
  AlertCircle,
  X,
  RotateCcw,
  ShieldCheck,
} from 'lucide-react';
import { toast } from 'sonner';
import { addDays, format } from 'date-fns';
import { Link } from 'react-router-dom';
import { Button, Card, Input, FormField, Stepper, PageShell } from '@/components/ui';
import { BrandMark } from '@/components/BrandMark';
import { VisitPurposeField } from '@/components/VisitPurposeField';
import { DEFAULT_VISIT_PURPOSES, normalizeVisitPurposes } from '@/lib/settingsDefaults';
import type { VisitPurposeOption } from '@/types';
import { DEFAULT_WORKING_HOURS, formatValidityWindow, formatWorkingHours, MAX_VISIT_ADVANCE_DAYS, normalizeWorkingHours } from '@/lib/workingHours';

// ============================================================
// FORM SCHEMA (Zod)
// ============================================================
const nameRegex = /^[\p{L}\s\-'.]+$/u;

const getPassSchema = z.object({
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

type GetPassFormData = z.infer<typeof getPassSchema>;

type Step = 'form' | 'photo' | 'id' | 'review' | 'generating' | 'done';

// ============================================================
// COMPONENT
// ============================================================
export function GetPassPage() {
  const [step, setStep] = useState<Step>('form');
  const [photoBlob, setPhotoBlob] = useState<Blob | null>(null);
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const [idBlob, setIdBlob] = useState<Blob | null>(null);
  const [idPreview, setIdPreview] = useState<string | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [passId, setPassId] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [isPeakMode, setIsPeakMode] = useState(false);
  const [visitPurposes, setVisitPurposes] = useState<VisitPurposeOption[]>(DEFAULT_VISIT_PURPOSES);
  const [workingHours, setWorkingHours] = useState(DEFAULT_WORKING_HOURS);
  const [issuedValidity, setIssuedValidity] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    getDoc(doc(db, 'settings', 'app')).then((docSnap) => {
      if (docSnap.exists()) {
        const data = docSnap.data();
        setIsPeakMode(data.peakMode === true);
        setVisitPurposes(normalizeVisitPurposes(data.visitPurposes));
        setWorkingHours(normalizeWorkingHours(data.workingHours));
      }
    });
  }, []);

  const webcam = useWebcam({ facingMode: 'user' });

  const {
    register,
    handleSubmit,
    getValues,
    setValue,
    watch,
    formState: { errors, isValid },
  } = useForm<GetPassFormData>({
    resolver: zodResolver(getPassSchema),
    mode: 'onChange',
    defaultValues: { purpose: '' },
  });
  const purpose = watch('purpose');

  // Get today as min date
  const today = format(new Date(), 'yyyy-MM-dd');
  const latestVisitDate = format(addDays(new Date(), MAX_VISIT_ADVANCE_DAYS), 'yyyy-MM-dd');

  // ============================================================
  // STEP HANDLERS
  // ============================================================

  function onFormNext(data: GetPassFormData) {
    // Form is valid, move to photo step
    void data;
    setStep('photo');
    webcam.start();
  }

  function onCapturePhoto() {
    const blob = webcam.capture();
    if (blob) {
      setPhotoBlob(blob);
      setPhotoPreview(URL.createObjectURL(blob));
      webcam.stop();
      if (isPeakMode) {
        setStep('review');
      } else {
        setStep('id');
      }
    } else {
      toast.error('Failed to capture photo. Please try again.');
    }
  }

  function onRetakePhoto() {
    if (photoPreview) URL.revokeObjectURL(photoPreview);
    setPhotoBlob(null);
    setPhotoPreview(null);
    setStep('photo');
    webcam.start();
  }

  async function onIdFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      const compressed = await compressImageToWebP(file);
      setIdBlob(compressed);
      setIdPreview(URL.createObjectURL(compressed));
    } catch {
      toast.error('Failed to process ID image. Please try another file.');
    }
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
      toast.error('ID upload is required.');
      return;
    }

    setStep('generating');
    setSubmitError(null);

    const uploadedPublicIds: string[] = [];
    try {
      // 1. Anonymous sign-in
      const userCredential = await signInAnonymously(auth);

      // 2. Upload images to Cloudinary
      const trackedUpload = async (blob: Blob, folder: 'e-gatepass/photos' | 'e-gatepass/ids') => {
        const publicId = await uploadToCloudinary(blob, folder);
        uploadedPublicIds.push(publicId);
        return publicId;
      };
      const uploads = [trackedUpload(photoBlob, 'e-gatepass/photos')];
      if (idBlob) {
        uploads.push(trackedUpload(idBlob, 'e-gatepass/ids'));
      }
      const [photoPublicId, idImagePublicId] = await Promise.all(uploads);

      // 3. Create visitor doc
      const formData = getValues();
      const visitorRef = doc(collection(db, 'visitors'));
      const visitorId = visitorRef.id;
      const gatePassRef = doc(collection(db, 'gatePasses'));
      const gatePassId = gatePassRef.id;
      const token = await userCredential.user.getIdToken();
      const response = await fetch('/api/create-pass', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          visitorId,
          passId: gatePassId,
          firstName: formData.firstName,
          middleName: formData.middleName || '',
          lastName: formData.lastName,
          contactNumber: formData.contactNumber,
          purpose: formData.purpose,
          visitDate: formData.visitDate,
          idImagePublicId: idImagePublicId || null,
          photoPublicId,
        }),
      });
      const result = await response.json().catch(() => null) as {
        error?: string;
        passId?: string;
        validFrom?: string | null;
        validUntil?: string | null;
      } | null;
      if (!response.ok || result?.passId !== gatePassId) {
        throw new Error(result?.error || 'Failed to create visitor pass');
      }

      // 6. Generate QR code
      // QR payload is the gate pass document ID (scanner looks up the doc)
      const qrUrl = await toDataURL(gatePassId, {
        width: 300,
        margin: 2,
        color: {
          dark: '#1a1a2e',
          light: '#ffffff',
        },
      });

      setQrDataUrl(qrUrl);
      setPassId(gatePassId);
      setIssuedValidity(result?.validFrom && result.validUntil
        ? formatValidityWindow(result.validFrom, result.validUntil)
        : formatWorkingHours(workingHours));
      setStep('done');
      toast.success('Gate pass generated successfully!');
    } catch (err) {
      await cleanupUploadedImages(uploadedPublicIds);
      console.error('Pass generation error:', err);
      setSubmitError(
        err instanceof Error ? err.message : 'An unexpected error occurred.'
      );
      setStep('review');
      toast.error('Failed to generate pass. Please try again.');
    }
  }

  function downloadQR() {
    if (!qrDataUrl || !passId) return;
    const link = document.createElement('a');
    link.download = `EARIST-GatePass-${passId.slice(0, 8)}.png`;
    link.href = qrDataUrl;
    link.click();
  }

  async function shareQR() {
    if (!passId) return;
    try {
      if (navigator.share) {
        await navigator.share({
          title: 'EARIST Gate Pass',
          text: `Your EARIST Gate Pass ID is: ${passId}. Please present the QR code at the gate.`,
        });
      } else {
        window.location.href = `mailto:?subject=EARIST Gate Pass&body=Your gate pass ID is ${passId}. Please present the QR code at the gate.`;
      }
    } catch (err) {
      console.error('Error sharing:', err);
    }
  }

  // ============================================================
  // RENDER
  // ============================================================
  const steps = [
    { id: 'form', title: 'Details' },
    { id: 'photo', title: 'Photo' },
    ...(!isPeakMode ? [{ id: 'id', title: 'Upload ID' }] : []),
    { id: 'review', title: 'Review' },
  ];

  const currentStepIndex = 
    step === 'done' || step === 'generating' ? steps.length :
    steps.findIndex(s => s.id === step);

  return (
    <PageShell
      headerContent={
        <Link to="/" className="text-sm font-semibold text-[var(--color-earist-maroon)] hover:underline">
          Back to home
        </Link>
      }
    >
      <div className="mx-auto w-full max-w-xl">
        {/* Header */}
        <div className="mb-8 text-center">
          <BrandMark size="lg" className="mx-auto mb-4" />
          <p className="mb-2 text-xs font-bold uppercase tracking-widest text-[var(--color-brand)]">EARIST visitor access</p>
          <h1 className="text-3xl font-bold text-[var(--color-text-primary)]">
            Get Gate Pass
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

              <FormField label="Contact Number" id="visitor-contact" error={errors.contactNumber?.message}>
                <Input
                  id="visitor-contact"
                  type="tel"
                  {...register('contactNumber')}
                  placeholder="09171234567"
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

              {/* Data Privacy Act Consent */}
              <div className="rounded-xl border border-[var(--color-brand)]/20 bg-[var(--color-brand-light)] p-4">
                <label className="flex items-start gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    {...register('consent')}
                    className="mt-1 h-5 w-5 shrink-0 rounded border-[var(--color-border-strong)] text-[var(--color-brand)] focus:ring-[var(--color-brand)]"
                  />
                  <span className="text-sm text-[var(--color-text-primary)]">
                    I consent to the collection and processing of my personal
                    information in accordance with the{' '}
                    <strong>Data Privacy Act of 2012 (RA 10173)</strong>. My
                    data will be used solely for campus visitor management and
                    security purposes.
                  </span>
                </label>
                {errors.consent && (
                  <p className="mt-2 flex items-center gap-1 text-xs text-[var(--color-danger)]" role="alert">
                    <AlertCircle className="h-3 w-3" />
                    {errors.consent.message}
                  </p>
                )}
              </div>

              <Button type="submit" disabled={!isValid} className="w-full" size="lg" icon={<ArrowRight className="h-4 w-4" />}>
                Next: Take Photo
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

              {webcam.error && (
                <div className="rounded-md border border-[var(--color-danger)] bg-[var(--color-danger-light)] p-3 text-sm text-[var(--color-danger-dark)]" role="alert">
                  {webcam.error}
                </div>
              )}

              <div className="mx-auto w-full max-w-xs overflow-hidden rounded-xl border border-[var(--color-border)] shadow-sm bg-black aspect-[3/4] relative">
                {webcam.videoRef && (
                  <video
                    ref={webcam.videoRef}
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
                    webcam.stop();
                    setStep('form');
                  }}
                  className="flex-1"
                  icon={<ArrowLeft className="h-4 w-4" />}
                >
                  Back
                </Button>
                <Button 
                  onClick={onCapturePhoto}
                  disabled={!webcam.isActive}
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
                <h2 className="text-lg font-bold text-[var(--color-text-primary)]">Upload Valid ID</h2>
                <p className="text-sm text-[var(--color-text-secondary)] mt-1">
                  Take a photo or upload an image of your valid government-issued ID.
                </p>
              </div>

              {idPreview ? (
                <div className="space-y-4">
                  <div className="relative mx-auto max-w-xs overflow-hidden rounded-xl border border-[var(--color-border)] shadow-sm">
                    <img src={idPreview} alt="Valid ID preview" className="w-full object-cover" />
                    <button
                      type="button"
                      onClick={() => {
                        if (idPreview) URL.revokeObjectURL(idPreview);
                        setIdBlob(null);
                        setIdPreview(null);
                      }}
                      className="absolute right-2 top-2 rounded-full p-1 text-white bg-black/60 hover:bg-black/80 transition-colors"
                      aria-label="Remove ID image"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                  <div className="flex gap-3">
                    <Button variant="secondary" onClick={onRetakePhoto} className="flex-1" icon={<RotateCcw className="h-4 w-4" />}>
                      Retake Photo
                    </Button>
                    <Button onClick={() => setStep('review')} className="flex-1" icon={<ArrowRight className="h-4 w-4" />}>
                      Review
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="space-y-4">
                  <div
                    className="flex aspect-[3/2] w-full cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed border-[var(--color-border-strong)] bg-[var(--color-canvas)] transition-colors hover:border-[var(--color-brand)] hover:bg-[var(--color-brand-light)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-brand)]"
                    onClick={() => fileInputRef.current?.click()}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        fileInputRef.current?.click();
                      }
                    }}
                  >
                    <Upload className="mb-3 h-10 w-10 text-[var(--color-text-muted)]" />
                    <span className="text-sm font-bold text-[var(--color-text-primary)]">
                      Tap to upload or take a photo
                    </span>
                    <span className="text-xs text-[var(--color-text-muted)] mt-1">
                      JPG, PNG, or WebP — max 5MB
                    </span>
                  </div>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    capture="environment"
                    onChange={onIdFileChange}
                    className="hidden"
                    aria-label="Upload valid ID"
                  />
                  <Button variant="ghost" onClick={onRetakePhoto} className="w-full" icon={<ArrowLeft className="h-4 w-4" />}>
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
                Review Your Pass
              </h2>

              {submitError && (
                <div className="rounded-md border border-[var(--color-danger)] bg-[var(--color-danger-light)] p-3 text-sm text-[var(--color-danger-dark)]" role="alert">
                  {submitError}
                </div>
              )}

              <div className="space-y-4">
                {/* Info summary */}
                <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-canvas)] p-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <span className="text-xs font-semibold text-[var(--color-text-secondary)] uppercase tracking-wider">Name</span>
                      <p className="font-bold text-[var(--color-text-primary)] mt-1">
                        {[getValues('firstName'), getValues('middleName'), getValues('lastName')].filter(Boolean).join(' ')}
                      </p>
                    </div>
                    <div>
                      <span className="text-xs font-semibold text-[var(--color-text-secondary)] uppercase tracking-wider">Contact</span>
                      <p className="font-semibold text-[var(--color-text-primary)] mt-1">{getValues('contactNumber')}</p>
                    </div>
                    <div className="col-span-2">
                      <span className="text-xs font-semibold text-[var(--color-text-secondary)] uppercase tracking-wider">Purpose</span>
                      <p className="font-semibold text-[var(--color-text-primary)] mt-1">{getValues('purpose')}</p>
                    </div>
                    <div className="col-span-2">
                      <span className="text-xs font-semibold text-[var(--color-text-secondary)] uppercase tracking-wider">Visit Date</span>
                      <p className="font-semibold text-[var(--color-text-primary)] mt-1">{getValues('visitDate')}</p>
                    </div>
                  </div>
                </div>

                {/* Photo + ID thumbnails */}
                <div className="flex gap-4">
                  {photoPreview && (
                    <div className="flex-1">
                      <span className="mb-2 block text-xs font-semibold text-[var(--color-text-secondary)] uppercase tracking-wider">Your Photo</span>
                      <img
                        src={photoPreview}
                        alt="Your photo"
                        className="aspect-[3/4] w-full rounded-xl object-cover border border-[var(--color-border)] shadow-sm"
                      />
                    </div>
                  )}
                  {idPreview && (
                    <div className="flex-1">
                      <span className="mb-2 block text-xs font-semibold text-[var(--color-text-secondary)] uppercase tracking-wider">Valid ID</span>
                      <img
                        src={idPreview}
                        alt="Valid ID"
                        className="aspect-[3/4] w-full rounded-xl object-cover border border-[var(--color-border)] shadow-sm"
                      />
                    </div>
                  )}
                </div>
              </div>

              <div className="flex gap-3">
                <Button 
                  variant="secondary" 
                  onClick={() => setStep(isPeakMode ? 'photo' : 'id')} 
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

          {/* ============================== GENERATING ============================== */}
          {step === 'generating' && (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <div className="mb-6 h-12 w-12 animate-spin rounded-full border-4 border-[var(--color-border)] border-t-[var(--color-brand)]" role="status" aria-label="Generating gate pass" />
              <h2 className="text-xl font-bold text-[var(--color-text-primary)]">
                Generating your gate pass…
              </h2>
              <p className="mt-2 text-sm text-[var(--color-text-secondary)] max-w-[250px]">
                Uploading photos and creating your secure QR code.
              </p>
            </div>
          )}

          {/* ============================== STEP 5: DONE ============================== */}
          {step === 'done' && qrDataUrl && (
            <div className="space-y-6 text-center">
              <div className="mx-auto mb-2 flex h-16 w-16 items-center justify-center rounded-full bg-[var(--color-success-light)] text-[var(--color-success)]">
                <CheckCircle2 className="h-8 w-8" />
              </div>

              <div>
                <h2 className="text-2xl font-bold text-[var(--color-text-primary)]">
                  Gate Pass Ready!
                </h2>
                <p className="mt-2 text-sm text-[var(--color-text-secondary)] max-w-[280px] mx-auto">
                  Show this QR code at the entry scanner when you arrive at the gate.
                </p>
              </div>

              <div className="mx-auto w-full max-w-sm overflow-hidden rounded-2xl border border-[var(--color-border)] bg-white text-left shadow-md">
                <div className="flex items-center justify-between border-b border-[var(--color-border)] px-4 py-3">
                  <div className="flex items-center gap-2">
                    <BrandMark size="sm" />
                    <div>
                      <p className="text-sm font-extrabold text-[var(--color-brand)]">E-GatePass</p>
                      <p className="text-xs text-[var(--color-text-muted)]">Digital visitor pass</p>
                    </div>
                  </div>
                  <span className="rounded-full border border-[var(--color-success)] bg-[var(--color-success-light)] px-2.5 py-1 text-xs font-bold text-[var(--color-success-dark)]">QR ready</span>
                </div>
                <div className="flex justify-center p-4">
                  <img src={qrDataUrl} alt="Gate Pass QR Code" className="h-64 w-64 max-w-full" />
                </div>
                <div className="flex gap-2 border-t border-[var(--color-border)] bg-[var(--color-brand-light)] px-4 py-3 text-xs leading-relaxed text-[var(--color-text-secondary)]">
                  <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-brand)]" aria-hidden="true" />
                  <span>Campus security verifies this pass after it is scanned at the entry gate.</span>
                </div>
              </div>

              <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-canvas)] p-4 text-left text-sm">
                <p className="mb-1">
                  <span className="font-semibold text-[var(--color-text-secondary)]">Name:</span>{' '}
                  <span className="font-bold text-[var(--color-text-primary)]">
                    {[getValues('firstName'), getValues('middleName'), getValues('lastName')].filter(Boolean).join(' ')}
                  </span>
                </p>
                <p className="mb-1">
                  <span className="font-semibold text-[var(--color-text-secondary)]">Date:</span>{' '}
                  <span className="font-bold text-[var(--color-text-primary)]">{getValues('visitDate')}</span>
                </p>
                <p>
                  <span className="font-semibold text-[var(--color-text-secondary)]">Valid:</span>{' '}
                  <span className="font-bold text-[var(--color-text-primary)]">{issuedValidity || formatWorkingHours(workingHours)}</span>
                </p>
              </div>

              <div className="flex gap-3">
                <Button variant="secondary" onClick={downloadQR} className="flex-1" icon={<Download className="h-4 w-4" />}>
                  Download
                </Button>
                <Button onClick={shareQR} className="flex-1">
                  Email / Share
                </Button>
              </div>

              <p className="text-xs text-[var(--color-text-muted)]">
                You can also take a screenshot of this page.
              </p>
            </div>
          )}
        </Card>
      </div>
    </PageShell>
  );
}
