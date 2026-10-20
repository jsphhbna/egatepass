import { useState, useRef, useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { collection, doc, getDoc } from 'firebase/firestore';
import { auth, db } from '@/lib/firebase';
import { useWebcam } from '@/hooks/useWebcam';
import { cleanupUploadedImages, compressImageToWebP, uploadToCloudinary } from '@/lib/cloudinary';
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
} from 'lucide-react';
import { toast } from 'sonner';
import { addDays, format } from 'date-fns';
import { Button, Card, Input, FormField, Stepper } from '@/components/ui';
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

type Step = 'form' | 'photo' | 'id' | 'review' | 'generating' | 'done';

export function KioskPage() {
  const [step, setStep] = useState<Step>('form');
  const [photoBlob, setPhotoBlob] = useState<Blob | null>(null);
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const [idBlob, setIdBlob] = useState<Blob | null>(null);
  const [idPreview, setIdPreview] = useState<string | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
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
  const latestVisitDate = format(addDays(new Date(), MAX_VISIT_ADVANCE_DAYS), 'yyyy-MM-dd');

  function onFormNext(data: KioskPassFormData) {
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
      toast.error('Failed to capture photo.');
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

    const uploadedPublicIds: string[] = [];
    try {
      const user = auth.currentUser;
      if (!user) throw new Error('Kiosk device not authenticated');

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

      const formData = getValues();
      const visitorRef = doc(collection(db, 'visitors'));
      const visitorId = visitorRef.id;
      const gatePassRef = doc(collection(db, 'gatePasses'));
      const gatePassId = gatePassRef.id;
      const token = await user.getIdToken();
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

      const qrUrl = await toDataURL(gatePassId, {
        width: 300,
        margin: 2,
        color: { dark: '#000000', light: '#ffffff' },
      });

      setQrDataUrl(qrUrl);
      setIssuedValidity(result?.validFrom && result.validUntil
        ? formatValidityWindow(result.validFrom, result.validUntil)
        : formatWorkingHours(workingHours));
      setStep('done');
      toast.success('Pass generated!');
    } catch (err) {
      await cleanupUploadedImages(uploadedPublicIds);
      console.error(err);
      setSubmitError('Failed to generate pass.');
      setStep('review');
    }
  }

  function handlePrint() {
    window.print();
  }

  function handleNextVisitor() {
    reset();
    setPhotoBlob(null);
    if (photoPreview) URL.revokeObjectURL(photoPreview);
    setPhotoPreview(null);
    setIdBlob(null);
    if (idPreview) URL.revokeObjectURL(idPreview);
    setIdPreview(null);
    setQrDataUrl(null);
    setIssuedValidity(null);
    setStep('form');
  }

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
    <main id="main-content" className="mx-auto flex min-h-dvh w-full max-w-7xl flex-col items-center justify-center gap-8 bg-[var(--color-canvas)] px-4 py-8 lg:flex-row lg:items-start lg:py-10">
      {/* Left Column (Fixed on Desktop) */}
      <div className="w-full max-w-lg lg:w-[320px] lg:shrink-0 lg:sticky lg:top-12 flex flex-col items-center lg:items-start print:hidden">
        
        {/* Header */}
        <div className="mb-8 text-center lg:text-left w-full">
          <div 
            onDoubleClick={() => {
              if (window.confirm('Admin: Sign out of this device?')) {
                auth.signOut();
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
          {step === 'form' && (
            <form onSubmit={handleSubmit(onFormNext)} className="space-y-5" noValidate>
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

              <Button type="submit" disabled={!isValid} className="w-full" size="lg" icon={<ArrowRight className="h-4 w-4" />}>
                Next: Take Photo
              </Button>
            </form>
          )}

          {step === 'photo' && (
            <div className="space-y-6">
              <div className="text-center">
                <h2 className="text-lg font-bold text-[var(--color-text-primary)]">Take Your Photo</h2>
              </div>
              <div className="mx-auto w-full max-w-xs overflow-hidden rounded-xl border border-[var(--color-border)] shadow-sm bg-black aspect-[3/4] relative">
                <video ref={webcam.videoRef} autoPlay playsInline muted className="h-full w-full object-cover -scale-x-100" />
              </div>
              <div className="flex gap-3">
                <Button variant="secondary" type="button" onClick={() => setStep('form')} className="flex-1" icon={<ArrowLeft className="h-4 w-4" />}>
                  Back
                </Button>
                <Button type="button" onClick={onCapturePhoto} disabled={!webcam.isActive} className="flex-1" icon={<Camera className="h-4 w-4" />}>
                  Capture
                </Button>
              </div>
            </div>
          )}

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
                    <Button variant="secondary" type="button" onClick={onRetakePhoto} className="flex-1" icon={<RotateCcw className="h-4 w-4" />}>
                      Retake Photo
                    </Button>
                    <Button type="button" onClick={() => setStep('review')} className="flex-1" icon={<ArrowRight className="h-4 w-4" />}>
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
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') fileInputRef.current?.click();
                    }}
                  >
                    <Upload className="mb-3 h-10 w-10 text-[var(--color-text-muted)]" />
                    <span className="text-sm font-bold text-[var(--color-text-primary)]">Tap to upload ID</span>
                  </div>
                  <input ref={fileInputRef} type="file" accept="image/*" onChange={onIdFileChange} className="hidden" />
                </div>
              )}
            </div>
          )}

          {step === 'review' && (
            <div className="space-y-6">
              <h2 className="text-center text-lg font-bold text-[var(--color-text-primary)]">Review Pass</h2>
              {submitError && <div className="rounded-md border border-[var(--color-danger)] bg-[var(--color-danger-light)] p-3 text-sm text-[var(--color-danger-dark)]" role="alert">{submitError}</div>}
              
              <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-canvas)] p-4 text-sm">
                <p className="mb-2"><strong className="text-[var(--color-text-secondary)]">Name:</strong> {[getValues('firstName'), getValues('middleName'), getValues('lastName')].filter(Boolean).join(' ')}</p>
                <p><strong className="text-[var(--color-text-secondary)]">Purpose:</strong> {getValues('purpose')}</p>
              </div>

              <div className="flex gap-3">
                <Button variant="secondary" type="button" onClick={() => {
                  if (isPeakMode) {
                    setStep('photo');
                  } else {
                    setStep('id');
                  }
                }} className="flex-1" icon={<ArrowLeft className="h-4 w-4" />}>
                  Back
                </Button>
                <Button type="button" onClick={onSubmit} className="flex-1" icon={<CheckCircle2 className="h-4 w-4" />}>
                  Generate
                </Button>
              </div>
            </div>
          )}

          {step === 'generating' && (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <div className="mb-6 h-12 w-12 animate-spin rounded-full border-4 border-[var(--color-border)] border-t-[var(--color-brand)]" role="status" aria-label="Generating gate pass" />
              <p className="text-xl font-bold text-[var(--color-text-primary)]">Generating gate pass…</p>
            </div>
          )}

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
                <Button variant="secondary" type="button" onClick={handlePrint} className="flex-1" icon={<Printer className="h-4 w-4" />}>
                  Print Pass
                </Button>
                <Button type="button" onClick={handleNextVisitor} className="flex-1">
                  Next Visitor
                </Button>
              </div>
            </div>
          )}
        </Card>
      </div>
    </main>
  );
}
