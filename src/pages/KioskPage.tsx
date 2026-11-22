import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useWebcam } from '@/hooks/useWebcam';
import { useObjectUrl } from '@/hooks/useObjectUrl';
import { compressImageToWebP, normalizeIdentityDocumentImage } from '@/lib/imageProcessing';
import {
  issueVisitorPass,
  loadRegistrationSettings,
  PassIssuanceError,
  type IssueTransaction,
  type IssuedPass,
  type VisitorRegistration,
} from '@/services/visitorRegistration';
import QRCode from 'qrcode';
import {
  Camera,
  CheckCircle2,
  ArrowLeft,
  ArrowRight,
  AlertCircle,
  AlertTriangle,
  Building2,
  Car,
  User,
  X,
  RotateCcw,
  Printer,
  Mail,
  Scan,
  Loader2,
  LogOut,
  Sparkles,
  ShieldCheck,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button, Card, Input, FormField, Stepper, Modal, ProgressBar } from '@/components/ui';
import { EmailPassModal } from '@/components/EmailPassModal';
import { BrandMark } from '@/components/BrandMark';
import { VisitPurposeField } from '@/components/VisitPurposeField';
import { StructuredAddressField } from '@/components/StructuredAddressField';
import type { SelectedPsgcAddress } from '@/components/AddressCascadingSelector';
import { InstitutionalPrivacyNoticeModal } from '@/components/InstitutionalPrivacyNoticeModal';
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
import { recognizeIdImage, terminateLocalOcrWorker, getNextOcrJobId } from '@/lib/ocr';
import { parseAddressFromOcr } from '@/lib/addressOcr';
import { generateBrandedQrDataUrl } from '@/lib/brandedQr';
import { CameraControls } from '@/components/CameraControls';
import {
  SELFIE_TARGET_ASPECT_RATIO,
  SELFIE_OVAL_WIDTH_PERCENT,
  SELFIE_OVAL_HEIGHT_PERCENT,
} from '@/lib/selfieFramingContract';

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
      .trim()
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

type Step =
  | 'scan-intro'
  | 'scan-camera'
  | 'scan-processing'
  | 'form'
  | 'visit'
  | 'photo'
  | 'id'
  | 'verify'
  | 'review'
  | 'generating'
  | 'done';

export interface KioskOffice {
  id: string;
  name: string;
  description?: string;
  closure_status?: 'open' | 'closed';
  closure_reason?: string | null;
  closed_at?: string | null;
  personnel?: Array<{ id: string; name: string; position?: string }>;
}

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
  const [calendarClosures, setCalendarClosures] = useState<import('@/types').CampusCalendarClosure[]>([]);
  const [ocrSuccessNotice, setOcrSuccessNotice] = useState(false);
  const [showSignOutConfirm, setShowSignOutConfirm] = useState(false);
  const [currentPassPresentation, setCurrentPassPresentation] = useState<PassPresentation | null>(null);
  const [showPrinterSettings, setShowPrinterSettings] = useState(false);
  const [printFailed, setPrintFailed] = useState(false);

  // Step 1: Personal Details (Gender & Structured Address)
  const [gender, setGender] = useState<'Male' | 'Female' | 'Other'>('Male');
  const [selectedPsgc, setSelectedPsgc] = useState<SelectedPsgcAddress | null>(null);
  const [houseBuilding, setHouseBuilding] = useState('');
  const [street, setStreet] = useState('');
  const [localityError, setLocalityError] = useState<string | null>(null);

  // Step 2: Visit & Destination Office
  const [offices, setOffices] = useState<KioskOffice[]>([]);
  const [selectedOfficeId, setSelectedOfficeId] = useState<string>('');
  const [personnelList, setPersonnelList] = useState<Array<{ id: string; name: string; position?: string }>>([]);
  const [selectedPersonnel, setSelectedPersonnel] = useState<string>('');
  const [visitType, setVisitType] = useState<'general' | 'personnel'>('general');
  const [arrivalMode, setArrivalMode] = useState<'walk_in' | 'vehicle'>('walk_in');
  const [vehicleType, setVehicleType] = useState<string>('car');
  const [plateNumber, setPlateNumber] = useState<string>('');

  // Step 4 & 5: Dual OCR & Verification
  const [idType, setIdType] = useState<string>('National ID');
  const [ocrProgress, setOcrProgress] = useState<{ percent: number; status: string }>({ percent: 0, status: '' });
  const [detectedOcrAddress, setDetectedOcrAddress] = useState<any>(null);
  const ocrJobIdRef = useRef(0);

  // Step 6: Review & Institutional Privacy Notice
  const [showPrivacyModal, setShowPrivacyModal] = useState(false);

  const printer = useThermalPrinter();
  const {
    status: printerStatus,
    config: printerConfig,
    printPass,
    isPrintBusy,
  } = printer;
  const isPrinting = printerStatus === 'printing';
  const isAutoPrintEnabled = printerConfig.autoPrint;
  const visitorSessionGenerationRef = useRef(0);

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
  const [issuancePhase, setIssuancePhase] = useState('Securing visitor record…');

  type KioskConfigState = 'loading' | 'ready' | 'error';
  const [configState, setConfigState] = useState<KioskConfigState>('loading');
  const [retryingConfig, setRetryingConfig] = useState(false);
  const [isProcessingId, setIsProcessingId] = useState(false);
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [visitorInstructions, setVisitorInstructions] = useState<string[]>([
    'Follow the EARIST visitor dress code and campus policies.',
    'Bring a valid ID for identity verification at the gate.',
    'Keep your E-GatePass ready before approaching the entrance.',
    'This visitor pass is personal and non-transferable.',
    'Scan your E-GatePass when leaving the campus.',
  ]);
  const [photoRetentionDays, setPhotoRetentionDays] = useState<number | null>(null);
  const [idRetentionDays, setIdRetentionDays] = useState<number | null>(null);
  const [visitorRetentionDays, setVisitorRetentionDays] = useState<number | null>(null);

  const loadSettings = useCallback(async (isRetry = false) => {
    if (isRetry) setRetryingConfig(true);
    else setConfigState((prev) => (prev === 'ready' ? 'ready' : 'loading'));

    try {
      const data = await loadRegistrationSettings('kiosk');
      const peakActive = data.peak_mode === 'kiosk' || data.peak_mode === 'both';
      setIsPeakMode(peakActive);
      // Select workflow (form vs scan-intro) only after authoritative configuration is loaded:
      // setStep(peakActive ? 'form' : 'scan-intro');
      // Never reset an active visitor session on 'form', 'photo', 'id', or 'review'
      setStep((prev) => (prev === 'scan-intro' ? (peakActive ? 'form' : 'scan-intro') : prev));
      setVisitPurposes(normalizeVisitPurposes(data.visit_purposes));
      setWorkingHours(normalizeWorkingHours({
        start: data.working_hours_start?.slice(0, 5),
        end: data.working_hours_end?.slice(0, 5),
        timezone: data.timezone,
      }));
      if (typeof data.scheduling_days_ahead === 'number') {
        setSchedulingDaysAhead(data.scheduling_days_ahead);
      }
      if (Array.isArray(data.visitor_instructions) && data.visitor_instructions.length > 0) {
        setVisitorInstructions(data.visitor_instructions);
      }
      if (typeof data.photo_retention_days === 'number') {
        setPhotoRetentionDays(data.photo_retention_days);
      }
      if (typeof data.id_retention_days === 'number') {
        setIdRetentionDays(data.id_retention_days);
      }
      if (typeof data.visitor_retention_days === 'number') {
        setVisitorRetentionDays(data.visitor_retention_days);
      }
      void fetch('/api/system/calendar')
        .then((res) => (res.ok ? res.json() : null))
        .then((calData) => {
          if (calData?.closures) {
            setCalendarClosures(calData.closures);
          }
        })
        .catch(() => {
          // non-fatal
        });
      void fetch('/api/office/personnel')
        .then((res) => (res.ok ? res.json() : null))
        .then((officeData) => {
          if (officeData?.offices && Array.isArray(officeData.offices)) {
            setOffices(officeData.offices);
          }
        })
        .catch(() => {});
      setConfigState('ready');
    } catch {
      setConfigState((prev) => (prev === 'ready' ? prev : 'error'));
    } finally {
      setRetryingConfig(false);
    }
  }, []);

  useEffect(() => {
    void loadSettings();
    const interval = setInterval(() => {
      if (typeof document !== 'undefined' && !document.hidden && navigator.onLine) {
        void loadSettings();
      }
    }, 60000);

    const handleVisibilityChange = () => {
      if (typeof document !== 'undefined' && !document.hidden && navigator.onLine) {
        void loadSettings();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [loadSettings]);

  const faceWebcam = useWebcam({ facingMode: 'user', width: 720, height: 960, targetAspectRatio: SELFIE_TARGET_ASPECT_RATIO, allowCaptureMirroring: false });
  const idWebcam = useWebcam({ facingMode: 'environment', width: 1920, height: 1080, allowCaptureMirroring: false, focusMode: 'continuous' });
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

  // Synchronize office personnel list when selected office changes
  useEffect(() => {
    if (!selectedOfficeId) {
      setPersonnelList([]);
      setSelectedPersonnel('');
      return;
    }
    const found = offices.find((o) => o.id === selectedOfficeId);
    if (found?.personnel) {
      setPersonnelList(found.personnel);
    } else {
      setPersonnelList([]);
      setSelectedPersonnel('');
    }
  }, [selectedOfficeId, offices]);

  const formSchema = useMemo(() => createKioskPassSchema(schedulingDaysAhead), [schedulingDaysAhead]);

  // Manila-aware calendar date limits
  const today = getManilaDateString();
  const latestVisitDate = getLatestVisitDateString(today, schedulingDaysAhead);

  const {
    register,
    getValues,
    reset,
    setValue,
    watch,
    formState: { errors },
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
      const normalized = await normalizeIdentityDocumentImage(blob);
      const compressed = await compressImageToWebP(normalized);
      if (generation !== ocrGenerationRef.current) return;
      kioskTransactionRef.current.idIntentId = null;
      kioskTransactionRef.current.idCheckpoint = null;
      kioskTransactionRef.current.phase = 'editable';
      setIdBlob(compressed);
      idUrl.setFromBlob(compressed);

      // Offline OCR via self-hosted worker with cancellation check and threshold 60
      const currentJobId = getNextOcrJobId();
      ocrJobIdRef.current = currentJobId;

      const parsed = await recognizeIdImage(
        blob,
        (percent, status) => {
          if (generation === ocrGenerationRef.current && ocrJobIdRef.current === currentJobId) {
            setOcrProgress({ percent, status: status || 'Reading ID details…' });
          }
        },
        currentJobId
      );
      if (generation !== ocrGenerationRef.current || ocrJobIdRef.current !== currentJobId) return;

      let filledCount = 0;
      let weakCount = 0;
      const CONFIDENCE_THRESHOLD = 60;
      const isFieldConfident = (fieldName: 'firstName' | 'middleName' | 'lastName'): boolean => {
        const candidate = parsed.fieldCandidates?.[fieldName];
        if (candidate) return candidate.confidence >= CONFIDENCE_THRESHOLD;
        return (parsed.confidence ?? 0) >= CONFIDENCE_THRESHOLD;
      };

      if (parsed.firstName) {
        if (isFieldConfident('firstName')) {
          setValue('firstName', parsed.firstName, { shouldDirty: true, shouldValidate: true });
          filledCount++;
        } else {
          weakCount++;
        }
      }
      if (parsed.middleName) {
        if (isFieldConfident('middleName')) {
          setValue('middleName', parsed.middleName, { shouldDirty: true, shouldValidate: true });
          filledCount++;
        } else {
          weakCount++;
        }
      }
      if (parsed.lastName) {
        if (isFieldConfident('lastName')) {
          setValue('lastName', parsed.lastName, { shouldDirty: true, shouldValidate: true });
          filledCount++;
        } else {
          weakCount++;
        }
      }

      if (parsed.address) {
        const detected = parseAddressFromOcr(parsed.address);
        if (detected) {
          setDetectedOcrAddress(detected);
        }
      }

      if (filledCount >= 1) {
        setOcrSuccessNotice(true);
        toast.success('Details read from ID! Please review and complete your information.');
      } else if (weakCount > 0) {
        setOcrSuccessNotice(false);
        toast.info("Some text was found on the ID, but confidence was low. Please verify your details.");
      } else {
        setOcrSuccessNotice(false);
        toast.info("We couldn't clearly read the name from this ID. Please enter or correct your details manually.");
      }
    } catch (err) {
      if (generation !== ocrGenerationRef.current) return;
      console.warn('Local OCR warning:', err);
      setOcrSuccessNotice(false);
      toast.info('Automatic ID reading is unavailable right now. Your ID photo was kept. Please enter your name manually.');
    } finally {
      if (generation === ocrGenerationRef.current) {
        if (photoBlob) {
          setStep('verify');
        } else {
          setStep('form');
        }
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

  function onFormNext() {
    const fName = getValues('firstName')?.trim();
    const lName = getValues('lastName')?.trim();
    const contact = getValues('contactNumber')?.trim();

    if (!fName || fName.length < 2) {
      toast.error('First name must be at least 2 characters');
      return;
    }
    if (!lName || lName.length < 2) {
      toast.error('Last name must be at least 2 characters');
      return;
    }
    if (!contact || contact.length < 7) {
      toast.error('Please enter a valid Philippine mobile contact number');
      return;
    }
    if (!selectedPsgc) {
      setLocalityError('Please select your residential locality (City/Municipality and Barangay).');
      toast.error('Please select your residential locality');
      return;
    }
    setLocalityError(null);
    setStep('visit');
  }

  function onVisitNext() {
    if (!selectedOfficeId) {
      toast.error('Please select a destination university office');
      return;
    }
    const chosenOffice = offices.find((o) => o.id === selectedOfficeId);
    if (chosenOffice?.closure_status === 'closed') {
      toast.error(`The ${chosenOffice.name} is temporarily closed: ${chosenOffice.closure_reason || 'Emergency closure'}. Please choose an open office.`);
      return;
    }
    const purp = getValues('purpose')?.trim();
    if (!purp || purp.length < 3) {
      toast.error('Please specify your purpose of visit');
      return;
    }
    const visitDateVal = getValues('visitDate');
    const matchedClosure = calendarClosures.find((c) => c.active !== false && visitDateVal >= c.startDate && visitDateVal <= c.endDate);
    if (matchedClosure) {
      toast.error(`Campus is closed on ${visitDateVal}: ${matchedClosure.title}${matchedClosure.description ? ` (${matchedClosure.description})` : ''}. Please select an open date.`);
      return;
    }
    if (arrivalMode === 'vehicle' && !plateNumber.trim()) {
      toast.error('Please enter your vehicle plate number');
      return;
    }

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
        setStep('verify');
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
        const normalized = await normalizeIdentityDocumentImage(blob);
        const compressed = await compressImageToWebP(normalized);
        kioskTransactionRef.current.idIntentId = null;
        kioskTransactionRef.current.idCheckpoint = null;
        kioskTransactionRef.current.phase = 'editable';
        setIdBlob(compressed);
        idUrl.setFromBlob(compressed);
        void processIdImageAndOcr(blob);
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
    setIssuancePhase('Securing visitor record & tokens…');
    setStep('generating');
    setSubmitError(null);

    let result: IssuedPass;
    const formData = getValues();
    const effectiveVisitor: VisitorRegistration = {
      firstName: formData.firstName.trim(),
      middleName: formData.middleName?.trim() || undefined,
      lastName: formData.lastName.trim(),
      gender: gender as any,
      contactNumber: formData.contactNumber.trim(),
      purpose: formData.purpose.trim(),
      visitDate: formData.visitDate,
      consent: true,
      officeId: selectedOfficeId || undefined,
      arrivalMode: arrivalMode === 'vehicle' ? 'vehicle' : 'no_vehicle',
      vehicle: arrivalMode === 'vehicle' && plateNumber.trim() ? {
        vehicleType: vehicleType || 'car',
        plateNumber: plateNumber.trim().toUpperCase(),
      } : null,
      homeAddress: selectedPsgc
        ? [houseBuilding, street, selectedPsgc.barangay.name, selectedPsgc.city.name, selectedPsgc.province?.name, selectedPsgc.region.name].filter(Boolean).join(', ')
        : undefined,
      psgc: selectedPsgc ? {
        version: selectedPsgc.version,
        regionCode: selectedPsgc.region.code,
        provinceCode: selectedPsgc.province?.code ?? null,
        cityCode: selectedPsgc.city.code,
        barangayCode: selectedPsgc.barangay.code,
        houseBuilding: houseBuilding.trim() || undefined,
        street: street.trim() || undefined,
      } : null,
    };

    try {
      result = await issueVisitorPass(
        'kiosk',
        effectiveVisitor,
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
    setIssuancePhase('Generating secure QR pass…');
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

    const finalVisitor = kioskTransactionRef.current?.submittedPayload?.visitor ?? effectiveVisitor;

    const presentation = createPassPresentation({
      visitorName: [finalVisitor.firstName, finalVisitor.middleName, finalVisitor.lastName].filter(Boolean).join(' '),
      visitDate: finalVisitor.visitDate,
      passReference: result.publicReference || result.passId,
      qrToken: result.qrToken,
      purpose: finalVisitor.purpose,
      validityWindow: validity ?? undefined,
    });

    if (!qrUrl) {
      toast.error('Pass was issued, but visual QR code generation failed. Please notify the guard station.');
      return;
    }

    setCurrentPassPresentation(presentation);
    setQrDataUrl(qrUrl);
    setStep('done');
    toast.success('Gate pass issued!');

    // Critical invariant: PRINT FAILURE MUST NEVER ROLL BACK PASS ISSUANCE.
    if (isAutoPrintEnabled && printerStatus === 'connected') {
      const sessionGen = visitorSessionGenerationRef.current;
      try {
        await printPass(presentation);
        if (sessionGen === visitorSessionGenerationRef.current) {
          setPrintFailed(false);
          toast.success('Pass printed via MXW01');
        }
      } catch (printErr: any) {
        if (printErr?.message === 'print_in_progress') return;
        console.warn('Auto print failed:', printErr);
        if (sessionGen === visitorSessionGenerationRef.current) {
          setPrintFailed(true);
          toast.error('Direct thermal print failed. Printer unavailable.');
        }
      }
    }
  }

  async function handlePrint() {
    if (isPrintBusy || isPrinting) return;
    if (currentPassPresentation && printerStatus === 'connected') {
      const sessionGen = visitorSessionGenerationRef.current;
      try {
        await printPass(currentPassPresentation);
        if (sessionGen === visitorSessionGenerationRef.current) {
          setPrintFailed(false);
          toast.success('Pass printed via MXW01');
        }
      } catch (printErr: any) {
        if (printErr?.message === 'print_in_progress') return;
        console.warn('Direct print failed, falling back to browser print:', printErr);
        if (sessionGen === visitorSessionGenerationRef.current) {
          setPrintFailed(true);
          toast.error('Direct thermal printing unavailable. Opening browser print.');
          window.print();
        }
      }
    } else {
      window.print();
    }
  }

  function resetCurrentVisitor() {
    visitorSessionGenerationRef.current += 1;
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
    setSelectedPsgc(null);
    setHouseBuilding('');
    setStreet('');
    setGender('Male');
    setSelectedOfficeId('');
    setSelectedPersonnel('');
    setVisitType('general');
    setArrivalMode('walk_in');
    setVehicleType('car');
    setPlateNumber('');
    setLocalityError(null);
    setDetectedOcrAddress(null);
    setShowPrivacyModal(false);
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
    void loadSettings();
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
    { id: 'form', title: '1. Personal' },
    { id: 'visit', title: '2. Visit' },
    { id: 'photo', title: '3. Live Face' },
    { id: 'id', title: '4. Valid ID' },
    { id: 'verify', title: '5. Verify' },
    { id: 'review', title: '6. Review' },
  ];

  const currentStepIndex =
    step === 'done' || step === 'generating'
      ? steps.length
      : step === 'scan-intro' || step === 'scan-camera' || step === 'scan-processing'
      ? 0
      : steps.findIndex((s) => s.id === step);

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
            <span>
              Printer ({
                printerStatus === 'connected'
                  ? 'Ready'
                  : printerStatus === 'connecting'
                  ? 'Connecting'
                  : printerStatus === 'printing'
                  ? 'Printing'
                  : printerStatus === 'error'
                  ? 'Error'
                  : 'Offline'
              })
            </span>
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
            <div className="py-16 px-6 text-center space-y-5" role="status" aria-live="polite">
              <div className="relative mx-auto flex h-16 w-16 items-center justify-center">
                <span className="absolute -inset-2 rounded-full bg-[var(--color-brand)]/10 animate-pulse" aria-hidden="true" />
                <img src="/earist-logo.png" alt="EARIST seal" className="relative h-14 w-14 object-contain" />
              </div>
              <div className="space-y-1">
                <h2 className="text-lg font-bold text-[var(--color-text-primary)]">Preparing kiosk registration…</h2>
                <p className="text-sm text-[var(--color-text-secondary)]">Loading campus visit settings.</p>
              </div>
              <div className="mx-auto max-w-xs">
                <ProgressBar indeterminate variant="brand" size="sm" />
              </div>
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
              <div className="mt-4 p-4 rounded-xl border border-amber-300 bg-amber-50 text-amber-950 text-sm font-medium max-w-sm mx-auto">
                <p className="font-bold text-xs uppercase tracking-wider mb-1 text-amber-900">
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
                  Scan ID
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

              <div
                className="mx-auto w-full max-w-md overflow-hidden rounded-2xl border-2 border-[var(--color-brand)] shadow-inner bg-black aspect-[3/2] relative flex items-center justify-center cursor-pointer"
                onClick={() => void idWebcam.refocus?.()}
                title="Tap camera to refocus"
              >
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
                    <div
                      className="absolute inset-0 h-full w-full overflow-hidden"
                      style={{
                        transform: idWebcam.mirrorPreview ? 'rotateY(180deg) translateZ(0)' : 'none',
                        WebkitTransform: idWebcam.mirrorPreview ? 'rotateY(180deg) translateZ(0)' : 'none',
                        backfaceVisibility: 'visible',
                        WebkitBackfaceVisibility: 'visible',
                      }}
                    >
                      <video
                        ref={idWebcam.videoRef}
                        autoPlay
                        playsInline
                        muted
                        style={{ transform: 'none' }}
                        className="h-full w-full object-cover block shrink-0"
                      />
                    </div>
                    {/* ID Document Framing Guidelines */}
                    <div className="absolute inset-0 pointer-events-none flex items-center justify-center p-3">
                      <div className="w-full max-w-[280px] aspect-[85.6/53.98] border-2 border-dashed border-white/70 rounded-xl flex items-end justify-center pb-2 shadow-[0_0_0_9999px_rgba(0,0,0,0.35)]">
                        <span className="text-[10px] text-white/95 bg-black/60 px-2 py-0.5 rounded backdrop-blur-xs font-medium">
                          Align ID inside frame (~15–20 cm) • Tap to focus
                        </span>
                      </div>
                    </div>

                    {idWebcam.isActive && (
                      <CameraControls
                        activeFacingMode={idWebcam.activeFacingMode}
                        mirrorPreview={idWebcam.mirrorPreview}
                        canSwitchCamera={idWebcam.canSwitchCamera}
                        onSwitchCamera={idWebcam.switchCamera}
                        onToggleMirror={idWebcam.toggleMirrorPreview}
                        onRefocus={idWebcam.refocus}
                      />
                    )}
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
            <div className="flex flex-col items-center justify-center py-12 px-4 text-center space-y-5" role="status" aria-live="polite">
              <div className="relative h-28 w-44 overflow-hidden rounded-xl border-2 border-[var(--color-brand)] bg-slate-900 shadow-md flex items-center justify-center">
                {idPreview ? (
                  <img src={idPreview} alt="Captured ID preview" className="h-full w-full object-cover opacity-60" />
                ) : (
                  <div className="h-10 w-16 rounded border border-white/30 bg-white/10" />
                )}
                <div className="absolute inset-x-0 h-0.5 bg-gradient-to-r from-transparent via-red-400 to-transparent shadow-[0_0_8px_rgba(239,68,68,0.8)] animate-scan-line" />
              </div>

              <div className="w-full max-w-sm space-y-2">
                <h3 className="text-lg font-bold text-[var(--color-text-primary)]">Reading ID Details…</h3>
                <ProgressBar indeterminate variant="brand" size="sm" phase={ocrProgress.status || 'Extracting text & fields…'} />
                <p className="text-xs text-[var(--color-text-secondary)] mt-1">
                  Using local on-device recognition. The ID image is uploaded only to private campus storage upon your review and submission.
                </p>
              </div>
            </div>
          )}

          {/* STEP 1: Personal Details */}
          {step === 'form' && (
            <div className="space-y-5">
              <div className="text-center">
                <h2 className="text-xl font-bold text-[var(--color-text-primary)]">1. Personal Details</h2>
                <p className="text-xs text-[var(--color-text-secondary)] mt-0.5">
                  Enter your name, contact number, and residential locality.
                </p>
              </div>

              <div className="rounded-xl border border-sky-200 bg-sky-50 p-3 text-xs">
                <p className="font-semibold text-sky-950">Walk-in Visitor Registration</p>
                <p className="mt-0.5 text-slate-700">This registration issues a single-visit campus pass. Fields marked * are required.</p>
              </div>

              {ocrSuccessNotice && (
                <div className="rounded-xl border border-[var(--color-brand)]/20 bg-[var(--color-brand-light)] p-3 text-xs text-[var(--color-brand)] flex items-center gap-2">
                  <CheckCircle2 className="h-4 w-4 shrink-0" />
                  <span>Information autofilled from your ID! Please check and complete your locality.</span>
                </div>
              )}

              <div className="space-y-4">
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <FormField label="First Name" requirement="required" id="kiosk-first-name" error={errors.firstName?.message}>
                    <Input id="kiosk-first-name" {...register('firstName')} error={!!errors.firstName} required aria-required="true" placeholder="Juan" />
                  </FormField>
                  <FormField label="Middle Name" requirement="optional" id="kiosk-middle-name" error={errors.middleName?.message}>
                    <Input id="kiosk-middle-name" {...register('middleName')} error={!!errors.middleName} placeholder="Santos" />
                  </FormField>
                  <FormField label="Last Name" requirement="required" id="kiosk-last-name" error={errors.lastName?.message}>
                    <Input id="kiosk-last-name" {...register('lastName')} error={!!errors.lastName} required aria-required="true" placeholder="Dela Cruz" />
                  </FormField>
                </div>

                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <FormField label="Contact Number" requirement="required" id="kiosk-phone" hint="Philippine mobile number" error={errors.contactNumber?.message}>
                    <Input id="kiosk-phone" type="tel" placeholder="0917 123 4567" {...register('contactNumber')} error={!!errors.contactNumber} required aria-required="true" />
                  </FormField>

                  <div>
                    <label className="block text-xs font-semibold text-[var(--color-text-primary)] mb-1">
                      Gender <span className="text-red-500">*</span>
                    </label>
                    <div className="grid grid-cols-3 gap-2">
                      {(['Male', 'Female', 'Other'] as const).map((g) => (
                        <button
                          key={g}
                          type="button"
                          onClick={() => setGender(g)}
                          className={`min-h-[44px] rounded-xl border text-xs font-semibold transition-all ${
                            gender === g
                              ? 'border-[#7A0A0A] bg-[#F8EEEE] text-[#7A0A0A] shadow-xs'
                              : 'border-[var(--color-border)] bg-white text-[var(--color-text-primary)] hover:border-slate-300'
                          }`}
                        >
                          {g}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                {/* Structured Address (Municipality first, then Barangay) */}
                <div className="pt-2">
                  <StructuredAddressField
                    value={selectedPsgc}
                    onChange={(addr) => {
                      setSelectedPsgc(addr);
                      if (addr) setLocalityError(null);
                    }}
                    houseBuilding={houseBuilding}
                    onHouseBuildingChange={setHouseBuilding}
                    street={street}
                    onStreetChange={setStreet}
                    error={localityError || undefined}
                  />
                  {detectedOcrAddress && !selectedPsgc && (
                    <div className="mt-2 rounded-lg border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900 flex items-center justify-between">
                      <span>Address found on ID: {detectedOcrAddress.matchedCity || detectedOcrAddress.matchedProvince || detectedOcrAddress.raw}</span>
                    </div>
                  )}
                </div>
              </div>

              <div className="flex gap-3 pt-3">
                <Button
                  variant="secondary"
                  type="button"
                  onClick={() => {
                    resetCurrentVisitor();
                  }}
                  className="flex-1 min-h-[48px]"
                  icon={<ArrowLeft className="h-4 w-4" />}
                >
                  Start Over
                </Button>
                <Button
                  type="button"
                  onClick={onFormNext}
                  className="flex-1 min-h-[48px]"
                  icon={<ArrowRight className="h-4 w-4" />}
                >
                  Next: Visit Details
                </Button>
              </div>
            </div>
          )}

          {/* STEP 2: Visit & Destination Office */}
          {step === 'visit' && (
            <div className="space-y-6">
              <div className="text-center">
                <h2 className="text-xl font-bold text-[var(--color-text-primary)]">2. Visit & Destination Office</h2>
                <p className="text-xs text-[var(--color-text-secondary)] mt-0.5">
                  Select the campus office you are visiting, purpose, and arrival mode.
                </p>
              </div>

              {/* Arrival Mode Selection */}
              <div className="space-y-2">
                <label className="block text-xs font-bold uppercase tracking-wider text-[var(--color-text-primary)]">
                  Mode of Arrival <span className="text-[var(--color-brand)]">*</span>
                </label>
                <div className="grid grid-cols-2 gap-3">
                  <button
                    type="button"
                    onClick={() => setArrivalMode('walk_in')}
                    className={`flex items-center gap-3 p-3.5 rounded-2xl border text-left transition-all min-h-[48px] ${
                      arrivalMode === 'walk_in'
                        ? 'border-[#7A0A0A] bg-[#F8EEEE] text-[#7A0A0A] shadow-xs'
                        : 'border-[var(--color-border)] bg-white text-[var(--color-text-primary)] hover:border-slate-300'
                    }`}
                  >
                    <User className="h-5 w-5 shrink-0" />
                    <div>
                      <p className="font-bold text-xs">On Foot / Commute</p>
                      <p className="text-[10px] text-[var(--color-text-secondary)]">No vehicle brought</p>
                    </div>
                  </button>

                  <button
                    type="button"
                    onClick={() => setArrivalMode('vehicle')}
                    className={`flex items-center gap-3 p-3.5 rounded-2xl border text-left transition-all min-h-[48px] ${
                      arrivalMode === 'vehicle'
                        ? 'border-[#7A0A0A] bg-[#F8EEEE] text-[#7A0A0A] shadow-xs'
                        : 'border-[var(--color-border)] bg-white text-[var(--color-text-primary)] hover:border-slate-300'
                    }`}
                  >
                    <Car className="h-5 w-5 shrink-0" />
                    <div>
                      <p className="font-bold text-xs">With Vehicle</p>
                      <p className="text-[10px] text-[var(--color-text-secondary)]">Car, motor, bike, etc.</p>
                    </div>
                  </button>
                </div>
              </div>

              {/* Vehicle Details if Arrival with Vehicle */}
              {arrivalMode === 'vehicle' && (
                <div className="p-4 rounded-xl border border-amber-300 bg-amber-50/50 space-y-3">
                  <p className="text-xs font-bold text-amber-950 flex items-center gap-1.5">
                    <Car className="h-4 w-4 text-amber-700" />
                    Vehicle Information
                  </p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label htmlFor="kiosk-vehicle-type" className="block text-[11px] font-semibold text-[var(--color-text-primary)] mb-1">
                        Vehicle Type <span className="text-red-500">*</span>
                      </label>
                      <select
                        id="kiosk-vehicle-type"
                        value={vehicleType}
                        onChange={(e) => setVehicleType(e.target.value)}
                        className="w-full rounded-xl border border-[var(--color-border)] bg-white py-2 px-3 text-xs font-semibold text-[var(--color-text-primary)] focus:border-[#7A0A0A] focus:outline-none"
                      >
                        <option value="car">Car / Sedan</option>
                        <option value="motorcycle">Motorcycle</option>
                        <option value="van">Van / MPV</option>
                        <option value="suv">SUV</option>
                        <option value="pickup">Pickup</option>
                        <option value="bicycle">Bicycle</option>
                        <option value="other">Other Vehicle</option>
                      </select>
                    </div>
                    <div>
                      <label htmlFor="kiosk-plate-number" className="block text-[11px] font-semibold text-[var(--color-text-primary)] mb-1">
                        Plate / MV File Number <span className="text-red-500">*</span>
                      </label>
                      <Input
                        id="kiosk-plate-number"
                        type="text"
                        placeholder="ABC 1234"
                        value={plateNumber}
                        onChange={(e) => setPlateNumber(e.target.value.toUpperCase())}
                        maxLength={15}
                        required
                      />
                    </div>
                  </div>
                </div>
              )}

              {/* Destination University Office Picker with Emergency Closure Warning */}
              <div className="rounded-2xl border border-[var(--color-border)] bg-white p-4 space-y-4">
                <div>
                  <label htmlFor="kiosk-destination-office" className="block text-xs font-bold uppercase tracking-wider text-[var(--color-text-primary)] mb-1">
                    Destination University Office <span className="text-red-500">*</span>
                  </label>
                  <div className="relative">
                    <Building2 className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-text-muted)]" />
                    <select
                      id="kiosk-destination-office"
                      value={selectedOfficeId}
                      onChange={(e) => setSelectedOfficeId(e.target.value)}
                      className="w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] py-3 pl-9 pr-8 text-sm font-semibold text-[var(--color-text-primary)] focus:border-[#7A0A0A] focus:outline-none focus:ring-1 focus:ring-[#7A0A0A]"
                    >
                      <option value="">Select destination office</option>
                      {offices.map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.name}{o.closure_status === 'closed' ? ' [Temporarily Closed]' : ''}
                        </option>
                      ))}
                    </select>
                  </div>
                  {selectedOfficeId && (
                    <p className="mt-1 text-xs text-[var(--color-text-secondary)]">
                      {offices.find((o) => o.id === selectedOfficeId)?.description}
                    </p>
                  )}

                  {/* Office Emergency Closure Alert Box */}
                  {(() => {
                    const selectedOffice = offices.find((o) => o.id === selectedOfficeId);
                    if (selectedOffice?.closure_status === 'closed') {
                      return (
                        <div className="mt-3 rounded-xl border border-red-300 bg-red-50 p-4 text-red-950 space-y-2" role="alert">
                          <div className="flex items-center gap-2 font-bold text-red-900 text-sm">
                            <AlertTriangle className="h-5 w-5 text-red-700 shrink-0" />
                            <span>Office Temporarily Closed</span>
                          </div>
                          <p className="text-xs leading-relaxed">
                            The <strong>{selectedOffice.name}</strong> is temporarily closed:
                          </p>
                          <div className="rounded-lg border border-red-200 bg-white/95 p-3 text-xs font-medium text-red-900 italic">
                            &ldquo;{selectedOffice.closure_reason || 'This office is temporarily unavailable due to an unexpected emergency.'}&rdquo;
                          </div>
                          <p className="text-[11px] text-red-800 font-semibold">
                            Visitors cannot register visits to this office while closed. Please select an alternate office.
                          </p>
                        </div>
                      );
                    }
                    return null;
                  })()}
                </div>

                {/* Visit Type: General vs Personnel */}
                {selectedOfficeId && (
                  <div className="pt-2 border-t border-[var(--color-border)] space-y-3">
                    <label className="block text-xs font-semibold text-[var(--color-text-primary)]">
                      Transaction Type
                    </label>
                    <div className="grid grid-cols-2 gap-2">
                      <button
                        type="button"
                        onClick={() => { setVisitType('general'); setSelectedPersonnel(''); }}
                        className={`min-h-[44px] rounded-xl border text-xs font-semibold transition-all ${
                          visitType === 'general'
                            ? 'border-[#7A0A0A] bg-[#F8EEEE] text-[#7A0A0A]'
                            : 'border-[var(--color-border)] bg-white text-[var(--color-text-primary)]'
                        }`}
                      >
                        General Office Transaction
                      </button>
                      <button
                        type="button"
                        onClick={() => setVisitType('personnel')}
                        className={`min-h-[44px] rounded-xl border text-xs font-semibold transition-all ${
                          visitType === 'personnel'
                            ? 'border-[#7A0A0A] bg-[#F8EEEE] text-[#7A0A0A]'
                            : 'border-[var(--color-border)] bg-white text-[var(--color-text-primary)]'
                        }`}
                      >
                        Visiting Specific Personnel
                      </button>
                    </div>

                    {visitType === 'personnel' && (
                      <div>
                        <label htmlFor="kiosk-personnel-select" className="block text-[11px] font-semibold text-[var(--color-text-primary)] mb-1">
                          Personnel to Visit
                        </label>
                        {personnelList.length > 0 ? (
                          <select
                            id="kiosk-personnel-select"
                            value={selectedPersonnel}
                            onChange={(e) => setSelectedPersonnel(e.target.value)}
                            className="w-full rounded-xl border border-[var(--color-border)] bg-white py-2 px-3 text-xs font-semibold text-[var(--color-text-primary)] focus:border-[#7A0A0A] focus:outline-none"
                          >
                            <option value="">Select personnel</option>
                            {personnelList.map((p) => (
                              <option key={p.id} value={p.name}>
                                {p.name} {p.position ? `(${p.position})` : ''}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <Input
                            placeholder="Enter personnel name"
                            value={selectedPersonnel}
                            onChange={(e) => setSelectedPersonnel(e.target.value)}
                          />
                        )}
                      </div>
                    )}
                  </div>
                )}

                {/* Purpose of Visit */}
                <div className="pt-2 border-t border-[var(--color-border)]">
                  <VisitPurposeField
                    purposes={visitPurposes}
                    value={purpose}
                    error={errors.purpose?.message}
                    onChange={(value) => setValue('purpose', value, { shouldDirty: true, shouldValidate: true })}
                  />
                </div>

                {/* Scheduled Visit Date */}
                <div className="pt-2 border-t border-[var(--color-border)]">
                  <FormField label="Visit Date" requirement="required" id="kiosk-date" error={errors.visitDate?.message}>
                    <Input id="kiosk-date" type="date" {...register('visitDate')} min={today} max={latestVisitDate} error={!!errors.visitDate} required aria-required="true" />
                    {(() => {
                      const currDate = getValues('visitDate');
                      const match = currDate ? calendarClosures.find((c) => c.active !== false && currDate >= c.startDate && currDate <= c.endDate) : undefined;
                      if (match) {
                        return (
                          <p className="mt-1 text-xs font-semibold text-rose-700 flex items-center gap-1">
                            <AlertCircle className="h-3.5 w-3.5" />
                            Campus is closed on this date: {match.title}{match.description ? ` (${match.description})` : ''}
                          </p>
                        );
                      }
                      return null;
                    })()}
                  </FormField>
                </div>
              </div>

              <div className="flex gap-3 pt-2">
                <Button
                  variant="secondary"
                  type="button"
                  onClick={() => setStep('form')}
                  className="flex-1 min-h-[48px]"
                  icon={<ArrowLeft className="h-4 w-4" />}
                >
                  Back: Personal
                </Button>
                <Button
                  type="button"
                  onClick={onVisitNext}
                  disabled={!selectedOfficeId || offices.find((o) => o.id === selectedOfficeId)?.closure_status === 'closed'}
                  className="flex-1 min-h-[48px]"
                  icon={<ArrowRight className="h-4 w-4" />}
                >
                  Next: Live Photo
                </Button>
              </div>
            </div>
          )}

          {/* STEP 3: Live Face Photo Capture */}
          {step === 'photo' && (
            <div className="space-y-6">
              <div className="text-center">
                <h2 className="text-xl font-bold text-[var(--color-text-primary)]">3. Live Face Portrait</h2>
                <p className="text-xs text-[var(--color-text-secondary)] mt-0.5">Look directly into the camera. Center your face inside the oval.</p>
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

              {photoPreview ? (
                <div className="space-y-4">
                  <div className="relative mx-auto w-full max-w-sm overflow-hidden rounded-2xl border-2 border-[var(--color-brand)] shadow-sm bg-black aspect-[3/4]">
                    <img src={photoPreview} alt="Live face preview" className="h-full w-full object-cover" style={{ transform: 'rotateY(180deg) translateZ(0)' }} />
                  </div>
                  <div className="flex gap-3">
                    <Button variant="secondary" type="button" onClick={onRetakePhoto} className="flex-1 min-h-[48px]" icon={<RotateCcw className="h-4 w-4" />}>
                      Retake Photo
                    </Button>
                    <Button
                      type="button"
                      onClick={() => {
                        if (idBlob || isPeakMode) {
                          setStep('verify');
                        } else {
                          setStep('id');
                          idWebcam.start();
                        }
                      }}
                      className="flex-1 min-h-[48px]"
                      icon={<ArrowRight className="h-4 w-4" />}
                    >
                      {idBlob ? 'Next: Verify' : 'Next: Valid ID'}
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="space-y-4">
                  {/* Visitor framing instructions */}
                  <div className="rounded-xl border border-blue-200 bg-blue-50/60 p-3 text-xs text-blue-950 space-y-1 mb-2 max-w-sm mx-auto">
                    <p className="font-semibold text-[11px] text-blue-900 uppercase tracking-wider flex items-center gap-1.5">
                      <Sparkles className="h-3.5 w-3.5 text-blue-600" />
                      Portrait Framing Guidelines
                    </p>
                    <p className="text-[11px] text-blue-900/90">
                      Center your face inside the oval guide and keep forehead and chin visible.
                    </p>
                  </div>

                  {/* Camera viewport with oval guide */}
                  <div className="mx-auto w-full max-w-sm overflow-hidden rounded-2xl border-2 border-[var(--color-brand)] bg-black aspect-[3/4] relative flex items-center justify-center shadow-inner">
                    {faceWebcam.isStarting && (
                      <div className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-black/60 text-white text-xs">
                        <Loader2 className="h-6 w-6 animate-spin mb-1 text-[var(--color-brand)]" />
                        <span>Starting camera…</span>
                      </div>
                    )}
                    {faceWebcam.videoRef && (
                      <div
                        className="absolute inset-0 h-full w-full overflow-hidden"
                        style={{
                          transform: faceWebcam.mirrorPreview ? 'rotateY(180deg) translateZ(0)' : 'none',
                          WebkitTransform: faceWebcam.mirrorPreview ? 'rotateY(180deg) translateZ(0)' : 'none',
                          backfaceVisibility: 'visible',
                          WebkitBackfaceVisibility: 'visible',
                        }}
                      >
                        <video
                          ref={faceWebcam.videoRef}
                          autoPlay
                          playsInline
                          muted
                          style={{ transform: 'none' }}
                          className="h-full w-full object-cover block shrink-0"
                        />
                      </div>
                    )}

                    {/* Face Guide Oval */}
                    <div className="absolute inset-0 pointer-events-none flex items-center justify-center">
                      <div
                        style={{ width: `${SELFIE_OVAL_WIDTH_PERCENT}%`, height: `${SELFIE_OVAL_HEIGHT_PERCENT}%` }}
                        className="border-2 border-dashed border-white/80 rounded-[50%] shadow-[0_0_0_9999px_rgba(0,0,0,0.45)] flex items-center justify-center"
                      >
                        <span className="sr-only">Center face in oval</span>
                      </div>
                    </div>

                    {faceWebcam.isActive && (
                      <CameraControls
                        activeFacingMode={faceWebcam.activeFacingMode}
                        mirrorPreview={faceWebcam.mirrorPreview}
                        canSwitchCamera={faceWebcam.canSwitchCamera}
                        onSwitchCamera={faceWebcam.switchCamera}
                        onToggleMirror={faceWebcam.toggleMirrorPreview}
                      />
                    )}
                  </div>

                  <div className="flex gap-3">
                    <Button variant="secondary" type="button" onClick={() => { faceWebcam.stop(); setStep('visit'); }} className="flex-1 min-h-[48px]" icon={<ArrowLeft className="h-4 w-4" />}>
                      Back: Visit
                    </Button>
                    <Button type="button" onClick={onCapturePhoto} disabled={!faceWebcam.isActive} className="flex-1 min-h-[48px]" icon={<Camera className="h-4 w-4" />} aria-label="Capture Photo">
                      Capture Photo
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* STEP 4: Valid ID Capture & Dual OCR */}
          {step === 'id' && (
            <div className="space-y-6">
              <div className="text-center">
                <h2 className="text-xl font-bold text-[var(--color-text-primary)]">4. Valid ID Document</h2>
                <p className="text-xs text-[var(--color-text-secondary)] mt-0.5">Position your valid ID clearly in the camera frame.</p>
              </div>

              {idPreview ? (
                <div className="space-y-4">
                  <div className="relative mx-auto max-w-sm overflow-hidden rounded-xl border border-[var(--color-border)] shadow-sm">
                    <img src={idPreview} alt="ID preview" className="w-full object-cover aspect-[3/2]" />
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
                    <Button variant="secondary" type="button" onClick={onRetakeId} className="flex-1 min-h-[48px]" icon={<RotateCcw className="h-4 w-4" />}>
                      Retake ID
                    </Button>
                    <Button type="button" onClick={() => setStep('verify')} className="flex-1 min-h-[48px]" icon={<ArrowRight className="h-4 w-4" />}>
                      Next: Verify
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

                  <div className="flex items-center gap-2">
                    <label htmlFor="kiosk-id-type" className="text-xs font-semibold text-[var(--color-text-primary)] shrink-0">
                      ID Type:
                    </label>
                    <select
                      id="kiosk-id-type"
                      value={idType}
                      onChange={(e) => setIdType(e.target.value)}
                      className="w-full rounded-xl border border-[var(--color-border)] bg-white py-1.5 px-3 text-xs font-semibold text-[var(--color-text-primary)] focus:border-[#7A0A0A] focus:outline-none"
                    >
                      <option value="National ID">PhilSys National ID</option>
                      <option value="Driver's License">Driver's License</option>
                      <option value="Passport">Philippine Passport</option>
                      <option value="UMID">UMID / SSS ID</option>
                      <option value="Postal ID">Postal ID</option>
                      <option value="Voter's ID">Voter's ID</option>
                      <option value="PRC ID">PRC License</option>
                      <option value="Student/Employee ID">Student / Employee ID</option>
                      <option value="Company ID">Company / Government ID</option>
                    </select>
                  </div>

                  <div
                    className="mx-auto w-full max-w-md overflow-hidden rounded-2xl border-2 border-[var(--color-brand)] shadow-inner bg-black aspect-[3/2] relative flex items-center justify-center cursor-pointer"
                    onClick={() => void idWebcam.refocus?.()}
                    title="Tap camera to refocus"
                  >
                    {idWebcam.isStarting && (
                      <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-black/80 text-white" role="status" aria-live="polite">
                        <Loader2 className="h-8 w-8 animate-spin text-[var(--color-brand)] mb-2" aria-hidden="true" />
                        <span className="text-sm font-medium">Starting ID camera…</span>
                      </div>
                    )}
                    {idWebcam.videoRef && (
                      <div
                        className="absolute inset-0 h-full w-full overflow-hidden"
                        style={{
                          transform: idWebcam.mirrorPreview ? 'rotateY(180deg) translateZ(0)' : 'none',
                          WebkitTransform: idWebcam.mirrorPreview ? 'rotateY(180deg) translateZ(0)' : 'none',
                          backfaceVisibility: 'visible',
                          WebkitBackfaceVisibility: 'visible',
                        }}
                      >
                        <video
                          ref={idWebcam.videoRef}
                          autoPlay
                          playsInline
                          muted
                          style={{ transform: 'none' }}
                          className="h-full w-full object-cover block shrink-0"
                        />
                      </div>
                    )}
                    {/* ID Document Framing Guidelines */}
                    <div className="absolute inset-0 pointer-events-none flex items-center justify-center p-3">
                      <div className="w-full max-w-[280px] aspect-[85.6/53.98] border-2 border-dashed border-white/70 rounded-xl flex items-end justify-center pb-2 shadow-[0_0_0_9999px_rgba(0,0,0,0.35)]">
                        <span className="text-[10px] text-white/95 bg-black/60 px-2 py-0.5 rounded backdrop-blur-xs font-medium">
                          Align ID inside frame • Tap to focus
                        </span>
                      </div>
                    </div>

                    {idWebcam.isActive && (
                      <CameraControls
                        activeFacingMode={idWebcam.activeFacingMode}
                        mirrorPreview={idWebcam.mirrorPreview}
                        canSwitchCamera={idWebcam.canSwitchCamera}
                        onSwitchCamera={idWebcam.switchCamera}
                        onToggleMirror={idWebcam.toggleMirrorPreview}
                        onRefocus={idWebcam.refocus}
                      />
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
                      className="flex-1 min-h-[48px]"
                      icon={<ArrowLeft className="h-4 w-4" />}
                    >
                      Back: Photo
                    </Button>
                    <Button
                      type="button"
                      onClick={onCaptureManualId}
                      disabled={!idWebcam.isActive || isProcessingId}
                      className="flex-1 min-h-[48px]"
                      icon={<Camera className="h-4 w-4" />}
                    >
                      Capture ID
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* STEP 5: Identity & Document Verification */}
          {step === 'verify' && (
            <div className="space-y-6">
              <div className="text-center">
                <h2 className="text-xl font-bold text-[var(--color-text-primary)]">5. Identity Verification</h2>
                <p className="text-xs text-[var(--color-text-secondary)] mt-0.5">
                  Review your live portrait against your captured ID before continuing.
                </p>
              </div>

              {/* Side-by-side / Stacked Visual Comparison */}
              <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 space-y-4">
                <div className="grid grid-cols-2 gap-4 items-center">
                  <div className="text-center space-y-1.5">
                    <p className="text-xs font-semibold text-[var(--color-text-secondary)]">Live Face</p>
                    <div className="relative mx-auto h-32 w-24 overflow-hidden rounded-xl border border-[var(--color-border)] bg-black shadow-xs">
                      {photoPreview ? (
                        <img src={photoPreview} alt="Live face" className="h-full w-full object-cover" style={{ transform: 'rotateY(180deg) translateZ(0)' }} />
                      ) : (
                        <div className="h-full w-full flex items-center justify-center text-white/50 text-xs">No photo</div>
                      )}
                    </div>
                  </div>

                  <div className="text-center space-y-1.5">
                    <p className="text-xs font-semibold text-[var(--color-text-secondary)]">Valid ID ({idType})</p>
                    <div className="relative mx-auto h-32 w-44 overflow-hidden rounded-xl border border-[var(--color-border)] bg-black shadow-xs">
                      {idPreview ? (
                        <img src={idPreview} alt="Valid ID" className="h-full w-full object-cover" />
                      ) : (
                        <div className="h-full w-full flex items-center justify-center text-white/50 text-xs">
                          {isPeakMode ? 'Peak Mode (No ID)' : 'No ID'}
                        </div>
                      )}
                    </div>
                  </div>
                </div>

                <div className="rounded-xl border border-emerald-300 bg-emerald-50 p-3 text-xs text-emerald-950 flex items-center gap-2">
                  <CheckCircle2 className="h-4 w-4 text-emerald-600 shrink-0" />
                  <span>Document and portrait successfully captured for gate pass verification.</span>
                </div>
              </div>

              <div className="flex gap-3">
                <Button
                  variant="secondary"
                  type="button"
                  onClick={() => {
                    if (idBlob) {
                      onRetakeId();
                    } else {
                      onRetakePhoto();
                    }
                  }}
                  className="flex-1 min-h-[48px]"
                  icon={<RotateCcw className="h-4 w-4" />}
                >
                  Retake ID / Photo
                </Button>
                <Button
                  type="button"
                  onClick={() => setStep('review')}
                  className="flex-1 min-h-[48px]"
                  icon={<ArrowRight className="h-4 w-4" />}
                >
                  Next: Review & Agree
                </Button>
              </div>
            </div>
          )}

          {/* STEP 6: Review & Institutional Data Privacy Agreement */}
          {step === 'review' && (
            <div className="space-y-6">
              <div className="text-center">
                <h2 className="text-xl font-bold text-[var(--color-text-primary)]">6. Review & Data Privacy Agreement</h2>
                <p className="text-xs text-[var(--color-text-secondary)] mt-0.5">Please verify your details and agree to the Data Privacy Notice to generate your pass.</p>
              </div>

              {kioskTransactionRef.current?.phase === 'existing_pass_conflict' ? (
                <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 space-y-2 text-sm text-amber-900" role="alert">
                  <div className="flex items-center gap-2 font-semibold text-amber-950">
                    <AlertCircle className="h-5 w-5 text-amber-600 shrink-0" />
                    <span>Existing Pass Detected</span>
                  </div>
                  <p>
                    An existing pass was already created for this request, but the local retry no longer matches it. Do not create another pass. Please ask the Guard for assistance.
                  </p>
                  <Button
                    variant="secondary"
                    type="button"
                    onClick={handleAmbiguousCancelAndAskGuard}
                    className="w-full min-h-[44px] text-amber-800 border-amber-400 hover:bg-amber-50 mt-2"
                    icon={<AlertCircle className="h-4 w-4" />}
                  >
                    Cancel & Ask Guard
                  </Button>
                </div>
              ) : kioskTransactionRef.current?.phase === 'ambiguous' ? (
                <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 space-y-2 text-sm text-amber-900" role="alert">
                  <div className="flex items-center gap-2 font-semibold text-amber-950">
                    <AlertCircle className="h-5 w-5 text-amber-600 shrink-0" />
                    <span>Generation result could not be confirmed</span>
                  </div>
                  <p>
                    The previous submission may already have created a pass. To prevent duplicates, the exact previous submission must be retried before any details can be changed.
                  </p>
                  <div className="flex gap-2">
                    <Button
                      variant="secondary"
                      type="button"
                      onClick={handleAmbiguousCancelAndAskGuard}
                      className="flex-1 min-h-[44px] text-amber-800 border-amber-400 hover:bg-amber-50"
                      icon={<AlertCircle className="h-4 w-4" />}
                    >
                      Cancel & Ask Guard
                    </Button>
                    <Button
                      type="button"
                      onClick={onSubmit}
                      className="flex-1 min-h-[44px]"
                      icon={<RotateCcw className="h-4 w-4" />}
                    >
                      Retry Exact Submission
                    </Button>
                  </div>
                </div>
              ) : submitError ? (
                <div className="rounded-md border border-[var(--color-danger)] bg-[var(--color-danger-light)] p-3 text-sm text-[var(--color-danger-dark)]" role="alert">
                  {submitError}
                </div>
              ) : null}

              {/* Grouped: Photo / Valid ID */}
              <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 space-y-3">
                <p className="font-semibold text-xs text-[var(--color-text-secondary)] uppercase tracking-wider">Photo / Valid ID</p>
                <div className="flex flex-wrap gap-6 justify-center items-center py-1">
                  {photoPreview && (
                    <div className="text-center">
                      <p className="text-xs text-[var(--color-text-secondary)] mb-1">Face Photo</p>
                      <img src={photoPreview} alt="Face photo" className="h-24 w-20 object-cover rounded-lg border border-[var(--color-border)] shadow-sm mx-auto" style={{ transform: 'rotateY(180deg) translateZ(0)' }} />
                      {kioskTransactionRef.current?.phase !== 'ambiguous' && kioskTransactionRef.current?.phase !== 'existing_pass_conflict' && (
                        <button
                          type="button"
                          onClick={onRetakePhoto}
                          className="mt-1.5 text-xs font-semibold text-[var(--color-brand)] hover:underline inline-flex items-center gap-1"
                        >
                          <RotateCcw className="h-3 w-3" />
                          Retake Photo
                        </button>
                      )}
                    </div>
                  )}
                  {idPreview && !isPeakMode ? (
                    <div className="text-center">
                      <p className="text-xs text-[var(--color-text-secondary)] mb-1">Valid ID ({idType})</p>
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
                      <p className="text-xs text-[var(--color-text-secondary)] mb-1">Valid ID</p>
                      <div className="flex h-24 w-36 items-center justify-center rounded-lg border border-dashed border-[var(--color-border)] bg-[var(--color-canvas-subtle)] p-2 text-center text-xs text-[var(--color-text-secondary)]">
                        No ID required (Peak Mode)
                      </div>
                    </div>
                  ) : null}
                </div>
              </div>

              {/* Grouped: Visitor Information & Visit Information */}
              <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-canvas)] p-4 text-sm divide-y divide-[var(--color-border)]">
                <div className="pb-3">
                  <div className="flex items-center justify-between mb-2">
                    <p className="font-semibold text-xs text-[var(--color-text-secondary)] uppercase tracking-wider">Visitor Information</p>
                    {kioskTransactionRef.current?.phase !== 'ambiguous' && kioskTransactionRef.current?.phase !== 'existing_pass_conflict' && (
                      <button
                        type="button"
                        onClick={() => setStep('form')}
                        className="text-xs font-semibold text-[var(--color-brand)] hover:underline"
                      >
                        Edit Details
                      </button>
                    )}
                  </div>
                  <p><strong className="text-[var(--color-text-secondary)]">Full Name:</strong> {[getValues('firstName'), getValues('middleName'), getValues('lastName')].filter(Boolean).join(' ')}</p>
                  <p className="mt-1"><strong className="text-[var(--color-text-secondary)]">Contact Number:</strong> {getValues('contactNumber')}</p>
                  <p className="mt-1"><strong className="text-[var(--color-text-secondary)]">Gender:</strong> {gender}</p>
                  {selectedPsgc && (
                    <p className="mt-1"><strong className="text-[var(--color-text-secondary)]">Locality:</strong> {[houseBuilding, street, selectedPsgc.barangay.name, selectedPsgc.city.name, selectedPsgc.province?.name].filter(Boolean).join(', ')}</p>
                  )}
                </div>

                <div className="pt-3">
                  <div className="flex items-center justify-between mb-2">
                    <p className="font-semibold text-xs text-[var(--color-text-secondary)] uppercase tracking-wider">Visit Information</p>
                    {kioskTransactionRef.current?.phase !== 'ambiguous' && kioskTransactionRef.current?.phase !== 'existing_pass_conflict' && (
                      <button
                        type="button"
                        onClick={() => setStep('visit')}
                        className="text-xs font-semibold text-[var(--color-brand)] hover:underline"
                      >
                        Edit Visit
                      </button>
                    )}
                  </div>
                  <p className="mb-1"><strong className="text-[var(--color-text-secondary)]">Office:</strong> {offices.find((o) => o.id === selectedOfficeId)?.name || 'Campus Visit'}</p>
                  {selectedPersonnel && (
                    <p className="mb-1"><strong className="text-[var(--color-text-secondary)]">Personnel:</strong> {selectedPersonnel}</p>
                  )}
                  <p className="mb-1"><strong className="text-[var(--color-text-secondary)]">Visit Date:</strong> {getValues('visitDate')}</p>
                  <p className="mb-1"><strong className="text-[var(--color-text-secondary)]">Purpose:</strong> {getValues('purpose')}</p>
                  <p><strong className="text-[var(--color-text-secondary)]">Arrival Mode:</strong> {arrivalMode === 'vehicle' ? `With Vehicle (${vehicleType.toUpperCase()} - ${plateNumber})` : 'On Foot / Commute'}</p>
                </div>

                {/* Data Privacy Notice & Consent Agreement */}
                <div className="pt-3 space-y-3">
                  <div className="flex items-center justify-between">
                    <p className="font-semibold text-xs text-[var(--color-text-secondary)] uppercase tracking-wider">Republic Act No. 10173 Agreement</p>
                    <button
                      type="button"
                      onClick={() => setShowPrivacyModal(true)}
                      className="text-xs font-bold text-[#7A0A0A] hover:underline flex items-center gap-1"
                    >
                      <ShieldCheck className="h-3.5 w-3.5" />
                      View Institutional Notice
                    </button>
                  </div>
                  <p className="text-xs text-[var(--color-text-secondary)] leading-relaxed">
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
                  <label className="flex items-center gap-2 pt-2 border-t border-[var(--color-border)] cursor-pointer">
                    <input
                      type="checkbox"
                      {...register('consent')}
                      required
                      aria-required="true"
                      className="h-5 w-5 rounded border-[var(--color-border-strong)] text-[var(--color-brand)] focus:ring-[var(--color-brand)]"
                    />
                    <span className="font-semibold text-xs text-[var(--color-text-primary)]">
                      I agree to the institutional collection and processing of my personal data under Republic Act No. 10173. *
                    </span>
                  </label>
                  {errors.consent && <p className="text-[var(--color-danger)] font-medium text-xs">{errors.consent.message}</p>}
                </div>
              </div>

              <div className="flex flex-col sm:flex-row gap-3">
                <Button
                  variant="secondary"
                  type="button"
                  onClick={() => setStep('form')}
                  className="flex-1 min-h-[48px]"
                  icon={<ArrowLeft className="h-4 w-4" />}
                >
                  Edit Details
                </Button>
                <Button
                  type="button"
                  onClick={onSubmit}
                  disabled={!watch('consent')}
                  className="flex-1 min-h-[48px] text-base font-bold"
                  icon={<CheckCircle2 className="h-5 w-5" />}
                >
                  Issue E-GatePass
                </Button>
              </div>
            </div>
          )}

          {/* STEP 8: Generating Spinner */}
          {step === 'generating' && (
            <div className="flex flex-col items-center justify-center py-12 px-4 text-center space-y-5" role="status" aria-live="polite" aria-label="Generating gate pass">
              <div className="relative mx-auto flex h-16 w-16 items-center justify-center">
                <span className="absolute -inset-2 rounded-full bg-[var(--color-brand)]/10 animate-pulse" aria-hidden="true" />
                <img src="/earist-logo.png" alt="EARIST seal" className="relative h-14 w-14 object-contain" />
              </div>
              <div className="space-y-1">
                <p className="text-xl font-bold text-[var(--color-text-primary)]">Generating gate pass…</p>
                <p className="text-xs text-[var(--color-text-secondary)]">Securing visitor record and issuing badge</p>
              </div>
              <div className="w-full max-w-xs">
                <ProgressBar indeterminate variant="brand" size="md" phase={issuancePhase} />
              </div>
            </div>
          )}

          {/* STEP 9: Done / Pass Card Display */}
          {step === 'done' && currentPassPresentation && qrDataUrl && (
            <div className="space-y-6 text-center print:text-left print:m-0 print:space-y-2">
              <div className="mx-auto mb-2 flex h-16 w-16 items-center justify-center rounded-full bg-[var(--color-success-light)] text-[var(--color-success)] print:hidden">
                <CheckCircle2 className="h-8 w-8" />
              </div>
              
              <h2 className="text-2xl font-bold text-[var(--color-text-primary)] print:hidden">Gate Pass Created</h2>

              <div className="rounded-xl border border-sky-200 bg-sky-50 p-3 text-xs text-left print:hidden">
                <p className="font-semibold text-sky-950">Pass Created</p>
                <p className="mt-0.5 text-slate-700">Your visitor pass has been created. No reusable visitor account was created.</p>
              </div>

              {printFailed && (
                <div className="rounded-xl border border-[var(--color-warning)] bg-[var(--color-warning-light)] p-4 text-sm text-[var(--color-warning-dark)] print:hidden flex flex-col sm:flex-row items-center justify-between gap-3 text-left">
                  <div className="flex items-center gap-2">
                    <AlertCircle className="h-5 w-5 shrink-0" />
                    <span>Thermal printer unavailable. Pass was successfully created.</span>
                  </div>
                  <div className="flex gap-2">
                    {printerStatus === 'connected' ? (
                      <Button size="sm" variant="secondary" onClick={() => void handlePrint()} disabled={isPrintBusy || isPrinting}>
                        Print Again
                      </Button>
                    ) : (
                      <Button size="sm" variant="secondary" onClick={() => setShowPrinterSettings(true)}>
                        Printer Settings
                      </Button>
                    )}
                    <Button size="sm" variant="secondary" onClick={() => window.print()}>
                      Browser Print
                    </Button>
                  </div>
                </div>
              )}

              <div className="flex justify-center">
                <InstitutionalPassCard presentation={currentPassPresentation} qrDataUrl={qrDataUrl} />
              </div>

              <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-canvas)] p-4 text-left text-sm print:hidden">
                <p className="mb-1"><strong className="text-[var(--color-text-secondary)]">Purpose:</strong> {getValues('purpose')}</p>
                <p><strong className="text-[var(--color-text-secondary)]">Valid:</strong> {issuedValidity || formatWorkingHours(workingHours)}</p>
              </div>

              {/* Before You Arrive instructions panel */}
              {visitorInstructions && visitorInstructions.length > 0 && (
                <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-left text-xs space-y-2 print:hidden">
                  <p className="font-bold uppercase tracking-wider text-[var(--color-brand)]">Before You Arrive</p>
                  <ul className="list-disc list-inside space-y-1 text-[var(--color-text-secondary)]">
                    {visitorInstructions.map((inst, idx) => (
                      <li key={idx}>{inst}</li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="flex flex-wrap gap-3 print:hidden">
                <Button
                  variant="secondary"
                  type="button"
                  onClick={() => void handlePrint()}
                  disabled={isPrintBusy || isPrinting}
                  className="flex-1 min-h-[44px]"
                  icon={<Printer className="h-4 w-4" />}
                >
                  {isPrintBusy || isPrinting
                    ? 'Printing…'
                    : printerStatus === 'connected'
                    ? 'Print Pass (MXW01)'
                    : 'Browser Print'}
                </Button>
                <Button variant="secondary" type="button" onClick={() => setShowEmailModal(true)} className="flex-1 min-h-[44px]" icon={<Mail className="h-4 w-4" />}>
                  Email E-GatePass
                </Button>
                <Button
                  type="button"
                  onClick={handleNextVisitor}
                  disabled={isPrintBusy || isPrinting}
                  loading={isPrintBusy || isPrinting}
                  className="flex-1 min-h-[44px]"
                >
                  Register Another Visitor
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
          printer={printer}
        />

        <InstitutionalPrivacyNoticeModal
          isOpen={showPrivacyModal}
          onClose={() => setShowPrivacyModal(false)}
          photoRetentionDays={photoRetentionDays}
          idRetentionDays={idRetentionDays}
          visitorRetentionDays={visitorRetentionDays}
        />
      </div>
    </main>
  );
}
