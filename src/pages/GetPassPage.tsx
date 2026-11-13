import { useState, useRef, useEffect, useMemo, useCallback, lazy, Suspense } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useWebcam } from '@/hooks/useWebcam';
import { useObjectUrl } from '@/hooks/useObjectUrl';
import { useBuildVersion } from '@/hooks/useBuildVersion';
import { normalizeIdentityDocumentImage, normalizeVehicleImage } from '@/lib/imageProcessing';
import {
  issueVisitorPass,
  loadRegistrationSettings,
  createPortalIssueTransaction,
  uploadPortalEvidence,
  verifyPortalIdentity,
  preflightPortalLiveFace,
  validatePortalSession,
  invalidatePortalEvidenceCheckpoint,
  identifyReturningVisitor,
  lookupReturningVisitor,
  fetchHistoricalIdPreview,
  type ReturningLookupCandidate,
  PortalSessionError,
  UploadAuthorizationError,
  UploadQuotaExceededError,
  PendingAbandonmentError,
  abandonPortalEvidence,
  StorageUploadError,
  PreflightQualityError,
  type PortalIssueTransaction,
  type IssueTransactionPhase,
} from '@/services/visitorRegistration';
import {
  SELFIE_TARGET_ASPECT_RATIO,
  SELFIE_OVAL_WIDTH_PERCENT,
  SELFIE_OVAL_HEIGHT_PERCENT,
} from '@/lib/selfieFramingContract';
import { StructuredAddressField } from '@/components/StructuredAddressField';
import type { SelectedPsgcAddress } from '@/components/AddressCascadingSelector';
import { formatStructuredAddress } from '@/lib/psgc';
import { TurnstileWidget, type TurnstileWidgetRef } from '@/components/TurnstileWidget';
import { AuthenticatedImage } from '@/components/AuthenticatedImage';
import { generateBrandedQrDataUrl } from '@/lib/brandedQr';
import QRCode from 'qrcode';
import { evaluateLiveFaceQuality, evaluateIdImageQuality, evaluateReturningSelfiePrecheck } from '@/lib/imageQuality';
import { hydrateReturningAddress } from '@/lib/returningAddressHydration';
import { normalizePhMobile, validatePhMobile } from '@/lib/phPhone';
import { normalizeVehiclePlate } from '@/lib/vehiclePlate';
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
  User,
  UserCheck,
  Car,
  ShieldAlert,
  Search,
  UserPlus,
  ShieldCheck,
  Building2,
  Clock,
  Clock3,
  AlertTriangle,
  Send,
  Copy,
} from 'lucide-react';
import { toast } from 'sonner';
import { VisitorMonthlyCalendar } from '@/components/VisitorMonthlyCalendar';
import { Button, Card, Input, FormField, Stepper, PageShell } from '@/components/ui';
const EmailPassModal = lazy(() => import('@/components/EmailPassModal').then((m) => ({ default: m.EmailPassModal })));
import { TimedSkipWarningModal } from '@/components/TimedSkipWarningModal';
import { VisitPurposeField } from '@/components/VisitPurposeField';
import { DEFAULT_VISIT_PURPOSES, normalizeVisitPurposes } from '@/lib/settingsDefaults';
import type { VisitPurposeOption } from '@/types';
import { DEFAULT_WORKING_HOURS, formatValidityWindow, formatWorkingHours, MAX_VISIT_ADVANCE_DAYS, normalizeWorkingHours } from '@/lib/workingHours';
import { getManilaDateString, getLatestVisitDateString, validateVisitDate } from '@/lib/scheduling';
import { createPassPresentation, type PassPresentation } from '@/lib/passPresentation';
const InstitutionalPassCard = lazy(() => import('@/components/InstitutionalPassCard').then((m) => ({ default: m.InstitutionalPassCard })));
import { recognizeIdImage, terminateLocalOcrWorker } from '@/lib/ocr';
import type { DetectedAddressDetails } from '@/lib/addressOcr';

const MAX_RAW_ID_FILE_BYTES = 10 * 1024 * 1024;

export const CONTROLLED_VEHICLE_COLORS = [
  'White',
  'Black',
  'Silver',
  'Gray',
  'Red',
  'Blue',
  'Brown',
  'Gold',
  'Green',
  'Yellow',
  'Orange',
  'Beige',
  'Other',
] as const;

export const CONTROLLED_VEHICLE_TYPES = [
  { value: 'car', label: 'Car (Sedan, Hatchback)' },
  { value: 'motorcycle', label: 'Motorcycle / Scooter' },
  { value: 'van', label: 'Van' },
  { value: 'pickup', label: 'Pickup Truck' },
  { value: 'suv', label: 'SUV / AUV' },
  { value: 'truck', label: 'Truck / Heavy Vehicle' },
  { value: 'other', label: 'Other Motor Vehicle' },
] as const;

// ============================================================
// FORM SCHEMA (Zod)
// ============================================================
const nameRegex = /^[\p{L}\s\-'.]+$/u;

export function createGetPassSchema(schedulingDaysAhead: number = MAX_VISIT_ADVANCE_DAYS) {
  return z
    .object({
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
        .min(7, 'Contact number is too short')
        .max(20, 'Contact number is too long')
        .refine((val) => validatePhMobile(val), {
          message: 'Please enter a valid Philippine mobile number (e.g. 09171234567 or +639171234567)',
        }),
      homeLocation: z
        .object({
          lat: z.number(),
          lon: z.number(),
        })
        .nullable()
        .optional(),
      purpose: z
        .string()
        .max(300, 'Purpose description is too long')
        .optional()
        .or(z.literal('')),
      visitDate: z
        .string()
        .optional()
        .or(z.literal(''))
        .superRefine((val, ctx) => {
          if (!val) return;
          const res = validateVisitDate(val, new Date(), schedulingDaysAhead);
          if (!res.valid && res.error) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: res.error,
            });
          }
        }),
      arrivalMode: z.enum(['no_vehicle', 'vehicle']),
      vehicleType: z.string().optional(),
      plateNumber: z.string().optional(),
      vehicleColor: z.string().optional(),
      makeModel: z.string().optional(),
      consent: z.literal(true, {
        message: 'You must accept the Data Privacy Act notice to proceed',
      }),
    });
}

export const vehicleStepSchema = z.object({
  vehicleType: z.string().trim().min(1, 'Please select a vehicle type'),
  plateNumber: z.string().superRefine((val, ctx) => {
    const plateRes = normalizeVehiclePlate(val || '');
    if (!plateRes.valid) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: plateRes.error || 'Please enter a valid plate number',
      });
    }
  }),
  vehicleColor: z.string().trim().min(2, 'Please enter vehicle color'),
  makeModel: z.string().trim().min(2, 'Vehicle make and model must be between 2 and 100 characters').max(100, 'Vehicle make and model must be between 2 and 100 characters'),
});

export type GetPassFormData = z.infer<ReturnType<typeof createGetPassSchema>>;

type Step =
  | 'frontdoor'
  | 'arrival_setup'
  | 'form'
  | 'visit'
  | 'photo'
  | 'id'
  | 'verify'
  | 'review'
  | 'generating'
  | 'delivery'
  | 'done'
  | 'request_submitted'
  | 'returning_lookup'
  | 'returning_results'
  | 'returning_capture'
  | 'returning_confirm'
  | 'returning_review';

// ============================================================
// COMPONENT
// ============================================================
export function GetPassPage() {
  const { updateAvailable, reloadApp } = useBuildVersion();

  const initialMode = typeof window !== 'undefined'
    ? new URLSearchParams(window.location.search).get('mode')
    : null;
  const initialArrival = typeof window !== 'undefined'
    ? new URLSearchParams(window.location.search).get('arrival')
    : null;
  const validArrival = (initialArrival === 'no_vehicle' || initialArrival === 'vehicle') ? initialArrival : null;

  const [step, setStep] = useState<Step>(() => {
    if (initialMode === 'new') {
      return validArrival ? 'form' : 'arrival_setup';
    }
    return 'frontdoor';
  });
  const [registrationMode, setRegistrationMode] = useState<'new' | 'returning'>(
    initialMode === 'returning' ? 'returning' : 'new'
  );
  const [returningAvailable, setReturningAvailable] = useState<boolean | null>(null);
  const [capabilitiesDiagnostics, setCapabilitiesDiagnostics] = useState<{
    returningVisitorAvailable?: boolean;
    returningEnrollmentAvailable?: boolean;
    facialRecognitionConfigured?: boolean;
    returningCryptoConfigured?: boolean;
    thresholdConfigured?: boolean;
    thresholdMode?: 'provisional' | 'calibrated' | 'unconfigured';
    returningCalibrationConfigured?: boolean;
    biometricStorageRetired?: boolean;
    turnstile?: { siteKeyConfigured: boolean; serverVerifierConfigured: boolean; verified: boolean };
  } | null>(null);
  const [showReturningGateModal, setShowReturningGateModal] = useState(false);

  // Returning visitor profile state
  const [returningProfile, setReturningProfile] = useState<{
    profileId: string;
    fullName: string;
    firstName: string;
    middleName?: string;
    lastName: string;
    contactNumber: string;
    homeAddress?: string | null;
    homeLocation?: { lat: number; lon: number } | null;
    matchToken: string;
    verificationState?: 'calibrated' | 'provisional';
    guardVerificationRequired?: boolean;
    savedVehicles: Array<{
      id: string;
      vehicleType: string;
      plateNumber: string;
      color: string;
      makeModel?: string | null;
    }>;
  } | null>(null);
  const [isIdentifyingReturning, setIsIdentifyingReturning] = useState(false);
  const [returningIdentifyError, setReturningIdentifyError] = useState<string | null>(null);
  const [saveReturningUpdates, setSaveReturningUpdates] = useState(false);
  const [selectedSavedVehicleId, setSelectedSavedVehicleId] = useState<string>('none');
  const [saveVehicle, setSaveVehicle] = useState(false);

  // Returning visitor capture/freeze/review workflow state
  const [returningCaptureStage, setReturningCaptureStage] = useState<'live' | 'review'>('live');
  const [returningSelfieBlob, setReturningSelfieBlob] = useState<Blob | null>(null);
  const [returningSelfieUrl, setReturningSelfieUrl] = useState<string | null>(null);
  const historicalIdUrl = useObjectUrl();
  const historicalIdPreview = historicalIdUrl.url;
  const historicalIdRequestGeneration = useRef(0);
  const [loadingHistoricalId, setLoadingHistoricalId] = useState(false);

  // Data Privacy Notice Modal state
  const [showPrivacyModal, setShowPrivacyModal] = useState(false);

  // Automatic Returning Visitor Candidate Match state (Step 1 -> Auto Check)
  const [candidateMatch, setCandidateMatch] = useState<ReturningLookupCandidate | null>(null);
  const [showCandidateMatchModal, setShowCandidateMatchModal] = useState(false);
  const [isCheckingReturningCandidate, setIsCheckingReturningCandidate] = useState(false);

  // Historical evidence URLs & metadata for Returning Visitor Welcome Back screen
  const [originalPortraitUrl, setOriginalPortraitUrl] = useState<string | null>(null);
  const [portalToken, setPortalToken] = useState<string | null>(null);
  const [originalPortraitDate, setOriginalPortraitDate] = useState<string | null>(null);
  const [historicalIdSubmittedDate, setHistoricalIdSubmittedDate] = useState<string | null>(null);

  // Returning visitor 1:1 lookup state
  const [returningLookupFirst, setReturningLookupFirst] = useState('');
  const [returningLookupMiddle, setReturningLookupMiddle] = useState('');
  const [returningLookupLast, setReturningLookupLast] = useState('');
  const [returningLookupContact, setReturningLookupContact] = useState('');
  const [returningCandidates, setReturningCandidates] = useState<ReturningLookupCandidate[]>([]);
  const [selectedReturningCandidate, setSelectedReturningCandidate] = useState<ReturningLookupCandidate | null>(null);
  const [isSearchingReturning, setIsSearchingReturning] = useState(false);
  const [returningSearchError, setReturningSearchError] = useState<string | null>(null);

  // Office & Visit Type State
  const [offices, setOffices] = useState<Array<{ id: string; name: string; description: string | null; requires_approval_before_pass?: boolean }>>([]);
  const [selectedOfficeId, setSelectedOfficeId] = useState<string>('');
  const [visitType, setVisitType] = useState<'general' | 'specific_person' | null>(null);
  const [personnelList, setPersonnelList] = useState<Array<{ id: string; name: string; title: string | null }>>([]);
  const [selectedPersonnelId, setSelectedPersonnelId] = useState<string>('');
  const [requestedPersonName, setRequestedPersonName] = useState<string>('');
  const [specificPurpose, setSpecificPurpose] = useState<string>('');
  const [officeSchedules, setOfficeSchedules] = useState<Array<{ id: string; schedule_date: string; status: string; reason?: string }>>([]);

  // Institutional Calendar Closures & OCR Address States
  const [calendarClosures, setCalendarClosures] = useState<import('@/types').CampusCalendarClosure[]>([]);
  const [detectedOcrAddress, setDetectedOcrAddress] = useState<DetectedAddressDetails | null>(null);
  const [showOcrAddressCard, setShowOcrAddressCard] = useState<boolean>(false);
  const [showBiometricFailureModal, setShowBiometricFailureModal] = useState<boolean>(false);

  // Email verification state for specific-person visit
  const [visitorEmail, setVisitorEmail] = useState<string>('');
  const [emailVerificationCode, setEmailVerificationCode] = useState<string>('');
  const [emailVerificationToken, setEmailVerificationToken] = useState<string | null>(null);
  const [isSendingVerificationCode, setIsSendingVerificationCode] = useState<boolean>(false);
  const [isVerifyingCode, setIsVerifyingCode] = useState<boolean>(false);
  const [codeSent, setCodeSent] = useState<boolean>(false);
  const [codeCooldown, setCodeCooldown] = useState<number>(0);
  const [submittedRequestData, setSubmittedRequestData] = useState<{
    officeName: string;
    personnelName: string;
    visitDate: string;
    visitorEmail: string;
    trackingUrl?: string;
    trackingToken?: string;
    emailDeliveryStatus?: string;
  } | null>(null);

  useEffect(() => {
    if (codeCooldown <= 0) return;
    const t = setInterval(() => setCodeCooldown((prev) => prev - 1), 1000);
    return () => clearInterval(t);
  }, [codeCooldown]);

  useEffect(() => {
    fetch('/api/office/personnel')
      .then((r) => r.json())
      .then((data) => {
        if (data?.offices) setOffices(data.offices);
      })
      .catch((err) => console.error('Failed to load offices:', err));

    fetch('/api/system/calendar')
      .then((r) => r.json())
      .then((data) => {
        if (data?.closures) setCalendarClosures(data.closures);
      })
      .catch((err) => console.error('Failed to load campus calendar closures:', err));

    return () => {
      void terminateLocalOcrWorker();
    };
  }, []);

  useEffect(() => {
    if (!selectedOfficeId) {
      setPersonnelList([]);
      setSelectedPersonnelId('');
      setOfficeSchedules([]);
      return;
    }
    fetch(`/api/office/personnel?officeId=${selectedOfficeId}`)
      .then((r) => r.json())
      .then((data) => {
        if (data?.personnel) setPersonnelList(data.personnel);
      })
      .catch((err) => console.error('Failed to load personnel:', err));

    fetch(`/api/office/calendar?officeId=${encodeURIComponent(selectedOfficeId)}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data?.schedules && Array.isArray(data.schedules)) {
          setOfficeSchedules(data.schedules);
        } else {
          setOfficeSchedules([]);
        }
      })
      .catch((err) => {
        console.warn('Failed to load office calendar schedules:', err);
        setOfficeSchedules([]);
      });
  }, [selectedOfficeId]);

  // Live Face State (Single custom camera)
  const [photoBlob, setPhotoBlob] = useState<Blob | null>(null);
  const photoUrl = useObjectUrl();
  const photoPreview = photoUrl.url;
  const [liveFaceError, setLiveFaceError] = useState<{
    category: 'quality' | 'session' | 'upload' | 'network' | 'service';
    title: string;
    message: string;
    reasonCode?: string;
  } | null>(null);
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
  const ocrJobIdRef = useRef<number>(0);

  // Identity Verification State
  const [isVerifyingIdentity, setIsVerifyingIdentity] = useState(false);
  const [identityVerified, setIdentityVerified] = useState(false);
  const [verificationError, setVerificationError] = useState<string | null>(null);

  // Setup Decisions State
  const [setupArrivalMode, setSetupArrivalMode] = useState<'no_vehicle' | 'vehicle' | null>(validArrival);

  // Approximate Residential Location State
  const [homeLocation, setHomeLocation] = useState<any | null>(null);

  // Structured PSGC Residential Address State
  const [selectedPsgc, setSelectedPsgc] = useState<SelectedPsgcAddress | null>(null);
  const [homeBuilding, setHomeBuilding] = useState('');
  const [homeStreet, setHomeStreet] = useState('');
  const [addressError, setAddressError] = useState<string | null>(null);

  // Controlled Vehicle Catalog State
  const [availableMakes, setAvailableMakes] = useState<string[]>([]);
  const [selectedMake, setSelectedMake] = useState<string>('');
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [selectedModel, setSelectedModel] = useState<string>('');
  const [customMake, setCustomMake] = useState<string>('');
  const [customModel, setCustomModel] = useState<string>('');
  const [vehicleCatalogMode, setVehicleCatalogMode] = useState<'catalog' | 'manual_make' | 'manual_model'>('catalog');
  const [isLoadingMakes, setIsLoadingMakes] = useState<boolean>(false);
  const [isLoadingModels, setIsLoadingModels] = useState<boolean>(false);

  // Vehicle Photo Evidence State
  const [vehiclePhotoBlob, setVehiclePhotoBlob] = useState<Blob | null>(null);
  const vehiclePhotoUrl = useObjectUrl();
  const vehiclePhotoPreview = vehiclePhotoUrl.url;
  const [vehiclePhotoError, setVehiclePhotoError] = useState<string | null>(null);
  const [isProcessingVehiclePhoto, setIsProcessingVehiclePhoto] = useState(false);
  const vehicleFileInputRef = useRef<HTMLInputElement>(null);

  // Turnstile & Pass State
  const turnstileRef = useRef<TurnstileWidgetRef>(null);
  const [isStartingRegistration, setIsStartingRegistration] = useState(false);
  const [registrationSecurityError, setRegistrationSecurityError] = useState<string | null>(null);

  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [passId, setPassId] = useState<string | null>(null);
  const [passPresentation, setPassPresentation] = useState<PassPresentation | null>(null);
  const [rawQrToken, setRawQrToken] = useState<string | null>(null);
  const [qrRenderingError, setQrRenderingError] = useState(false);

  const handleRetryQrRendering = async () => {
    if (!rawQrToken) return;
    try {
      let qrUrl: string | null = null;
      try {
        qrUrl = await generateBrandedQrDataUrl(rawQrToken, { size: 360 });
      } catch (qrErr) {
        console.warn('Branded QR generation failed, falling back to standard QR:', qrErr);
        try {
          qrUrl = await QRCode.toDataURL(rawQrToken, { width: 360, margin: 2, errorCorrectionLevel: 'H' });
        } catch (fallbackErr) {
          console.error('Standard QR generation fallback failed:', fallbackErr);
        }
      }

      if (!qrUrl) {
        toast.error('Could not render QR code image. Please try again.');
        return;
      }

      setQrDataUrl(qrUrl);
      setQrRenderingError(false);
      setStep('delivery');
      setShowEmailModal(true);
      toast.success('Gate pass generated successfully!');
    } catch {
      toast.error('Failed to regenerate QR code. Please try again.');
    }
  };
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
  const [transactionPhase, setTransactionPhase] = useState<IssueTransactionPhase | null>(null);
  const currentPhase = transactionPhase ?? portalTransactionRef.current?.phase;
  const livePhotoIntentIdRef = useRef<string | null>(null);

  const [visitorInstructions, setVisitorInstructions] = useState<string[]>([
    'Follow the EARIST visitor dress code and campus policies.',
    'Bring a valid ID for identity verification at the gate.',
    'Keep your E-GatePass ready before approaching the entrance.',
    'This visitor pass is personal and non-transferable.',
    'Scan your E-GatePass when leaving the campus.',
  ]);

  // Query capabilities on mount for returning visitor gate
  useEffect(() => {
    fetch('/api/passes/capabilities')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data) {
          setReturningAvailable(Boolean(data?.returningVisitorAvailable));
          setCapabilitiesDiagnostics({
            returningVisitorAvailable: Boolean(data.returningVisitorAvailable),
            returningEnrollmentAvailable: Boolean(data.returningEnrollmentAvailable),
            facialRecognitionConfigured: Boolean(data.facialRecognitionConfigured),
            returningCryptoConfigured: Boolean(data.returningCryptoConfigured),
            thresholdConfigured: Boolean(data.thresholdConfigured),
            thresholdMode: data.thresholdMode || 'unconfigured',
            returningCalibrationConfigured: Boolean(data.returningCalibrationConfigured),
            biometricStorageRetired: Boolean(data.biometricStorageRetired),
            turnstile: data.turnstile || undefined,
          });
        }
      })
      .catch(() => {
        setReturningAvailable(false);
      });
  }, []);

  function onRetakeId() {
    void abandonPortalEvidence(portalTransactionRef.current, 'id');
    invalidatePortalEvidenceCheckpoint(portalTransactionRef.current, 'id');
    setIdBlob(null);
    idUrl.clear();
    setIdReusedFromOcr(false);
    setIdentityVerified(false);
    setVerificationError(null);
    setIdQualityError(null);
    setStep('id');
  }

  // Unmount cleanup for OCR worker
  useEffect(() => {
    return () => {
      ocrGenerationRef.current += 1;
      void import('@/lib/ocr').then(({ terminateLocalOcrWorker }) => terminateLocalOcrWorker()).catch(() => {});
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
  const faceWebcam = useWebcam({ facingMode: 'user', width: 720, height: 960, targetAspectRatio: SELFIE_TARGET_ASPECT_RATIO, allowCaptureMirroring: false });

  // Camera unmount cleanup only: stop camera tracks when the page actually unmounts
  useEffect(() => {
    return () => {
      faceWebcam.stop();
    };
  }, []);

  // Preview URL cleanup ref: safely revokes object URL on genuine unmount without interrupting camera lifecycle
  const returningSelfieUrlRef = useRef<string | null>(null);
  returningSelfieUrlRef.current = returningSelfieUrl;
  useEffect(() => {
    return () => {
      if (returningSelfieUrlRef.current) {
        URL.revokeObjectURL(returningSelfieUrlRef.current);
      }
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
    trigger,
    getValues,
    setValue,
    setError,
    clearErrors,
    watch,
    reset,
    formState: { errors },
  } = useForm<GetPassFormData>({
    resolver: zodResolver(formSchema),
    mode: 'onChange',
    defaultValues: {
      purpose: '',
      arrivalMode: (validArrival || undefined) as any,
      homeLocation: null,
      vehicleType: 'car',
      plateNumber: '',
      vehicleColor: '',
      makeModel: '',
    },
  });

  const purpose = watch('purpose');
  const arrivalMode = watch('arrivalMode');

  // Vehicle State Clearing
  function clearVehicleDeclarationState() {
    clearErrors(['vehicleType', 'plateNumber', 'vehicleColor', 'makeModel']);
    setValue('plateNumber', '');
    setValue('vehicleColor', '');
    setValue('makeModel', '');
    setValue('vehicleType', 'car');
    setSelectedMake('');
    setSelectedModel('');
    setCustomMake('');
    setCustomModel('');
    setVehicleCatalogMode('catalog');
    setVehiclePhotoBlob(null);
    vehiclePhotoUrl.clear();
    setVehiclePhotoError(null);
    void abandonPortalEvidence(portalTransactionRef.current, 'vehicle');
    invalidatePortalEvidenceCheckpoint(portalTransactionRef.current, 'vehicle');
    if (vehicleFileInputRef.current) {
      vehicleFileInputRef.current.value = '';
    }
  }

  function beginNewVisitorSetup() {
    setRegistrationMode('new');
    setReturningProfile(null);
    setReturningIdentifyError(null);
    setSelectedSavedVehicleId('none');
    setSetupArrivalMode(null);
    setValue('arrivalMode', undefined as any, { shouldValidate: false });
    clearVehicleDeclarationState();
    setStep('arrival_setup');
  }

  function resetRegistrationFlow() {
    ocrGenerationRef.current += 1;
    void import('@/lib/ocr').then(({ terminateLocalOcrWorker }) => terminateLocalOcrWorker()).catch(() => {});

    // 1. Reset React Hook Form values to clean defaults
    reset({
      purpose: '',
      arrivalMode: undefined as any,
      vehicleType: 'car',
      plateNumber: '',
      vehicleColor: '',
      makeModel: '',
      firstName: '',
      middleName: '',
      lastName: '',
      contactNumber: '',
      visitDate: '',
      consent: false as any,
    });
    clearErrors();

    // 2. Clear residential location state
    setHomeLocation(null);
    setValue('homeLocation', null);
    setSelectedPsgc(null);
    setHomeBuilding('');
    setHomeStreet('');
    setAddressError(null);

    // 3. Clear vehicle state
    clearVehicleDeclarationState();
    setAvailableMakes([]);
    setAvailableModels([]);
    setSelectedSavedVehicleId('none');

    // 4. Clear returning visitor state
    setRegistrationMode('new');
    setReturningProfile(null);
    setReturningIdentifyError(null);
    setSaveReturningUpdates(false);
    setSaveVehicle(false);
    setShowReturningGateModal(false);
    setReturningCaptureStage('live');
    setReturningSelfieBlob(null);
    if (returningSelfieUrl) {
      URL.revokeObjectURL(returningSelfieUrl);
      setReturningSelfieUrl(null);
    }
    historicalIdRequestGeneration.current++;
    historicalIdUrl.clear();
    setLoadingHistoricalId(false);
    setReturningCandidates([]);
    setSelectedReturningCandidate(null);
    setReturningSearchError(null);
    setShowPrivacyModal(false);
    setCandidateMatch(null);
    setShowCandidateMatchModal(false);
    setIsCheckingReturningCandidate(false);
    setOriginalPortraitUrl(null);
    setOriginalPortraitDate(null);
    setHistoricalIdSubmittedDate(null);

    // 5. Clear identity evidence & stop webcam
    void abandonPortalEvidence(portalTransactionRef.current, 'photo');
    void abandonPortalEvidence(portalTransactionRef.current, 'id');
    void abandonPortalEvidence(portalTransactionRef.current, 'vehicle');
    invalidatePortalEvidenceCheckpoint(portalTransactionRef.current, 'photo');
    invalidatePortalEvidenceCheckpoint(portalTransactionRef.current, 'id');
    invalidatePortalEvidenceCheckpoint(portalTransactionRef.current, 'vehicle');
    setPhotoBlob(null);
    setIdBlob(null);
    setVehiclePhotoBlob(null);
    photoUrl.clear();
    idUrl.clear();
    vehiclePhotoUrl.clear();
    setIdentityVerified(false);
    setVerificationError(null);
    setLiveFaceError(null);
    setIdQualityError(null);
    setVehiclePhotoError(null);
    setIdReusedFromOcr(false);
    setOcrSuccessNotice(null);
    setRegistrationSecurityError(null);
    faceWebcam.stop();

    // 6. Clear pass & delivery
    setPassId(null);
    setQrDataUrl(null);
    setRawQrToken(null);
    setPassPresentation(null);
    setShowEmailModal(false);
    setShowSkipWarning(false);
    setEmailDeliverySecured(false);
    setEmailSkipped(false);
    setEmailOutcomeUnknown(false);
    setIsDownloaded(false);
    setSubmitError(null);

    // 7. Rotate request ID and nullify transaction
    issueRequestId.current = crypto.randomUUID();
    portalTransactionRef.current = null; setPortalToken(null);
    setTransactionPhase(null);
    turnstileRef.current?.resetChallenge();
    livePhotoIntentIdRef.current = null;
    setSetupArrivalMode(null);

    // 8. Navigate to Front Door
    setStep('frontdoor');
  }

  // Vehicle makes and models loading
  const selectedVehicleType = watch('vehicleType') || 'car';

  useEffect(() => {
    let active = true;
    setIsLoadingMakes(true);
    setSelectedMake('');
    setSelectedModel('');
    setCustomMake('');
    setCustomModel('');
    setVehicleCatalogMode('catalog');
    setValue('makeModel', '');
    clearErrors('makeModel');
    setAvailableModels([]);

    fetch(`/api/vehicles/makes?type=${encodeURIComponent(selectedVehicleType)}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!active) return;
        const list = Array.isArray(data?.makes)
          ? data.makes
          : Array.isArray(data)
            ? data
            : [];
        setAvailableMakes(list);
      })
      .catch(() => {
        if (active) setAvailableMakes([]);
      })
      .finally(() => {
        if (active) setIsLoadingMakes(false);
      });
    return () => {
      active = false;
    };
  }, [selectedVehicleType]);

  useEffect(() => {
    if (!selectedMake) {
      setAvailableModels([]);
      setSelectedModel('');
      setVehicleCatalogMode('catalog');
      return;
    }
    if (selectedMake === 'Other / Not Listed') {
      setAvailableModels([]);
      setSelectedModel('');
      setVehicleCatalogMode('manual_make');
      return;
    }

    setVehicleCatalogMode((prev) => (prev === 'manual_make' ? 'catalog' : prev));
    let active = true;
    setIsLoadingModels(true);
    setSelectedModel('');
    fetch(
      `/api/vehicles/models?make=${encodeURIComponent(selectedMake)}&type=${encodeURIComponent(selectedVehicleType)}`
    )
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!active) return;
        const list = Array.isArray(data?.models)
          ? data.models
          : Array.isArray(data)
            ? data
            : [];
        setAvailableModels(list);
      })
      .catch(() => {
        if (active) setAvailableModels([]);
      })
      .finally(() => {
        if (active) setIsLoadingModels(false);
      });
    return () => {
      active = false;
    };
  }, [selectedMake, selectedVehicleType]);

  // Sync displayed makeModel to form state
  useEffect(() => {
    if (vehicleCatalogMode === 'manual_make') {
      const full = [customMake.trim(), customModel.trim()].filter(Boolean).join(' ');
      setValue('makeModel', full);
    } else if (vehicleCatalogMode === 'manual_model') {
      const full = [selectedMake.trim(), customModel.trim()].filter(Boolean).join(' ');
      setValue('makeModel', full);
    } else {
      if (
        selectedMake &&
        selectedModel &&
        selectedMake !== 'Other / Not Listed' &&
        selectedModel !== 'Other / Not Listed'
      ) {
        setValue('makeModel', `${selectedMake.trim()} ${selectedModel.trim()}`);
      } else {
        setValue('makeModel', '');
      }
    }
  }, [vehicleCatalogMode, customMake, customModel, selectedMake, selectedModel, setValue]);

  async function handleVehiclePhotoSelected(file: File | Blob) {
    setIsProcessingVehiclePhoto(true);
    setVehiclePhotoError(null);
    try {
      const normalized = await normalizeVehicleImage(file);
      setVehiclePhotoBlob(normalized);
      vehiclePhotoUrl.setFromBlob(normalized);
      invalidatePortalEvidenceCheckpoint(portalTransactionRef.current, 'vehicle');
    } catch (err: any) {
      console.error('Vehicle image normalization failed:', err);
      setVehiclePhotoError('Vehicle photo could not be processed. Please try another photo.');
    } finally {
      setIsProcessingVehiclePhoto(false);
    }
  }

  function handleRemoveVehiclePhoto() {
    setVehiclePhotoBlob(null);
    vehiclePhotoUrl.clear();
    setVehiclePhotoError(null);
    invalidatePortalEvidenceCheckpoint(portalTransactionRef.current, 'vehicle');
    if (vehicleFileInputRef.current) {
      vehicleFileInputRef.current.value = '';
    }
  }

  // Manila-aware calendar date limits
  const today = getManilaDateString();
  const latestVisitDate = getLatestVisitDateString(today, schedulingDaysAhead);

  // ============================================================
  // STEP 1: PERSONAL DETAILS (onFormNext advances to Visit)
  // ============================================================
  async function onFormNext(formData?: GetPassFormData) {
    const valid = await trigger(['firstName', 'middleName', 'lastName', 'contactNumber', 'consent']);
    if (!valid) return;

    const data = formData || getValues();
    if (!data.firstName?.trim() || !data.lastName?.trim()) {
      toast.error('Please enter your first and last name.');
      return;
    }
    const phRes = normalizePhMobile(data.contactNumber);
    if (!phRes) {
      toast.error('Please enter a valid Philippine mobile number (e.g. 09171234567 or +639171234567).');
      return;
    }
    setValue('contactNumber', phRes, { shouldValidate: true });
    if (!selectedPsgc) {
      setAddressError('Please select your residential barangay and city.');
      toast.error('Please select your residential barangay and city.');
      return;
    }
    setAddressError(null);
    if (!data.consent) {
      toast.error('You must accept the Data Privacy Act notice to proceed.');
      return;
    }

    // Automatic returning visitor candidate check (Step 1 -> Next)
    try {
      setIsCheckingReturningCandidate(true);
      let tx = portalTransactionRef.current;
      if (!tx || !(await validatePortalSession(tx))) {
        let freshCaptchaToken: string | undefined;
        if (turnstileRef.current) {
          freshCaptchaToken = await turnstileRef.current.executeChallenge();
        } else {
          throw new Error('Security verification widget is initializing. Please wait a moment and try again.');
        }
        tx = await createPortalIssueTransaction(freshCaptchaToken);
        portalTransactionRef.current = tx; setPortalToken(tx?.token ?? null);
        issueRequestId.current = tx.requestId as ReturnType<typeof crypto.randomUUID>;
      }
      const lookupRes = await lookupReturningVisitor(tx, {
        firstName: data.firstName.trim(),
        lastName: data.lastName.trim(),
        middleName: data.middleName?.trim() || undefined,
        contactNumber: phRes,
        psgcCityCode: selectedPsgc?.city?.code,
        psgcBarangayCode: selectedPsgc?.barangay?.code,
        mode: 'auto',
      });
      if (lookupRes.found && lookupRes.candidates && lookupRes.candidates.length > 0 && lookupRes.candidates[0]) {
        setCandidateMatch(lookupRes.candidates[0]);
        setShowCandidateMatchModal(true);
        setIsCheckingReturningCandidate(false);
        return;
      }
    } catch (lookupErr: any) {
      console.warn('Returning visitor auto-lookup error:', lookupErr);
      turnstileRef.current?.resetChallenge();
      const msg = lookupErr?.message || '';
      if (
        msg.includes('challenge') ||
        msg.includes('Security verification') ||
        msg.includes('Turnstile') ||
        msg.includes('Too many search attempts') ||
        msg.includes('rate_limit')
      ) {
        toast.error(msg || 'Security verification failed. Please try again.');
        setIsCheckingReturningCandidate(false);
        return;
      }
    } finally {
      setIsCheckingReturningCandidate(false);
    }

    setStep('visit');
  }

  function onAcceptReturningCandidate() {
    if (!candidateMatch) return;
    const match = candidateMatch;
    setShowCandidateMatchModal(false);
    setRegistrationMode('returning');
    setSelectedReturningCandidate(match);
    setReturningIdentifyError(null);
    setReturningCaptureStage('live');
    setReturningSelfieBlob(null);
    setStep('returning_capture');
    void faceWebcam.start();
  }

  function onDeclineReturningCandidate() {
    setShowCandidateMatchModal(false);
    setCandidateMatch(null);
    setRegistrationMode('new');
    setStep('visit');
  }

  async function handleSendVerificationCode() {
    if (!visitorEmail || !visitorEmail.includes('@') || !visitorEmail.includes('.')) {
      toast.error('Please enter a valid email address.');
      return;
    }
    if (codeCooldown > 0) return;
    setIsSendingVerificationCode(true);
    try {
      if (!portalTransactionRef.current) {
        // Initialize portal transaction if needed
        const token = await createPortalIssueTransaction().then((t) => t.token).catch(() => null);
        if (!token) {
          toast.error('Please ensure personal details are completed.');
          return;
        }
      }
      const token = portalTransactionRef.current?.token;
      const res = await fetch('/api/office/verify-email', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'request_code',
          email: visitorEmail.toLowerCase().trim(),
          fullName: `${getValues('firstName')} ${getValues('lastName')}`.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.message || data.error || 'Failed to send verification code.');
      }
      setCodeSent(true);
      setCodeCooldown(60);
      toast.success('6-digit verification code sent to your email.');
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to send verification code.');
    } finally {
      setIsSendingVerificationCode(false);
    }
  }

  async function handleVerifyEmailCode() {
    if (!emailVerificationCode || emailVerificationCode.trim().length !== 6) {
      toast.error('Please enter the 6-digit verification code.');
      return;
    }
    setIsVerifyingCode(true);
    try {
      const authToken = portalTransactionRef.current?.token;
      const res = await fetch('/api/office/verify-email', {
        method: 'POST',
        headers: { Authorization: `Bearer ${authToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'verify_code',
          email: visitorEmail.toLowerCase().trim(),
          code: emailVerificationCode.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.message || data.error || 'Invalid verification code.');
      }
      const verificationToken = data.emailVerificationToken || data.proofToken;
      if (!verificationToken) {
        throw new Error('Verification token was not received from the server.');
      }
      setEmailVerificationToken(verificationToken);
      toast.success('Email verified successfully!');
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Verification failed.');
    } finally {
      setIsVerifyingCode(false);
    }
  }

  // ============================================================
  // STEP 2: VISIT & VEHICLE DETAILS (onVisitNext advances to Photo)
  // ============================================================
  async function onVisitNext() {
    const vals = getValues();

    if (!selectedOfficeId) {
      toast.error('Please select the university office you are visiting.');
      return;
    }

    if (!visitType) {
      toast.error('Please choose whether you are visiting a specific person or making a general office visit.');
      return;
    }

    if (visitType === 'specific_person') {
      const personName = requestedPersonName.trim() || (selectedPersonnelId ? personnelList.find((p) => p.id === selectedPersonnelId)?.name : '');
      if (!personName || personName.length < 2) {
        toast.error('Please specify the person or faculty you would like to visit (minimum 2 characters).');
        return;
      }
      if (personName.length > 150) {
        toast.error('Person name cannot exceed 150 characters.');
        return;
      }
      if (!specificPurpose || specificPurpose.trim().length < 3) {
        toast.error('Please specify the purpose of your appointment (minimum 3 characters).');
        return;
      }
      if (!emailVerificationToken) {
        toast.error('Email verification is required for specific-person appointments. Please verify your email.');
        return;
      }
    } else {
      if (!vals.purpose || vals.purpose.trim().length < 3) {
        toast.error('Please describe the purpose of your visit (minimum 3 characters).');
        return;
      }
    }

    if (!vals.visitDate) {
      toast.error('Please select a visit date.');
      return;
    }

    const visitDate = vals.visitDate;
    const matchedClosure = calendarClosures.find((c) => c.active !== false && visitDate >= c.startDate && visitDate <= c.endDate);
    if (matchedClosure) {
      toast.error(`Campus is closed on ${visitDate}: ${matchedClosure.title}${matchedClosure.description ? ` (${matchedClosure.description})` : ''}. Please select an open date.`);
      return;
    }

    const matchedOfficeClosure = officeSchedules.find(
      (s) => s.schedule_date === visitDate && ['closed', 'maintenance', 'holiday'].includes(s.status)
    );
    if (matchedOfficeClosure) {
      toast.error(`The selected office is marked ${matchedOfficeClosure.status} on ${visitDate}${matchedOfficeClosure.reason ? `: ${matchedOfficeClosure.reason}` : ''}. Please choose another visit date.`);
      return;
    }

    if (vals.arrivalMode === 'vehicle') {
      clearErrors(['vehicleType', 'plateNumber', 'vehicleColor', 'makeModel']);
      const vResult = vehicleStepSchema.safeParse({
        vehicleType: vals.vehicleType,
        plateNumber: vals.plateNumber,
        vehicleColor: vals.vehicleColor,
        makeModel: vals.makeModel,
      });

      if (!vResult.success) {
        for (const issue of vResult.error.issues) {
          const field = issue.path[0] as 'vehicleType' | 'plateNumber' | 'vehicleColor' | 'makeModel';
          if (field) {
            setError(field, { type: 'custom', message: issue.message });
          }
        }
        const firstIssue = vResult.error.issues[0];
        toast.error(firstIssue?.message || 'Please complete all required vehicle declaration fields.');
        return;
      }

      const plateRes = normalizeVehiclePlate(vals.plateNumber || '');
      if (plateRes.valid && plateRes.displayPlate) {
        setValue('plateNumber', plateRes.displayPlate, { shouldValidate: true });
      }

      if (!vehiclePhotoBlob) {
        toast.error('Please capture or upload a clear photo of your vehicle.');
        return;
      }
    }

    if (isStartingRegistration) return;
    setRegistrationSecurityError(null);

    // If valid portal transaction already exists with an active live session, advance directly
    if (portalTransactionRef.current) {
      const isValid = await validatePortalSession(portalTransactionRef.current);
      if (isValid) {
        setStep('photo');
        void faceWebcam.start();
        return;
      }
      portalTransactionRef.current = null; setPortalToken(null);
      livePhotoIntentIdRef.current = null;
    }

    setIsStartingRegistration(true);
    try {
      let freshCaptchaToken: string | undefined;
      if (turnstileRef.current) {
        freshCaptchaToken = await turnstileRef.current.executeChallenge();
      } else {
        throw new Error('Security verification widget is initializing. Please wait a moment and try again.');
      }

      const tx = await createPortalIssueTransaction(freshCaptchaToken);
      portalTransactionRef.current = tx; setPortalToken(tx?.token ?? null);
      issueRequestId.current = tx.requestId as ReturnType<typeof crypto.randomUUID>;

      turnstileRef.current?.resetChallenge();

      setStep('photo');
      void faceWebcam.start();
    } catch (err: any) {
      console.warn('Registration security challenge or transaction error:', err);
      turnstileRef.current?.resetChallenge();
      const msg = err?.message || 'Could not verify security check. Please try again.';
      setRegistrationSecurityError(msg);
      toast.error(msg);
    } finally {
      setIsStartingRegistration(false);
    }
  }

  // ============================================================
  // RETURNING VISITOR 1:1 LOOKUP & IDENTIFY
  // ============================================================
  async function onSearchReturningProfile() {
    if (!returningLookupFirst.trim() || !returningLookupLast.trim()) {
      setReturningSearchError('Please enter both your First Name and Last Name.');
      return;
    }
    const normPhone = normalizePhMobile(returningLookupContact);
    if (!normPhone) {
      setReturningSearchError('Please enter a valid Philippine mobile number (e.g. 09171234567 or +639171234567) registered with your profile.');
      return;
    }
    setReturningSearchError(null);
    setIsSearchingReturning(true);
    setReturningCandidates([]);
    setSelectedReturningCandidate(null);

    try {
      let tx = portalTransactionRef.current;
      if (!tx || !(await validatePortalSession(tx))) {
        let freshCaptchaToken: string | undefined;
        if (turnstileRef.current) {
          freshCaptchaToken = await turnstileRef.current.executeChallenge();
        } else {
          throw new Error('Security verification widget is initializing. Please wait a moment and try again.');
        }
        tx = await createPortalIssueTransaction(freshCaptchaToken);
        portalTransactionRef.current = tx; setPortalToken(tx?.token ?? null);
        issueRequestId.current = tx.requestId as ReturnType<typeof crypto.randomUUID>;
      }

      const res = await lookupReturningVisitor(tx, {
        firstName: returningLookupFirst.trim(),
        lastName: returningLookupLast.trim(),
        middleName: returningLookupMiddle.trim() || undefined,
        contactNumber: normPhone,
        mode: 'manual',
      });

      if (res.found && res.candidates.length > 0) {
        setReturningCandidates(res.candidates);
        if (res.candidates.length === 1 && res.candidates[0]) {
          setSelectedReturningCandidate(res.candidates[0]);
        }
      } else {
        setReturningCandidates([]);
      }
      setStep('returning_results');
    } catch (err: any) {
      console.warn('Returning visitor profile search error:', err);
      turnstileRef.current?.resetChallenge();
      let msg = err?.message || 'Unable to search for visitor profiles. Please try again.';
      if (msg.includes('challenge') || msg.includes('Security verification') || msg.includes('Turnstile')) {
        msg = 'Security verification could not be completed. Please try again or register as a New Visitor.';
      }
      setReturningSearchError(msg);
    } finally {
      setIsSearchingReturning(false);
    }
  }

  async function onCaptureReturningSelfie() {
    if (!selectedReturningCandidate) {
      toast.error('Please select your profile before capturing your face.');
      return;
    }

    if (!faceWebcam.isActive) {
      toast.error('Camera is not ready yet. Please wait a moment.');
      return;
    }

    // Invalidate prior photo checkpoint so this new capture receives a fresh upload intent and storage object
    invalidatePortalEvidenceCheckpoint(portalTransactionRef.current, 'photo');

    const blob = faceWebcam.capture({ mirror: false });
    if (!blob) {
      toast.error('Failed to capture photo. Please hold steady and try again.');
      return;
    }

    if (returningSelfieUrl) {
      URL.revokeObjectURL(returningSelfieUrl);
    }
    const url = URL.createObjectURL(blob);
    setReturningSelfieBlob(blob);
    setReturningSelfieUrl(url);
    faceWebcam.stop();
    setReturningIdentifyError(null);
    setReturningCaptureStage('review');
  }

  function onRetakeReturningSelfie() {
    if (isIdentifyingReturning) return;

    // 1. Invalidate and abandon previous upload checkpoint
    void abandonPortalEvidence(portalTransactionRef.current, 'photo');
    invalidatePortalEvidenceCheckpoint(portalTransactionRef.current, 'photo');

    // 2. Revoke previous preview URL exactly once
    if (returningSelfieUrl) {
      URL.revokeObjectURL(returningSelfieUrl);
      setReturningSelfieUrl(null);
    }
    historicalIdRequestGeneration.current++;
    historicalIdUrl.clear();
    setLoadingHistoricalId(false);

    // 3. Clear old blob and error message
    setReturningSelfieBlob(null);
    setReturningIdentifyError(null);

    // 4. Return to live camera stage and start webcam
    setReturningCaptureStage('live');
    void faceWebcam.start();
  }

  async function onConfirmReturningVerification() {
    if (!selectedReturningCandidate) {
      toast.error('Please select your profile before capturing your face.');
      return;
    }

    if (!returningSelfieBlob) {
      toast.error('No captured photo found. Please capture your selfie first.');
      return;
    }

    setIsIdentifyingReturning(true);
    setReturningIdentifyError(null);

    try {
      // 1. Client-side technical image quality precheck (decodability, min resolution >=240px, extreme darkness/glare)
      // Authoritative facial sharpness is evaluated on the face crop by YuNet/SFace on the server
      const precheck = await evaluateReturningSelfiePrecheck(returningSelfieBlob);
      if (!precheck.passed) {
        setReturningIdentifyError(precheck.message);
        toast.error(precheck.message);
        return;
      }

      // 2. Ensure verified anonymous portal session & transaction
      let tx = portalTransactionRef.current;
      if (!tx || !(await validatePortalSession(tx))) {
        let freshCaptchaToken: string | undefined;
        if (turnstileRef.current) {
          freshCaptchaToken = await turnstileRef.current.executeChallenge();
        } else {
          throw new Error('Security verification widget is initializing. Please wait a moment and try again.');
        }
        tx = await createPortalIssueTransaction(freshCaptchaToken);
        portalTransactionRef.current = tx; setPortalToken(tx?.token ?? null);
        issueRequestId.current = tx.requestId as ReturnType<typeof crypto.randomUUID>;
      }

      // 3. Identify returning visitor via ephemeral 1:1 endpoint (in-memory comparison against original portrait)
      const data = await identifyReturningVisitor(tx, returningSelfieBlob, selectedReturningCandidate.profileId);

      if (!data?.matched || !data.profile || !data.matchToken) {
        const reasonCode = (data as any)?.reasonCode || '';
        const rawMsg = data?.message || '';
        let userFriendlyMsg = 'Make sure your face is clearly visible, look directly at the camera and use even lighting. You can retake your selfie and try again.';

        if (reasonCode === 'no_face' || reasonCode === 'no_face_in_selfie' || /no face/i.test(rawMsg)) {
          userFriendlyMsg = 'No face was detected in your selfie. Please position your face inside the guide, look directly at the camera, and retake.';
        } else if (reasonCode === 'multiple_faces' || /multiple/i.test(rawMsg)) {
          userFriendlyMsg = 'More than one face was detected. Please make sure only you are in frame and retake your selfie.';
        } else if (reasonCode === 'too_small' || reasonCode === 'face_too_small' || /small|closer/i.test(rawMsg)) {
          userFriendlyMsg = 'Your face is too far away. Move closer to the camera and retake your selfie.';
        } else if (reasonCode === 'too_dark' || /dark/i.test(rawMsg)) {
          userFriendlyMsg = 'Your face is too dark. Please face a light source and retake your selfie.';
        } else if (reasonCode === 'overexposed' || /glare|overexposed/i.test(rawMsg)) {
          userFriendlyMsg = 'Too much glare or backlighting on your face. Please move away from harsh lighting and retake.';
        } else if (reasonCode === 'blurry' || /blurry/i.test(rawMsg)) {
          userFriendlyMsg = 'Your face is blurry. Please hold the device steady, allow the camera to focus, and try again.';
        } else if (reasonCode === 'framing_failed' || /framing|center|oval/i.test(rawMsg)) {
          userFriendlyMsg = 'Please center your face inside the oval guide and retake your selfie.';
        } else if (rawMsg && !/could not verify/i.test(rawMsg)) {
          userFriendlyMsg = rawMsg;
        }

        setReturningIdentifyError(userFriendlyMsg);
        setShowBiometricFailureModal(true);
        return;
      }

      // Profile matched!
      const p = data.profile;
      const fullName = [p.firstName, p.middleName, p.lastName].filter(Boolean).join(' ');
      setReturningProfile({
        profileId: p.id,
        fullName,
        firstName: p.firstName,
        middleName: p.middleName || '',
        lastName: p.lastName,
        contactNumber: p.contactNumber,
        homeAddress: p.homeAddress || null,
        homeLocation: p.homeLocation || null,
        matchToken: data.matchToken,
        verificationState: data.verificationState || (data.thresholdMode === 'provisional' ? 'provisional' : 'calibrated'),
        guardVerificationRequired: data.guardVerificationRequired ?? (data.thresholdMode === 'provisional'),
        savedVehicles: (data.savedVehicles || []).map((v) => ({
          id: v.id,
          vehicleType: v.vehicleType,
          plateNumber: v.plateNumber,
          color: v.color || 'White',
          makeModel: v.makeModel || null,
        })),
      });

      // Prepopulate form values
      setValue('firstName', p.firstName, { shouldValidate: true });
      setValue('middleName', p.middleName || '');
      setValue('lastName', p.lastName, { shouldValidate: true });
      setValue('contactNumber', p.contactNumber, { shouldValidate: true });
      // Address hydration: unconditional explicit assignments prevent stale session values
      // from leaking into a new visitor's Welcome Back screen.
      const hydratedAddr = hydrateReturningAddress(p);
      setSelectedPsgc(hydratedAddr.selectedPsgc);
      setHomeBuilding(hydratedAddr.homeBuilding);
      setHomeStreet(hydratedAddr.homeStreet);

      if (p.homeLocation) {
        setHomeLocation(p.homeLocation);
        setValue('homeLocation', p.homeLocation, { shouldValidate: true });
      } else {
        setHomeLocation(null);
        setValue('homeLocation', null);
      }

      if (data.originalPortraitUrl) {
        setOriginalPortraitUrl(data.originalPortraitUrl);
      }
      if (data.originalPortraitDate) {
        setOriginalPortraitDate(data.originalPortraitDate);
      }
      if (data.historicalIdUrl) {
        historicalIdUrl.setUrl(data.historicalIdUrl);
      }
      if (data.historicalIdDate) {
        setHistoricalIdSubmittedDate(data.historicalIdDate);
      }

      setPhotoBlob(returningSelfieBlob);
      photoUrl.setFromBlob(returningSelfieBlob);
      setIdentityVerified(true);
      faceWebcam.stop();

      // Explicit vehicle choice defaults to on foot until visitor explicitly selects vehicle
      setSelectedSavedVehicleId('none');
      setValue('arrivalMode', 'no_vehicle');
      setVehiclePhotoBlob(null);
      vehiclePhotoUrl.clear();

      setStep('returning_confirm');
      toast.success(`Welcome back, ${p.firstName}!`);
    } catch (err: any) {
      if (
        err instanceof PendingAbandonmentError ||
        err?.code === 'pending_abandonment_unconfirmed'
      ) {
        setReturningIdentifyError('Previous selfie upload cleanup is still completing. Please wait a moment and try again.');
      } else if (
        err instanceof UploadQuotaExceededError ||
        err?.code === 'too_many_pending_intents' ||
        err?.message?.toLowerCase().includes('too many upload attempts')
      ) {
        setReturningIdentifyError('Too many selfie attempts are pending. Please wait a moment or retake your selfie.');
      } else {
        setReturningIdentifyError(err?.message || 'Identification failed. Please retake your selfie or try again.');
      }
    } finally {
      setIsIdentifyingReturning(false);
      turnstileRef.current?.resetChallenge();
    }
  }

  function onReturningConfirmNext() {
    const vals = getValues();
    const phRes = normalizePhMobile(vals.contactNumber);
    if (!phRes) {
      toast.error('Please enter a valid Philippine mobile number.');
      return;
    }
    if (!selectedPsgc) {
      setAddressError('Please select your residential barangay and city.');
      toast.error('Please select your residential barangay and city.');
      return;
    }
    setAddressError(null);
    if (!vals.purpose || vals.purpose.trim().length < 3) {
      toast.error('Please describe the purpose of your visit.');
      return;
    }
    if (!vals.visitDate) {
      toast.error('Please select a visit date.');
      return;
    }
    if (vals.arrivalMode === 'vehicle') {
      const plateRes = normalizeVehiclePlate(vals.plateNumber || '');
      if (!plateRes.valid) {
        toast.error(plateRes.error || 'Please enter a valid plate number.');
        return;
      }
      setValue('plateNumber', plateRes.displayPlate);
      if (!vals.vehicleColor || vals.vehicleColor.trim().length < 2) {
        toast.error('Please enter vehicle color.');
        return;
      }
      if (!vehiclePhotoBlob) {
        toast.error('A current photo of your vehicle is required for this visit.');
        return;
      }
    } else {
      setValue('plateNumber', '');
      setValue('vehicleColor', '');
      setValue('makeModel', '');
      setVehiclePhotoBlob(null);
      vehiclePhotoUrl.clear();
    }

    if (returningProfile?.profileId && returningProfile?.matchToken && portalTransactionRef.current) {
      const currentGen = ++historicalIdRequestGeneration.current;
      setLoadingHistoricalId(true);
      fetchHistoricalIdPreview(portalTransactionRef.current, returningProfile.profileId, returningProfile.matchToken)
        .then((url) => {
          if (currentGen !== historicalIdRequestGeneration.current) {
            if (url) URL.revokeObjectURL(url);
            return;
          }
          historicalIdUrl.setUrl(url);
        })
        .catch(() => {
          if (currentGen === historicalIdRequestGeneration.current) {
            historicalIdUrl.clear();
          }
        })
        .finally(() => {
          if (currentGen === historicalIdRequestGeneration.current) {
            setLoadingHistoricalId(false);
          }
        });
    } else {
      historicalIdRequestGeneration.current++;
      historicalIdUrl.clear();
      setLoadingHistoricalId(false);
    }

    setStep('returning_review');
  }

  // ============================================================
  // OPTIONAL OCR EXTRACTION (In Memory)
  // ============================================================
  async function handleOcrFileSelected(e: React.ChangeEvent<HTMLInputElement>) {
    e.stopPropagation();
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

      void abandonPortalEvidence(portalTransactionRef.current, 'id');
      invalidatePortalEvidenceCheckpoint(portalTransactionRef.current, 'id');
      setIdBlob(normalized);
      idUrl.setFromBlob(normalized);
      setIdReusedFromOcr(true);
      setIdQualityError(null);

      // Invalidate existing verified state if ID changes
      setIdentityVerified(false);
      setVerificationError(null);

      // 2. Perform local OCR recognition in browser memory: recognizeIdImage(file)
      const { getNextOcrJobId } = await import('@/lib/ocr');
      const currentJobId = getNextOcrJobId();
      ocrJobIdRef.current = currentJobId;
      const parsed = await recognizeIdImage(file, undefined, currentJobId);
      if (generation !== ocrGenerationRef.current || ocrJobIdRef.current !== currentJobId) return;

      // 3. Prefill empty fields, preserving user-entered values - ONLY CONFIDENT FIELDS (>= 60)
      const currentValues = getValues();
      let filledCount = 0;
      let weakCount = 0;

      const CONFIDENCE_THRESHOLD = 60;
      const isFieldConfident = (fieldName: 'firstName' | 'middleName' | 'lastName'): boolean => {
        const candidate = parsed.fieldCandidates?.[fieldName];
        if (candidate) return candidate.confidence >= CONFIDENCE_THRESHOLD;
        return parsed.confidence >= CONFIDENCE_THRESHOLD;
      };

      if (!currentValues.firstName?.trim() && parsed.firstName) {
        if (isFieldConfident('firstName')) {
          setValue('firstName', parsed.firstName, { shouldValidate: true });
          filledCount++;
        } else {
          weakCount++;
        }
      }
      if (!currentValues.middleName?.trim() && parsed.middleName) {
        if (isFieldConfident('middleName')) {
          setValue('middleName', parsed.middleName, { shouldValidate: true });
          filledCount++;
        } else {
          weakCount++;
        }
      }
      if (!currentValues.lastName?.trim() && parsed.lastName) {
        if (isFieldConfident('lastName')) {
          setValue('lastName', parsed.lastName, { shouldValidate: true });
          filledCount++;
        } else {
          weakCount++;
        }
      }

      if (parsed.address) {
        const { parseAddressFromOcr } = await import('@/lib/addressOcr');
        const detected = parseAddressFromOcr(parsed.address);
        if (detected) {
          setDetectedOcrAddress(detected);
          setShowOcrAddressCard(true);
        }
      }

      if (filledCount > 0) {
        setOcrSuccessNotice('Information autofilled from your ID. ID image saved for verification.');
        toast.success('Information autofilled from your ID.');
      } else if (weakCount > 0) {
        setOcrSuccessNotice("We couldn't confidently read all name fields. Please review or enter the remaining fields manually.");
        toast.info("We couldn't confidently read all name fields. Please review or enter the remaining fields manually.");
      } else {
        setOcrSuccessNotice('ID image saved. Please check and enter your name details manually.');
        toast.info('ID image saved. You can enter or confirm your name details.');
      }
    } catch (err: any) {
      if (generation !== ocrGenerationRef.current) return;
      if (err?.message === 'ocr_job_superseded') return;
      console.warn('OCR processing failure:', err);
      toast.info('Automatic text recognition skipped. Your ID image was saved for later verification.');
    } finally {
      if (generation === ocrGenerationRef.current) {
        setIsProcessingOcr(false);
      }
    }
  }

  // ============================================================
  // STEP 3: LIVE FACE CAPTURE & QUALITY GATE
  // ============================================================
  function onCaptureLivePhoto() {
    const blob = faceWebcam.capture({ mirror: false });
    if (blob) {
      invalidatePortalEvidenceCheckpoint(portalTransactionRef.current, 'photo');
      setPhotoBlob(blob);
      photoUrl.setFromBlob(blob);
      setLiveFaceError(null);
      setIdentityVerified(false);
      livePhotoIntentIdRef.current = null;
      faceWebcam.stop();
    } else {
      toast.error('Failed to capture photo. Please hold steady and try again.');
    }
  }

  function onRetakeLivePhoto() {
    void abandonPortalEvidence(portalTransactionRef.current, 'photo');
    invalidatePortalEvidenceCheckpoint(portalTransactionRef.current, 'photo');
    photoUrl.clear();
    setPhotoBlob(null);
    setLiveFaceError(null);
    setIdentityVerified(false);
    livePhotoIntentIdRef.current = null;
    faceWebcam.stop();
    setStep('photo');
    void faceWebcam.start();
  }

  async function onConfirmLivePhoto() {
    if (!photoBlob) return;
    setIsEvaluatingFaceQuality(true);
    setLiveFaceError(null);

    try {
      // 1. Client-side technical checks first
      const evaluation = await evaluateLiveFaceQuality(photoBlob);
      if (!evaluation.passed) {
        setLiveFaceError({
          category: 'quality',
          title: 'Photo Quality Check Failed',
          message: evaluation.message,
          reasonCode: 'client_quality_failed',
        });
        toast.error(evaluation.message);
        return;
      }

      // 2. Verify authenticated portal transaction exists
      if (!portalTransactionRef.current) {
        setLiveFaceError({
          category: 'session',
          title: 'Registration Session Error',
          message: 'Your visitor registration session changed or expired. Please continue again to securely restart this registration.',
          reasonCode: 'portal_session_missing',
        });
        setStep('form');
        toast.error('Session expired. Please complete visitor details to continue.');
        return;
      }

      const tx = portalTransactionRef.current;
      if (!livePhotoIntentIdRef.current) {
        const photoRes = await uploadPortalEvidence(tx, 'photo', photoBlob);
        livePhotoIntentIdRef.current = photoRes.intentId;
      }

      // 3. Call trusted server face-presence/geometry preflight
      const preflight = await preflightPortalLiveFace(tx, livePhotoIntentIdRef.current);
      if (!preflight.ok) {
        void abandonPortalEvidence(portalTransactionRef.current, 'photo');
        livePhotoIntentIdRef.current = null;
        setLiveFaceError({
          category: 'quality',
          title: 'Photo Quality Check Failed',
          message: preflight.message || 'Face presence check failed. Please ensure your face is clearly visible.',
          reasonCode: preflight.reasonCode || 'preflight_failed',
        });
        toast.error(preflight.message || 'Face presence check failed.');
        return;
      }

      // Passed Live Face quality gate -> continue to Valid ID step
      setStep('id');
    } catch (err: any) {
      console.warn('Live face quality check error:', err);
      const msg = err?.message?.toLowerCase() || '';

      // 1. Session / token expiration
      if (
        err instanceof PortalSessionError ||
        err?.code?.startsWith?.('portal_session') ||
        msg.includes('session expired') ||
        msg.includes('session missing')
      ) {
        setLiveFaceError({
          category: 'session',
          title: 'Registration Session Error',
          message:
            'Your visitor registration session changed or expired. Please continue again to securely restart this registration.',
          reasonCode: err?.code || 'portal_session_mismatch',
        });
        const tx = portalTransactionRef.current;
        portalTransactionRef.current = null; setPortalToken(null);
        livePhotoIntentIdRef.current = null;
        if (tx) {
          invalidatePortalEvidenceCheckpoint(tx, 'photo');
          invalidatePortalEvidenceCheckpoint(tx, 'id');
        }
        setStep('form');
        toast.error('Registration session expired. Returning to visitor details.');
        return;
      }

      // 2. Storage upload errors (temporary network timeout or retryable storage failure)
      if (err instanceof StorageUploadError) {
        setLiveFaceError({
          category: err.retryable ? 'network' : 'upload',
          title: err.code === 'storage_timeout' ? 'Connection Problem' : 'Photo Upload Failed',
          message: err.message,
          reasonCode: err.code,
        });
        toast.error(err.message);
        return;
      }

      // 2b. Pending abandonment cleanup unconfirmed
      if (
        err instanceof PendingAbandonmentError ||
        err?.code === 'pending_abandonment_unconfirmed'
      ) {
        setLiveFaceError({
          category: 'upload',
          title: 'Cleanup In Progress',
          message:
            'Previous photo cleanup is still processing. Please wait a moment and try again.',
          reasonCode: 'pending_abandonment_unconfirmed',
        });
        toast.error('Previous photo cleanup is completing. Please retry in a moment.');
        return;
      }

      // 2c. Quota exceeded (pending intents limit reached)
      if (
        err instanceof UploadQuotaExceededError ||
        err?.code === 'too_many_pending_intents' ||
        msg.includes('too many pending') ||
        msg.includes('too many upload attempts')
      ) {
        setLiveFaceError({
          category: 'upload',
          title: 'Too Many Upload Attempts',
          message:
            'Too many pending photo attempts have accumulated. Please wait a moment or retake your selfie to continue.',
          reasonCode: 'too_many_pending_intents',
        });
        toast.error('Too many upload attempts in progress. Please wait a moment.');
        return;
      }

      // 3. Upload intent authorization failure (explicit policy / permission rejection)
      if (
        err instanceof UploadAuthorizationError ||
        err?.code === 'upload_intent_unauthorized' ||
        msg.includes('upload could not be authorized')
      ) {
        setLiveFaceError({
          category: 'upload',
          title: 'Photo Upload Authorization Failed',
          message:
            'The photo upload could not be authorized for this visitor session. Please restart the registration session and try again.',
          reasonCode: err?.code || 'upload_intent_unauthorized',
        });
        toast.error('Photo upload could not be authorized.');
        return;
      }

      // 4. Preflight quality error
      if (err instanceof PreflightQualityError) {
        void abandonPortalEvidence(portalTransactionRef.current, 'photo');
        livePhotoIntentIdRef.current = null;
        setLiveFaceError({
          category: 'quality',
          title: 'Photo Quality Check Failed',
          message: err.message,
          reasonCode: err.reasonCode,
        });
        toast.error(err.message);
        return;
      }

      // 5. Network / timeout interruptions
      if (
        msg.includes('network') ||
        msg.includes('fetch') ||
        msg.includes('timeout') ||
        msg.includes('failed to fetch')
      ) {
        setLiveFaceError({
          category: 'network',
          title: 'Connection Problem',
          message:
            'Network interruption occurred while communicating with the server. Please check your connection and try again.',
          reasonCode: 'network_interruption',
        });
        toast.error('Network connection problem.');
        return;
      }

      // 6. Service unavailable
      if (msg.includes('service') || msg.includes('unavailable') || msg.includes('503')) {
        setLiveFaceError({
          category: 'service',
          title: 'Service Unavailable',
          message: 'The verification service is temporarily unavailable. Please try again shortly.',
          reasonCode: 'service_unavailable',
        });
        toast.error('Verification service unavailable.');
        return;
      }

      // 7. General fallback (Technical/Quality)
      setLiveFaceError({
        category: 'quality',
        title: 'Photo Quality Check Failed',
        message: err?.message || 'Could not verify photo quality. Please retake under good lighting.',
        reasonCode: 'quality_error',
      });
    } finally {
      setIsEvaluatingFaceQuality(false);
    }
  }

  // ============================================================
  // STEP 4: VALID ID & QUALITY GATE
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

      void abandonPortalEvidence(portalTransactionRef.current, 'id');
      invalidatePortalEvidenceCheckpoint(portalTransactionRef.current, 'id');
      setIdBlob(normalized);
      idUrl.setFromBlob(normalized);
      setIdReusedFromOcr(false);
      setIdentityVerified(false);
      setVerificationError(null);
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
  // STEP 5: IDENTITY VERIFICATION PIPELINE
  // ============================================================
  async function runIdentityVerification() {
    if (!photoBlob || !idBlob) {
      setStep('photo');
      return;
    }

    setIsVerifyingIdentity(true);
    setVerificationError(null);

    try {
      if (!portalTransactionRef.current) {
        setStep('form');
        toast.error('Session expired. Please complete visitor details to continue.');
        return;
      }

      const tx = portalTransactionRef.current;

      const photoIntentId = livePhotoIntentIdRef.current
        ? livePhotoIntentIdRef.current
        : (await uploadPortalEvidence(tx, 'photo', photoBlob)).intentId;

      const idRes = await uploadPortalEvidence(tx, 'id', idBlob);

      const result = await verifyPortalIdentity(tx, photoIntentId, idRes.intentId);

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
      const msg = err?.message?.toLowerCase() || '';
      if (err instanceof PortalSessionError || err?.code?.startsWith?.('portal_session') || msg.includes('session')) {
        const tx = portalTransactionRef.current;
        portalTransactionRef.current = null; setPortalToken(null);
        livePhotoIntentIdRef.current = null;
        if (tx) {
          invalidatePortalEvidenceCheckpoint(tx, 'photo');
          invalidatePortalEvidenceCheckpoint(tx, 'id');
        }
        setStep('form');
        toast.error('Registration session expired. Returning to visitor details.');
        return;
      }
      setVerificationError(
        err?.message || 'We could not complete identity verification. Please ensure steady lighting and clear images.'
      );
    } finally {
      setIsVerifyingIdentity(false);
    }
  }

  function handleStartOver() {
    resetRegistrationFlow();
  }

  function handleAmbiguousCancelAndAskGuard() {
    if (portalTransactionRef.current) {
      portalTransactionRef.current.phase = 'submission_uncertain_hold';
    }
    setTransactionPhase('submission_uncertain_hold');
    toast.info('Submission placed on hold. The previous pass may have been created. Please proceed to the Guard Station with your valid ID for assistance.');
    setStep(registrationMode === 'returning' ? 'returning_review' : 'review');
  }

  function handleRetryExactSubmission() {
    void onSubmit();
  }

  // ============================================================
  // STEP 6: PASS ISSUANCE (onSubmit)
  // ============================================================
  async function onSubmit() {
    if (portalTransactionRef.current?.phase === 'submission_uncertain_hold') {
      toast.error('This submission is held for guard verification. Please start over to register a new pass.');
      return;
    }

    if (portalTransactionRef.current?.phase === 'existing_pass_conflict') {
      toast.error('An existing pass was already created for this request. Please ask the Guard for assistance.');
      return;
    }

    if (!identityVerified) {
      toast.error('Identity verification is required before generating a pass.');
      setStep('verify');
      return;
    }

    if (!photoBlob) {
      toast.error('Live photo is required.');
      return;
    }

    setStep('generating');
    setSubmitError(null);

    try {
      const rawFormData = getValues();
      if (!portalTransactionRef.current) {
        setStep('form');
        toast.error('Session expired. Please complete visitor details to continue.');
        return;
      }

      const phNormalized = normalizePhMobile(rawFormData.contactNumber) || rawFormData.contactNumber;
      const plateResult = rawFormData.arrivalMode === 'vehicle' && rawFormData.plateNumber
        ? normalizeVehiclePlate(rawFormData.plateNumber)
        : null;

      const loc = homeLocation || rawFormData.homeLocation;

      const formData: any = {
        ...rawFormData,
        contactNumber: phNormalized,
        arrivalMode: rawFormData.arrivalMode,
        homeLocation: loc || undefined,
        psgc: selectedPsgc ? {
          version: selectedPsgc.version || '2026-q3',
          regionCode: selectedPsgc.region.code,
          provinceCode: selectedPsgc.province?.code || null,
          cityCode: selectedPsgc.city.code,
          barangayCode: selectedPsgc.barangay.code,
          houseBuilding: homeBuilding.trim() || undefined,
          street: homeStreet.trim() || undefined,
        } : undefined,
        homeAddress: selectedPsgc ? formatStructuredAddress({
          regionName: selectedPsgc.region.name,
          provinceName: selectedPsgc.province?.name,
          cityName: selectedPsgc.city.name,
          barangayName: selectedPsgc.barangay.name,
          houseBuilding: homeBuilding,
          street: homeStreet,
        }) : undefined,
        vehicle: rawFormData.arrivalMode === 'vehicle'
          ? {
              vehicleType: rawFormData.vehicleType || 'car',
              plateNumber: plateResult?.displayPlate || rawFormData.plateNumber || '',
              color: rawFormData.vehicleColor || '',
              makeModel: rawFormData.makeModel || null,
              catalogStatus: vehicleCatalogMode === 'catalog' ? 'catalog' : 'manual',
              saveVehicle,
            }
          : undefined,
        returning: registrationMode === 'returning' && returningProfile
          ? {
              profileId: returningProfile.profileId,
              matchToken: returningProfile.matchToken,
              saveUpdates: saveReturningUpdates,
            }
          : undefined,
        rememberVisitor: false,
        officeId: selectedOfficeId || undefined,
      };

      async function presentIssuedPass(issued: {
        passId: string;
        publicReference?: string | null;
        qrToken: string;
        validFrom?: string;
        validUntil?: string;
        returningEnrollment?: string;
        returningProfileUpdate?: string;
        savedVehicleStatus?: string;
        officeVisitLinkStatus?: string;
      }, overridePurpose?: string) {
        if (issued.returningEnrollment === 'enrolled') {
          toast.success('Your returning visitor profile was securely enrolled for future visits.');
        } else if (issued.returningEnrollment === 'failed') {
          toast.warning('Pass created successfully, but your returning visitor profile could not be enrolled. You may enroll on your next visit.');
        }

        if (issued.returningProfileUpdate === 'updated') {
          toast.success("Your saved returning profile was updated with today's contact details.");
        } else if (issued.returningProfileUpdate === 'failed') {
          toast.warning("Pass created successfully, but your saved profile could not be updated. Your pass is valid for today's visit.");
        }

        if (issued.savedVehicleStatus === 'saved') {
          toast.success('Vehicle details saved for future visits.');
        } else if (issued.savedVehicleStatus === 'failed') {
          toast.warning("Pass created successfully, but your vehicle details could not be saved for future visits. Your pass is valid for today's visit.");
        }

        if (issued.officeVisitLinkStatus === 'reconciliation_required') {
          toast.info('Pass created successfully. Office visit linkage is pending reconciliation with the office.');
        }

        setPassId(issued.passId);
        setRawQrToken(issued.qrToken);
        const validity = issued.validFrom && issued.validUntil
          ? formatValidityWindow(issued.validFrom, issued.validUntil)
          : formatWorkingHours(workingHours);

        let qrUrl: string | null = null;
        try {
          qrUrl = await generateBrandedQrDataUrl(issued.qrToken, { size: 360 });
        } catch (qrErr) {
          console.warn('Branded QR generation failed, falling back to standard QR:', qrErr);
          try {
            qrUrl = await QRCode.toDataURL(issued.qrToken, { width: 360, margin: 2, errorCorrectionLevel: 'H' });
          } catch (fallbackErr) {
            console.error('Standard QR generation fallback failed:', fallbackErr);
          }
        }

        const effectiveVisitor = portalTransactionRef.current?.submittedPayload?.visitor ?? formData;
        const presentation = createPassPresentation({
          firstName: effectiveVisitor.firstName,
          middleName: effectiveVisitor.middleName,
          lastName: effectiveVisitor.lastName,
          visitDate: effectiveVisitor.visitDate,
          passReference: issued.publicReference || issued.passId,
          qrToken: issued.qrToken,
          validityWindow: validity,
          purpose: overridePurpose || effectiveVisitor.purpose,
          plateNumber: effectiveVisitor.arrivalMode === 'vehicle' && effectiveVisitor.vehicle?.plateNumber
            ? effectiveVisitor.vehicle.plateNumber
            : null,
        });
        setPassPresentation(presentation);

        if (!qrUrl) {
          setQrRenderingError(true);
          toast.error('Pass record registered, but visual QR rendering failed. Please click "Retry QR Code Rendering".');
          return;
        }

        setQrRenderingError(false);
        setQrDataUrl(qrUrl);

        setEmailDeliverySecured(false);
        setIsDownloaded(false);

        setStep('delivery');
        setShowEmailModal(true);
        toast.success('Gate pass generated successfully!');
      }

      const targetOffice = offices.find((o) => o.id === selectedOfficeId);

      if (visitType === 'specific_person') {
        const token = portalTransactionRef.current.token;
        const targetPersonnel = personnelList.find((p) => p.id === selectedPersonnelId);
        const effectivePersonnelName = requestedPersonName.trim() || targetPersonnel?.name || 'Designated Personnel';
        const effectiveSpecificPurpose = specificPurpose || rawFormData.purpose;

        const requestPayload = {
          requestId: portalTransactionRef.current.requestId ?? issueRequestId.current,
          source: 'portal',
          registrationMode,
          visitor: {
            firstName: rawFormData.firstName,
            middleName: rawFormData.middleName || undefined,
            lastName: rawFormData.lastName,
            contactNumber: phNormalized,
            email: visitorEmail.toLowerCase().trim(),
            purpose: effectiveSpecificPurpose,
            visitDate: rawFormData.visitDate || getManilaDateString(new Date()),
          },
          officeId: selectedOfficeId,
          personnelId: selectedPersonnelId || undefined,
          requestedPersonName: effectivePersonnelName,
          specificPurpose: effectiveSpecificPurpose,
          emailVerificationToken,
          arrivalMode: rawFormData.arrivalMode,
          photoIntentId: portalTransactionRef.current.photoIntentId,
          idIntentId: portalTransactionRef.current.idIntentId,
          vehiclePhotoIntentId: portalTransactionRef.current.vehiclePhotoIntentId,
          vehicle: formData.vehicle,
          psgc: formData.psgc,
          homeLocation: formData.homeLocation,
          returning: formData.returning,
        };

        const res = await fetch('/api/request-office-visit', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestPayload),
        });

        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.message || data.error || 'Failed to submit visit request.');
        }

        if (data.approvalRequired === false && data.passId && data.qrToken) {
          await presentIssuedPass(data, effectiveSpecificPurpose);
          return;
        }

        setSubmittedRequestData({
          officeName: targetOffice?.name || 'Designated Office',
          personnelName: effectivePersonnelName,
          visitDate: rawFormData.visitDate || getManilaDateString(new Date()),
          visitorEmail: visitorEmail.toLowerCase().trim(),
          trackingUrl: data.trackingUrl || undefined,
          trackingToken: data.trackingToken || undefined,
          emailDeliveryStatus: data.emailDelivery?.status || 'pending',
        });
        setStep('request_submitted');
        return;
      }

      if (emailVerificationToken && visitorEmail.trim()) {
        formData.email = visitorEmail.toLowerCase().trim();
        formData.emailVerificationToken = emailVerificationToken;
      }

      const result = await issueVisitorPass('portal', formData, photoBlob, idBlob, issueRequestId.current, undefined, portalTransactionRef.current, vehiclePhotoBlob);

      if (result.approvalRequired) {
        setSubmittedRequestData({
          officeName: targetOffice?.name || result.officeName || 'Designated Office',
          personnelName: 'General Office Reception',
          visitDate: rawFormData.visitDate || getManilaDateString(new Date()),
          visitorEmail: emailVerificationToken && visitorEmail.trim() ? visitorEmail.toLowerCase().trim() : 'Online tracking link',
          trackingUrl: result.trackingUrl || undefined,
          trackingToken: result.trackingToken || undefined,
          emailDeliveryStatus: (result as any).emailDelivery?.status || 'pending',
        });
        setStep('request_submitted');
        toast.success(result.message || 'Visit request submitted for office approval!');
        return;
      }

      await presentIssuedPass(result);
    } catch (err) {
      console.error('Pass generation error:', err);
      const errMsg = err instanceof Error ? err.message : 'An unexpected error occurred.';
      setSubmitError(errMsg);
      setTransactionPhase(portalTransactionRef.current?.phase ?? null);
      setStep(registrationMode === 'returning' ? 'returning_review' : 'review');
      toast.error('Failed to generate pass. Please try again.');
    } finally {
      // Submission finalized
    }
  }

  // ============================================================
  // DOWNLOAD QR PASS
  // ============================================================
  async function handleDownload() {
    if (!passPresentation) {
      toast.error('Your E-GatePass image could not be prepared. Please try again.');
      return;
    }
    try {
      const { renderPassCardToDataUrl } = await import('@/lib/passPresentation');
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

  const NEW_VISITOR_STEPPER_STEPS = ['form', 'visit', 'photo', 'id', 'verify', 'review'] as const;
  const isNewVisitorStepper = registrationMode === 'new' && (NEW_VISITOR_STEPPER_STEPS as readonly string[]).includes(step);

  const steps = [
    { id: 'form', title: 'Personal' },
    { id: 'visit', title: 'Visit' },
    { id: 'photo', title: 'Live Face' },
    { id: 'id', title: 'Valid ID' },
    { id: 'verify', title: 'Verify' },
    { id: 'review', title: 'Review' },
  ];

  const currentStepIndex =
    step === 'done' || step === 'delivery' || step === 'generating' || step === 'request_submitted'
      ? steps.length
      : steps.findIndex((s) => s.id === step);

  const currentStepTitle =
    currentStepIndex >= 0 && currentStepIndex < steps.length
      ? steps[currentStepIndex]?.title ?? 'Pass Details'
      : 'Pass Details';

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
          {/* Stepper only for 6-step New Visitor */}
          {isNewVisitorStepper && (
            <div className="mb-8">
              <div className="mb-3 flex items-center justify-between">
                <span className="inline-block rounded-full bg-[#F8EEEE] px-3 py-1 text-xs font-bold text-[#7A0A0A]">
                  {currentStepTitle} • Step {currentStepIndex + 1} of 6
                </span>
                <button
                  type="button"
                  onClick={handleStartOver}
                  className="text-xs font-semibold text-[var(--color-text-secondary)] hover:text-[#7A0A0A] hover:underline inline-flex items-center gap-1"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  Start Over
                </button>
              </div>
              <Stepper steps={steps} currentStepIndex={currentStepIndex} className="px-2" />
            </div>
          )}

          {/* ============================== SETUP SCREEN 1: VISITOR TYPE ============================== */}
          {step === 'frontdoor' && (
            <div className="space-y-6">
              <div className="text-center">
                <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-[#F8EEEE] text-[#7A0A0A] text-xs font-semibold mb-2">
                  <span>Setup Step 1 of 2</span>
                </div>
                <h2 className="text-xl font-bold text-[var(--color-text-primary)]">
                  EARIST Visitor Pass Registration
                </h2>
                <p className="text-sm text-[var(--color-text-secondary)] mt-1.5">
                  Select your visitor status to begin your campus access pass registration.
                </p>
              </div>

              <div className="grid gap-4 sm:grid-cols-2 pt-2">
                {/* Option 1: New Visitor */}
                <div
                  onClick={() => {
                    beginNewVisitorSetup();
                  }}
                  role="button"
                  tabIndex={0}
                  className="relative flex flex-col justify-between rounded-2xl border-2 border-[var(--color-border)] hover:border-[#7A0A0A] p-6 bg-white transition-all cursor-pointer shadow-xs hover:shadow-md active:scale-[0.98] motion-reduce:transform-none"
                >
                  <div className="space-y-3">
                    <div className="h-12 w-12 rounded-xl bg-[#F8EEEE] text-[#7A0A0A] flex items-center justify-center">
                      <User className="h-6 w-6" />
                    </div>
                    <div>
                      <h3 className="font-bold text-base text-[var(--color-text-primary)]">New Visitor</h3>
                      <p className="text-xs text-[var(--color-text-secondary)] mt-1 leading-relaxed">
                        First time visiting EARIST or infrequent visitor. Complete 6-step online registration with valid ID.
                      </p>
                    </div>
                  </div>
                  <div className="mt-5 pt-3 border-t border-[var(--color-border)] flex items-center justify-between text-xs font-bold text-[#7A0A0A]">
                    <span>Register as New Visitor</span>
                    <ArrowRight className="h-4 w-4" />
                  </div>
                </div>

                {/* Option 2: Returning Visitor */}
                <div
                  onClick={() => {
                    if (returningAvailable === false) {
                      setShowReturningGateModal(true);
                      return;
                    }
                    setRegistrationMode('returning');
                    setReturningSearchError(null);
                    setReturningCandidates([]);
                    setSelectedReturningCandidate(null);
                    setStep('returning_lookup');
                  }}
                  role="button"
                  tabIndex={0}
                  className={`relative flex flex-col justify-between rounded-2xl border-2 p-6 transition-all cursor-pointer shadow-xs hover:shadow-md active:scale-[0.98] motion-reduce:transform-none ${
                    returningAvailable === false
                      ? 'border-slate-200 bg-slate-50/70 hover:border-slate-300'
                      : 'border-[var(--color-border)] bg-white hover:border-[#7A0A0A]'
                  }`}
                >
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <div className="h-12 w-12 rounded-xl bg-slate-100 text-slate-700 flex items-center justify-center">
                        <UserCheck className="h-6 w-6" />
                      </div>
                      {returningAvailable === false && (
                        <span className="rounded-full bg-amber-50 text-amber-900 border border-amber-300 px-2.5 py-0.5 text-[10px] font-bold">
                          Setup Pending
                        </span>
                      )}
                    </div>
                    <div>
                      <h3 className="font-bold text-base text-[var(--color-text-primary)]">Returning Visitor</h3>
                      <p className="text-xs text-[var(--color-text-secondary)] mt-1 leading-relaxed">
                        Fast check-in for visitors with a previously registered record.
                      </p>
                      {returningAvailable === false ? (
                        <p className="text-[11px] text-amber-900/80 mt-2 font-medium leading-relaxed">
                          Returning visitor 1:1 facial verification is not yet operational pending configuration. Please proceed as a New Visitor.
                        </p>
                      ) : null}
                    </div>
                  </div>
                  <div className="mt-5 pt-3 border-t border-[var(--color-border)] flex items-center justify-between text-xs font-bold text-slate-700">
                    <span>{returningAvailable === false ? 'Check Availability' : 'Check In Returning'}</span>
                    <ArrowRight className="h-4 w-4" />
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* ============================== SETUP SCREEN 2: ARRIVAL METHOD ============================== */}
          {step === 'arrival_setup' && (
            <div className="space-y-6">
              <div className="text-center">
                <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-[#F8EEEE] text-[#7A0A0A] text-xs font-semibold mb-2">
                  <span>Setup Step 2 of 2</span>
                </div>
                <h2 className="text-xl font-bold text-[var(--color-text-primary)]">
                  Arrival Method
                </h2>
                <p className="text-sm text-[var(--color-text-secondary)] mt-1.5">
                  How will you be arriving at the EARIST campus for this visit?
                </p>
              </div>

              <fieldset className="border-0 p-0 m-0">
                <legend className="sr-only">Arrival Method</legend>
                <div
                  role="radiogroup"
                  aria-label="Arrival Method"
                  className="grid gap-4 sm:grid-cols-2 pt-2"
                >
                  {/* Option 1: On Foot / Commute / No Vehicle */}
                  <div
                    role="radio"
                    aria-checked={setupArrivalMode === 'no_vehicle'}
                    tabIndex={setupArrivalMode === 'no_vehicle' || setupArrivalMode === null ? 0 : -1}
                    onClick={() => {
                      setSetupArrivalMode('no_vehicle');
                      setValue('arrivalMode', 'no_vehicle');
                      clearVehicleDeclarationState();
                    }}
                    onKeyDown={(e) => {
                      if (e.key === ' ' || e.key === 'Enter') {
                        e.preventDefault();
                        setSetupArrivalMode('no_vehicle');
                        setValue('arrivalMode', 'no_vehicle');
                        clearVehicleDeclarationState();
                      } else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
                        e.preventDefault();
                        setSetupArrivalMode('vehicle');
                        setValue('arrivalMode', 'vehicle');
                      }
                    }}
                    className={`relative flex flex-col justify-between rounded-2xl border-2 p-6 transition-all cursor-pointer shadow-xs active:scale-[0.98] motion-reduce:transform-none focus:outline-none focus-visible:ring-2 focus-visible:ring-[#7A0A0A] focus-visible:ring-offset-2 ${
                      setupArrivalMode === 'no_vehicle'
                        ? 'border-[#7A0A0A] bg-[#F8EEEE]/50 ring-2 ring-[#7A0A0A]/20'
                        : 'border-[var(--color-border)] bg-white hover:border-[#7A0A0A]/40'
                    }`}
                  >
                    <div className="space-y-3">
                      <div className="flex items-center justify-between">
                        <div
                          className={`h-12 w-12 rounded-xl flex items-center justify-center ${
                            setupArrivalMode === 'no_vehicle'
                              ? 'bg-[#7A0A0A] text-white'
                              : 'bg-[#F8EEEE] text-[#7A0A0A]'
                          }`}
                        >
                          <User className="h-6 w-6" />
                        </div>
                        {setupArrivalMode === 'no_vehicle' && (
                          <span className="rounded-full bg-[#7A0A0A] text-white p-1">
                            <CheckCircle2 className="h-4 w-4" />
                          </span>
                        )}
                      </div>
                      <div>
                        <h3 className="font-bold text-base text-[var(--color-text-primary)]">
                          On Foot / Commute / No Vehicle
                        </h3>
                        <p className="text-xs text-[var(--color-text-secondary)] mt-1 leading-relaxed">
                          Arriving as a pedestrian, using public transit, or dropped off outside campus gates.
                        </p>
                      </div>
                    </div>
                  </div>

                  {/* Option 2: Bringing a Vehicle */}
                  <div
                    role="radio"
                    aria-checked={setupArrivalMode === 'vehicle'}
                    tabIndex={setupArrivalMode === 'vehicle' ? 0 : -1}
                    onClick={() => {
                      setSetupArrivalMode('vehicle');
                      setValue('arrivalMode', 'vehicle');
                    }}
                    onKeyDown={(e) => {
                      if (e.key === ' ' || e.key === 'Enter') {
                        e.preventDefault();
                        setSetupArrivalMode('vehicle');
                        setValue('arrivalMode', 'vehicle');
                      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
                        e.preventDefault();
                        setSetupArrivalMode('no_vehicle');
                        setValue('arrivalMode', 'no_vehicle');
                        clearVehicleDeclarationState();
                      }
                    }}
                    className={`relative flex flex-col justify-between rounded-2xl border-2 p-6 transition-all cursor-pointer shadow-xs active:scale-[0.98] motion-reduce:transform-none focus:outline-none focus-visible:ring-2 focus-visible:ring-[#7A0A0A] focus-visible:ring-offset-2 ${
                      setupArrivalMode === 'vehicle'
                        ? 'border-[#7A0A0A] bg-[#F8EEEE]/50 ring-2 ring-[#7A0A0A]/20'
                        : 'border-[var(--color-border)] bg-white hover:border-[#7A0A0A]/40'
                    }`}
                  >
                    <div className="space-y-3">
                      <div className="flex items-center justify-between">
                        <div
                          className={`h-12 w-12 rounded-xl flex items-center justify-center ${
                            setupArrivalMode === 'vehicle'
                              ? 'bg-[#7A0A0A] text-white'
                              : 'bg-[#F8EEEE] text-[#7A0A0A]'
                          }`}
                        >
                          <Car className="h-6 w-6" />
                        </div>
                        {setupArrivalMode === 'vehicle' && (
                          <span className="rounded-full bg-[#7A0A0A] text-white p-1">
                            <CheckCircle2 className="h-4 w-4" />
                          </span>
                        )}
                      </div>
                      <div>
                        <h3 className="font-bold text-base text-[var(--color-text-primary)]">
                          Bringing a Vehicle
                        </h3>
                        <p className="text-xs text-[var(--color-text-secondary)] mt-1 leading-relaxed">
                          Driving a motorcycle, car, van, SUV, pickup, or truck into campus. Requires plate declaration and vehicle photo.
                        </p>
                      </div>
                    </div>
                  </div>
                </div>
              </fieldset>

              <div className="flex gap-3 pt-3 border-t border-[var(--color-border)]">
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => setStep('frontdoor')}
                  className="flex-1"
                  icon={<ArrowLeft className="h-4 w-4" />}
                >
                  Back to Visitor Type
                </Button>
                <Button
                  type="button"
                  disabled={setupArrivalMode === null}
                  onClick={() => {
                    if (!setupArrivalMode) return;
                    setValue('arrivalMode', setupArrivalMode);
                    if (setupArrivalMode === 'no_vehicle') {
                      clearVehicleDeclarationState();
                    }
                    setStep('form');
                  }}
                  className="flex-1"
                  icon={<ArrowRight className="h-4 w-4" />}
                >
                  Continue to Personal Details
                </Button>
              </div>
            </div>
          )}

          {/* ============================== STEP 1: PERSONAL DETAILS ============================== */}
          {step === 'form' && (
            <form onSubmit={handleSubmit(onFormNext)} className="space-y-6">
              <div className="text-center">
                <h2 className="text-lg font-bold text-[var(--color-text-primary)]">Personal Details</h2>
                <p className="text-sm text-[var(--color-text-secondary)] mt-1">
                  Enter your legal personal details or upload your ID image to autofill name fields.
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
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => {
                      e.stopPropagation();
                      void handleOcrFileSelected(e);
                    }}
                    className="hidden"
                  />

                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    disabled={isProcessingOcr}
                    loading={isProcessingOcr}
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      ocrFileInputRef.current?.click();
                    }}
                    icon={<Upload className="h-3.5 w-3.5" />}
                  >
                    Upload ID Image
                  </Button>
                </div>

                {ocrSuccessNotice && (
                  <div className="mt-3 flex items-center gap-2 rounded-lg bg-emerald-50 border border-emerald-200 p-2.5 text-xs text-emerald-800">
                    <CheckCircle2 className="h-4 w-4 flex-shrink-0 text-emerald-600" />
                    <span>{ocrSuccessNotice}</span>
                  </div>
                )}
              </div>

              {/* Personal Details Fields */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <FormField label="First Name" requirement="required" error={errors.firstName?.message}>
                  <Input id="first-name" placeholder="e.g. Juan" {...register('firstName')} />
                </FormField>
                <FormField label="Middle Name" requirement="optional" error={errors.middleName?.message}>
                  <Input id="middle-name" placeholder="e.g. Santos" {...register('middleName')} />
                </FormField>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <FormField label="Last Name" requirement="required" error={errors.lastName?.message}>
                  <Input id="last-name" placeholder="e.g. Dela Cruz" {...register('lastName')} />
                </FormField>
                <FormField
                  label="Philippine Mobile Number"
                  requirement="required"
                  error={errors.contactNumber?.message}
                  hint="Format: 09XXXXXXXXX or +639XXXXXXXXX"
                >
                  <Input
                    id="contact-number"
                    type="tel"
                    inputMode="tel"
                    placeholder="09171234567"
                    {...register('contactNumber')}
                  />
                </FormField>
              </div>

              {/* Optional Address Detected from ID Suggestion Card */}
              {showOcrAddressCard && detectedOcrAddress && (
                <div className="rounded-xl border border-emerald-300 bg-emerald-50/80 p-4 space-y-3">
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-2">
                      <Sparkles className="h-4 w-4 text-emerald-700 shrink-0" />
                      <h4 className="text-xs font-bold uppercase tracking-wider text-emerald-950">
                        Address Detected from ID
                      </h4>
                    </div>
                    <button
                      type="button"
                      onClick={() => setShowOcrAddressCard(false)}
                      className="text-xs font-semibold text-emerald-700 hover:text-emerald-900"
                    >
                      Dismiss
                    </button>
                  </div>
                  <p className="text-xs text-emerald-900 font-medium">
                    "{detectedOcrAddress.raw}"
                  </p>
                  <div className="flex items-center gap-2 pt-1">
                    <Button
                      type="button"
                      size="sm"
                      variant="primary"
                      onClick={() => {
                        if (detectedOcrAddress.street) setHomeStreet(detectedOcrAddress.street);
                        if (detectedOcrAddress.houseBuilding) setHomeBuilding(detectedOcrAddress.houseBuilding);
                        toast.success('Detected address applied to form!');
                        setShowOcrAddressCard(false);
                      }}
                    >
                      Use Detected Address
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      onClick={() => setShowOcrAddressCard(false)}
                    >
                      Keep Current Address
                    </Button>
                  </div>
                </div>
              )}

              {/* Structured Residential Address */}
              <StructuredAddressField
                value={selectedPsgc}
                onChange={(val) => {
                  setSelectedPsgc(val);
                  setAddressError(null);
                }}
                houseBuilding={homeBuilding}
                onHouseBuildingChange={setHomeBuilding}
                street={homeStreet}
                onStreetChange={setHomeStreet}
                error={addressError || undefined}
              />

              {/* Consolidated Data Privacy & Consent Card */}
              <div className="rounded-xl border border-[var(--color-border)] p-4 bg-[var(--color-surface)] space-y-3 shadow-xs">
                <label className="flex items-start gap-3 cursor-pointer select-none">
                  <input
                    id="consent"
                    type="checkbox"
                    {...register('consent')}
                    className="mt-1 h-4 w-4 text-[var(--color-brand)] rounded shrink-0 cursor-pointer"
                  />
                  <span className="text-xs text-[var(--color-text-secondary)] leading-relaxed">
                    I consent to the collection and processing of my personal information, face photo, and valid ID pursuant to the <strong>Data Privacy Act of 2012</strong> for the purpose of campus security and visitor management.
                  </span>
                </label>

                <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-[var(--color-border)] text-xs text-[var(--color-text-secondary)]">
                  <span>By proceeding, you acknowledge our campus visitor privacy guidelines.</span>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setShowPrivacyModal(true);
                    }}
                    className="font-bold text-[#7A0A0A] hover:underline inline-flex items-center gap-1.5 shrink-0 focus:outline-none focus:ring-1 focus:ring-[#7A0A0A] rounded px-1 py-0.5"
                  >
                    <ShieldCheck className="h-4 w-4 text-[#7A0A0A]" />
                    Read our Data Privacy Notice
                  </button>
                </div>

                {errors.consent && (
                  <p className="text-xs text-[var(--color-danger-dark)] font-medium">{errors.consent.message}</p>
                )}
              </div>

              <div className="flex items-center justify-between pt-2">
                <button
                  type="button"
                  onClick={() => setStep('arrival_setup')}
                  className="text-xs font-semibold text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:underline inline-flex items-center gap-1"
                >
                  <ArrowLeft className="h-3.5 w-3.5" />
                  Back to Arrival Method
                </button>
                <Button
                  type="submit"
                  className="min-w-[160px]"
                  loading={isCheckingReturningCandidate}
                  disabled={isCheckingReturningCandidate}
                  icon={<ArrowRight className="h-4 w-4" />}
                >
                  {isCheckingReturningCandidate ? 'Checking...' : 'Next: Visit Details'}
                </Button>
              </div>
            </form>
          )}

          {/* ============================== STEP 2: VISIT & VEHICLE ============================== */}
          {step === 'visit' && (
            <div className="space-y-6">
              <div className="text-center">
                <h2 className="text-lg font-bold text-[var(--color-text-primary)]">Visit & Vehicle Details</h2>
                <p className="text-sm text-[var(--color-text-secondary)] mt-1">
                  Specify your visit purpose, schedule, and verify your arrival declaration.
                </p>
              </div>

              {/* Selected Arrival Method Status Banner */}
              <div className="flex items-center justify-between rounded-xl bg-[#F8EEEE] border border-[#7A0A0A]/20 p-3 text-xs text-[#7A0A0A]">
                <div className="flex items-center gap-2">
                  {arrivalMode === 'vehicle' ? <Car className="h-4 w-4" /> : <User className="h-4 w-4" />}
                  <span className="font-semibold">
                    Arrival Method: {arrivalMode === 'vehicle' ? 'Bringing a Vehicle' : 'On Foot / Commute / No Vehicle'}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => setStep('arrival_setup')}
                  className="font-bold underline hover:opacity-80"
                >
                  Change
                </button>
              </div>

              {/* Destination Office & Visit Type Section */}
              <div className="rounded-2xl border border-[var(--color-border)] bg-white p-4 sm:p-5 space-y-5">
                <div>
                  <label htmlFor="destination-office-select" className="block text-xs font-bold uppercase tracking-wider text-[var(--color-text-primary)] mb-1">
                    Destination University Office <span className="text-[var(--color-danger)]">*</span>
                  </label>
                  <div className="relative">
                    <Building2 className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-text-muted)]" />
                    <select
                      id="destination-office-select"
                      value={selectedOfficeId}
                      onChange={(e) => setSelectedOfficeId(e.target.value)}
                      className="w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] py-2.5 pl-9 pr-8 text-sm font-semibold text-[var(--color-text-primary)] focus:border-[#7A0A0A] focus:outline-none focus:ring-1 focus:ring-[#7A0A0A]"
                    >
                      <option value="">Select destination office</option>
                      {offices.map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  {selectedOfficeId && (
                    <p className="mt-1 text-xs text-[var(--color-text-secondary)]">
                      {offices.find((o) => o.id === selectedOfficeId)?.description}
                    </p>
                  )}
                  {selectedOfficeId && officeSchedules.length > 0 && (
                    <div className="mt-2 rounded-xl border border-amber-200 bg-amber-50/70 p-3 text-xs text-amber-900 space-y-1">
                      <div className="font-bold flex items-center gap-1.5">
                        <AlertTriangle className="h-3.5 w-3.5 text-amber-700" />
                        <span>Office Schedule Notice</span>
                      </div>
                      <p className="text-[11px] leading-relaxed">
                        This office has custom schedule dates this month:
                      </p>
                      <ul className="list-disc pl-4 text-[11px] space-y-0.5">
                        {officeSchedules.map((s) => (
                          <li key={s.id || s.schedule_date}>
                            <strong>{s.schedule_date}</strong>: <span className="capitalize font-semibold">{s.status}</span>{s.reason ? ` — ${s.reason}` : ''}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>

                {/* Visit Type Cards — Mandatory Selection */}
                <div>
                  <span className="block text-xs font-bold uppercase tracking-wider text-[var(--color-text-primary)] mb-2">
                    Who or what are you visiting? <span className="text-[var(--color-danger)]">*</span>
                  </span>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {/* Specific Person Option */}
                    <button
                      type="button"
                      onClick={() => setVisitType('specific_person')}
                      className={`flex flex-col text-left p-4 rounded-xl border-2 transition-all ${
                        visitType === 'specific_person'
                          ? 'border-[#7A0A0A] bg-[#F8EEEE]/50 shadow-xs'
                          : 'border-[var(--color-border)] bg-white hover:border-[#7A0A0A]/40'
                      }`}
                    >
                      <div className="flex items-center justify-between mb-2">
                        <div className={`p-2 rounded-lg ${visitType === 'specific_person' ? 'bg-[#7A0A0A] text-white' : 'bg-gray-100 text-gray-700'}`}>
                          <UserCheck className="h-5 w-5" />
                        </div>
                        <span className="text-[10px] font-bold uppercase tracking-wider rounded-md bg-[#F8EEEE] text-[#7A0A0A] border border-[#7A0A0A]/30 px-2 py-0.5">
                          Office Approval Required
                        </span>
                      </div>
                      <span className="text-sm font-bold text-[var(--color-text-primary)]">A Specific Person</span>
                      <p className="text-xs text-[var(--color-text-secondary)] mt-1 leading-relaxed">
                        Appointment with a specific faculty member, professor, dean, or university employee.
                      </p>
                    </button>

                    {/* General Office Option */}
                    <button
                      type="button"
                      onClick={() => setVisitType('general')}
                      className={`flex flex-col text-left p-4 rounded-xl border-2 transition-all ${
                        visitType === 'general'
                          ? 'border-[#7A0A0A] bg-[#F8EEEE]/50 shadow-xs'
                          : 'border-[var(--color-border)] bg-white hover:border-[#7A0A0A]/40'
                      }`}
                    >
                      <div className="flex items-center justify-between mb-2">
                        <div className={`p-2 rounded-lg ${visitType === 'general' ? 'bg-[#7A0A0A] text-white' : 'bg-gray-100 text-gray-700'}`}>
                          <Building2 className="h-5 w-5" />
                        </div>
                        <span className="text-[10px] font-bold uppercase tracking-wider rounded-md bg-emerald-50 text-emerald-900 border border-emerald-300 px-2 py-0.5">
                          Issued After Registration
                        </span>
                      </div>
                      <span className="text-sm font-bold text-[var(--color-text-primary)]">The Office Itself</span>
                      <p className="text-xs text-[var(--color-text-secondary)] mt-1 leading-relaxed">
                        Inquiries, student document requests, certifications, cashier payments, or general processing.
                      </p>
                    </button>
                  </div>
                </div>

                {/* Specific Person Appointment Details */}
                {visitType === 'specific_person' && (
                  <div className="space-y-4 rounded-xl border border-[#7A0A0A]/20 bg-[#F8EEEE]/30 p-4">
                    <div>
                      <label htmlFor="target-personnel-name" className="block text-xs font-bold uppercase tracking-wider text-[#7A0A0A] mb-1">
                        Who would you like to visit? <span className="text-[var(--color-danger)]">*</span>
                      </label>
                      <Input
                        id="target-personnel-name"
                        placeholder="e.g. Dr. Juan Dela Cruz, Dean's Office Staff, Prof. Santos"
                        value={requestedPersonName}
                        onChange={(e) => {
                          setRequestedPersonName(e.target.value);
                        }}
                      />
                      {personnelList.length > 0 && (
                        <div className="mt-2">
                          <label htmlFor="target-personnel-select" className="block text-[11px] font-medium text-[var(--color-text-secondary)] mb-1">
                            Or select from verified office personnel (optional):
                          </label>
                          <select
                            id="target-personnel-select"
                            value={selectedPersonnelId}
                            onChange={(e) => {
                              const val = e.target.value;
                              setSelectedPersonnelId(val);
                              const p = personnelList.find((item) => item.id === val);
                              if (p) setRequestedPersonName(p.name);
                            }}
                            className="w-full rounded-xl border border-[var(--color-border)] bg-white py-1.5 px-3 text-xs font-semibold text-[var(--color-text-primary)] focus:border-[#7A0A0A] focus:outline-none focus:ring-1 focus:ring-[#7A0A0A]"
                          >
                            <option value="">-- Quick select directory personnel (optional) --</option>
                            {personnelList.map((p) => (
                              <option key={p.id} value={p.id}>
                                {p.name} {p.title ? `(${p.title})` : ''}
                              </option>
                            ))}
                          </select>
                        </div>
                      )}
                    </div>

                    <div>
                      <label htmlFor="specific-purpose" className="block text-xs font-bold uppercase tracking-wider text-[#7A0A0A] mb-1">
                        Appointment Purpose / Reason <span className="text-[var(--color-danger)]">*</span>
                      </label>
                      <Input
                        id="specific-purpose"
                        placeholder="e.g. Thesis consultation, employment interview, departmental inquiry"
                        value={specificPurpose}
                        onChange={(e) => {
                          setSpecificPurpose(e.target.value);
                          setValue('purpose', e.target.value, { shouldValidate: true });
                        }}
                      />
                    </div>

                    {/* Email Verification Component */}
                    <div className="rounded-xl border border-purple-200 bg-white p-4 space-y-3">
                      <div className="flex items-start justify-between">
                        <div>
                          <span className="text-xs font-bold text-purple-950 block">Email Verification Required</span>
                          <p className="text-[11px] text-[var(--color-text-secondary)] mt-0.5">
                            Because your QR pass is issued upon office approval, your verified email is required to deliver your pass.
                          </p>
                        </div>
                        {emailVerificationToken && (
                          <span className="rounded-full bg-emerald-100 text-emerald-800 text-[10px] font-bold px-2 py-0.5 inline-flex items-center gap-1 shrink-0">
                            <CheckCircle2 className="h-3 w-3" /> Verified
                          </span>
                        )}
                      </div>

                      <div className="flex flex-col sm:flex-row gap-2">
                        <Input
                          type="email"
                          placeholder="your.email@example.com"
                          value={visitorEmail}
                          onChange={(e) => {
                            setVisitorEmail(e.target.value);
                            setEmailVerificationToken(null);
                            setCodeSent(false);
                          }}
                          disabled={Boolean(emailVerificationToken)}
                          className="flex-1 text-xs"
                        />
                        {!emailVerificationToken && (
                          <Button
                            type="button"
                            size="sm"
                            variant="secondary"
                            onClick={handleSendVerificationCode}
                            loading={isSendingVerificationCode}
                            disabled={!visitorEmail || codeCooldown > 0}
                            icon={<Send className="h-3.5 w-3.5" />}
                          >
                            {codeCooldown > 0 ? `Resend (${codeCooldown}s)` : codeSent ? 'Resend Code' : 'Send Code'}
                          </Button>
                        )}
                      </div>

                      {codeSent && !emailVerificationToken && (
                        <div className="flex flex-col sm:flex-row gap-2 pt-1">
                          <Input
                            placeholder="Enter 6-digit code"
                            maxLength={6}
                            value={emailVerificationCode}
                            onChange={(e) => setEmailVerificationCode(e.target.value)}
                            className="flex-1 text-xs tracking-widest text-center font-mono font-bold"
                          />
                          <Button
                            type="button"
                            size="sm"
                            variant="primary"
                            onClick={handleVerifyEmailCode}
                            loading={isVerifyingCode}
                            disabled={emailVerificationCode.trim().length !== 6}
                            className="bg-emerald-600 hover:bg-emerald-700 text-white"
                          >
                            Verify Code
                          </Button>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>

              {/* Purpose of Visit for General Office Visit */}
              {visitType === 'general' && (
                <div className="space-y-4">
                  <VisitPurposeField
                    value={purpose || ''}
                    onChange={(val) => setValue('purpose', val, { shouldValidate: true })}
                    purposes={visitPurposes}
                    error={errors.purpose?.message}
                  />
                  {/* Optional Email Notification for General Office Visit */}
                  <div className="rounded-xl border border-[var(--color-border)] bg-white p-4 space-y-2">
                    <label htmlFor="general-visitor-email" className="block text-xs font-bold uppercase tracking-wider text-[var(--color-text-primary)]">
                      Email Address (Optional)
                    </label>
                    <p className="text-[11px] text-[var(--color-text-secondary)]">
                      Optionally provide your email to receive a digital copy of your E-GatePass. No verification code is required for general office visits.
                    </p>
                    <Input
                      id="general-visitor-email"
                      type="email"
                      placeholder="your.email@example.com (optional)"
                      value={visitorEmail}
                      onChange={(e) => setVisitorEmail(e.target.value)}
                      className="text-xs"
                    />
                  </div>

                  {/* General Office Attendance Notice */}
                  <div className="rounded-xl border border-blue-200 bg-blue-50/70 p-3.5 text-xs text-blue-950 flex items-start gap-2.5">
                    <Info className="h-4 w-4 text-blue-700 shrink-0 mt-0.5" />
                    <p className="leading-relaxed">
                      <strong>Office Attendance Notice:</strong> After entering the campus, proceed to the selected office and inform the office staff that you have arrived. Ask them to confirm your visit so your office attendance is recorded.
                    </p>
                  </div>
                </div>
              )}

              {/* Institutional Campus Closures Banner */}
              {calendarClosures.length > 0 && (
                <div className="rounded-xl border border-amber-300 bg-amber-50 p-3.5 text-xs text-amber-950 space-y-1.5">
                  <div className="flex items-center gap-1.5 font-bold text-amber-900">
                    <AlertTriangle className="h-4 w-4 text-amber-700 shrink-0" />
                    <span>Campus Calendar Closures Notice</span>
                  </div>
                  <p className="text-[11px] text-amber-800 leading-relaxed">
                    The university campus is closed on the following upcoming dates. Gate pass requests cannot be scheduled for these dates:
                  </p>
                  <ul className="list-disc list-inside space-y-0.5 text-[11px] text-amber-900 font-medium">
                    {calendarClosures.slice(0, 4).map((c) => (
                      <li key={c.id}>
                        <strong>{c.startDate === c.endDate ? c.startDate : `${c.startDate} to ${c.endDate}`}:</strong> {c.title}{c.description ? ` — ${c.description}` : ''}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Visit Date & Monthly Calendar */}
              <div className="space-y-2">
                <label className="block text-xs font-bold uppercase tracking-wider text-[var(--color-text-primary)]">
                  Visit Date & Availability Calendar <span className="text-[var(--color-danger)]">*</span>
                </label>
                <VisitorMonthlyCalendar
                  selectedOfficeId={selectedOfficeId}
                  selectedOfficeName={offices.find((o) => o.id === selectedOfficeId)?.name}
                  selectedDate={getValues('visitDate') || ''}
                  onSelectDate={(date) => setValue('visitDate', date, { shouldValidate: true })}
                  officeSchedules={officeSchedules}
                  campusClosures={calendarClosures}
                  minDate={today}
                  maxDate={latestVisitDate}
                />
                <input type="date" className="sr-only" min={today} max={latestVisitDate} id="visit-date" {...register('visitDate')} />
                {errors.visitDate && (
                  <p className="text-xs font-semibold text-[var(--color-danger)] mt-1">
                    {errors.visitDate.message}
                  </p>
                )}
              </div>

              {/* Vehicle Declaration Section */}
              {arrivalMode === 'vehicle' && (
                <div className="space-y-4 rounded-2xl border border-[#7A0A0A]/20 bg-[#F8EEEE]/30 p-4 sm:p-5 transition-all motion-reduce:transition-none">
                  <div className="flex items-start gap-2.5 rounded-xl bg-white p-3 text-xs text-[#7A0A0A] border border-[#7A0A0A]/15">
                    <Info className="h-4 w-4 text-[#7A0A0A] flex-shrink-0 mt-0.5" />
                    <span className="font-medium">
                      Each passenger must have their own E-GatePass. Declare the vehicle that will pass campus security.
                    </span>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <FormField label="Vehicle Type" requirement="required" error={errors.vehicleType?.message}>
                      <select
                        {...register('vehicleType')}
                        className="box-border w-full min-w-0 max-w-full rounded-xl border border-[var(--color-border)] bg-white px-3.5 py-2.5 text-base sm:text-sm text-[var(--color-text-primary)] focus:border-[#7A0A0A] focus:outline-none focus:ring-1 focus:ring-[#7A0A0A]"
                      >
                        {CONTROLLED_VEHICLE_TYPES.map((t) => (
                          <option key={t.value} value={t.value}>
                            {t.label}
                          </option>
                        ))}
                      </select>
                    </FormField>

                    <FormField
                      label="Plate Number"
                      requirement="required"
                      error={errors.plateNumber?.message}
                      hint="e.g. ABC 1234 or 123 ABC"
                    >
                      <Input
                        placeholder="ABC 1234"
                        value={watch('plateNumber') || ''}
                        onChange={(e) => {
                          const val = e.target.value.toUpperCase();
                          setValue('plateNumber', val, { shouldValidate: true });
                        }}
                      />
                    </FormField>
                  </div>

                  {/* Make and Model Selectors */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                      <label htmlFor="vehicle-make-select" className="block text-xs font-bold uppercase tracking-wider text-[var(--color-text-muted)] mb-1">
                        Vehicle Make <span className="text-[var(--color-danger)]">*</span>
                      </label>
                      <select
                        id="vehicle-make-select"
                        aria-label="Vehicle Make"
                        value={selectedMake}
                        onChange={(e) => {
                          const val = e.target.value;
                          setSelectedMake(val);
                          clearErrors('makeModel');
                        }}
                        disabled={isLoadingMakes}
                        className="box-border w-full min-w-0 max-w-full rounded-xl border border-[var(--color-border)] bg-white px-3.5 py-2.5 text-base sm:text-sm text-[var(--color-text-primary)] focus:border-[#7A0A0A] focus:outline-none focus:ring-1 focus:ring-[#7A0A0A]"
                      >
                        <option value="">Select vehicle make</option>
                        {availableMakes.map((m) => (
                          <option key={m} value={m}>
                            {m}
                          </option>
                        ))}
                        <option value="Other / Not Listed">Other / Not Listed</option>
                      </select>
                    </div>

                    {vehicleCatalogMode !== 'manual_make' && (
                      <div>
                        <label htmlFor="vehicle-model-select" className="block text-xs font-bold uppercase tracking-wider text-[var(--color-text-muted)] mb-1">
                          Vehicle Model <span className="text-[var(--color-danger)]">*</span>
                        </label>
                        <select
                          id="vehicle-model-select"
                          aria-label="Vehicle Model"
                          value={selectedModel}
                          onChange={(e) => {
                            const val = e.target.value;
                            setSelectedModel(val);
                            if (val === 'Other / Not Listed') {
                              setVehicleCatalogMode('manual_model');
                            } else if (val !== '') {
                              setVehicleCatalogMode('catalog');
                            }
                            clearErrors('makeModel');
                          }}
                          disabled={isLoadingModels || !selectedMake || selectedMake === 'Other / Not Listed'}
                          className="box-border w-full min-w-0 max-w-full rounded-xl border border-[var(--color-border)] bg-white px-3.5 py-2.5 text-base sm:text-sm text-[var(--color-text-primary)] focus:border-[#7A0A0A] focus:outline-none focus:ring-1 focus:ring-[#7A0A0A]"
                        >
                          <option value="">Select vehicle model</option>
                          {availableModels.map((m) => (
                            <option key={m} value={m}>
                              {m}
                            </option>
                          ))}
                          <option value="Other / Not Listed">Other / Not Listed</option>
                        </select>
                      </div>
                    )}
                  </div>

                  {/* Manual Make / Model Inputs */}
                  {vehicleCatalogMode === 'manual_make' && (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <FormField
                        label="Custom Make"
                        requirement="required"
                        error={errors.makeModel?.message}
                        hint="Specify vehicle manufacturer"
                      >
                        <Input
                          id="vehicle-custom-make"
                          aria-label="Custom Make"
                          placeholder="e.g. Ducati, Piaggio, Geely"
                          value={customMake}
                          onChange={(e) => {
                            setCustomMake(e.target.value);
                            clearErrors('makeModel');
                          }}
                        />
                      </FormField>
                      <FormField
                        label="Custom Model"
                        requirement="required"
                        hint="Specify model name"
                      >
                        <Input
                          id="vehicle-custom-model"
                          aria-label="Custom Model"
                          placeholder="e.g. Panigale, Vespa GTS, Emgrand"
                          value={customModel}
                          onChange={(e) => {
                            setCustomModel(e.target.value);
                            clearErrors('makeModel');
                          }}
                        />
                      </FormField>
                    </div>
                  )}

                  {vehicleCatalogMode === 'manual_model' && (
                    <FormField
                      label={`Custom Model for ${selectedMake}`}
                      requirement="required"
                      error={errors.makeModel?.message}
                      hint="Specify vehicle model name"
                    >
                      <Input
                        id="vehicle-custom-model"
                        aria-label="Custom Model"
                        placeholder="e.g. Custom / Unlisted Model"
                        value={customModel}
                        onChange={(e) => {
                          setCustomModel(e.target.value);
                          clearErrors('makeModel');
                        }}
                      />
                    </FormField>
                  )}

                  {vehicleCatalogMode === 'catalog' && errors.makeModel && (
                    <p className="text-xs text-[var(--color-danger-dark)] font-medium -mt-2">
                      {errors.makeModel.message}
                    </p>
                  )}

                  {/* Color Selector */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <FormField
                      label="Vehicle Color"
                      requirement="required"
                      error={errors.vehicleColor?.message}
                      hint="Primary exterior color"
                    >
                      <select
                        {...register('vehicleColor')}
                        className="box-border w-full min-w-0 max-w-full rounded-xl border border-[var(--color-border)] bg-white px-3.5 py-2.5 text-base sm:text-sm text-[var(--color-text-primary)] focus:border-[#7A0A0A] focus:outline-none focus:ring-1 focus:ring-[#7A0A0A]"
                      >
                        <option value="">Select color...</option>
                        {CONTROLLED_VEHICLE_COLORS.map((c) => (
                          <option key={c} value={c}>
                            {c}
                          </option>
                        ))}
                      </select>
                    </FormField>
                  </div>

                  {/* Required Vehicle Photo */}
                  <div className="space-y-2 pt-3 border-t border-[#7A0A0A]/15">
                    <label className="block text-xs font-bold uppercase tracking-wider text-[var(--color-text-muted)]">
                      Vehicle Photo <span className="text-[var(--color-danger)]">*</span>
                    </label>
                    <p className="text-xs text-[var(--color-text-secondary)]">
                      Take or upload a clear photo showing the front or rear of your vehicle with visible plate number.
                    </p>

                    <input
                      id="vehicle-photo-input"
                      type="file"
                      ref={vehicleFileInputRef}
                      accept="image/jpeg,image/png,image/webp"
                      className="hidden"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) void handleVehiclePhotoSelected(file);
                      }}
                    />

                    {vehiclePhotoPreview ? (
                      <div className="relative aspect-video max-w-sm rounded-xl overflow-hidden border-2 border-[#7A0A0A]/30 bg-slate-100 shadow-xs">
                        <img src={vehiclePhotoPreview} alt="Vehicle preview" className="w-full h-full object-cover" />
                        <button
                          type="button"
                          onClick={handleRemoveVehiclePhoto}
                          className="absolute top-2 right-2 rounded-full bg-black/70 text-white p-1 hover:bg-black/90 transition-colors"
                          title="Remove photo"
                        >
                          <X className="h-4 w-4" />
                        </button>
                      </div>
                    ) : (
                      <Button
                        type="button"
                        variant="secondary"
                        disabled={isProcessingVehiclePhoto}
                        loading={isProcessingVehiclePhoto}
                        onClick={() => vehicleFileInputRef.current?.click()}
                        icon={<Camera className="h-4 w-4" />}
                      >
                        Capture or Upload Vehicle Photo
                      </Button>
                    )}

                    {vehiclePhotoError && (
                      <p className="text-xs text-[var(--color-danger)] font-medium">
                        {vehiclePhotoError}
                      </p>
                    )}
                  </div>
                </div>
              )}

              {registrationSecurityError && (
                <div className="rounded-xl border border-[var(--color-danger)] bg-[var(--color-danger-light)] p-3 text-xs text-[var(--color-danger-dark)]" role="alert">
                  {registrationSecurityError}
                </div>
              )}

              <div className="flex gap-3 pt-2">
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => setStep('form')}
                  className="flex-1"
                  icon={<ArrowLeft className="h-4 w-4" />}
                >
                  Back to Personal
                </Button>
                <Button
                  type="button"
                  onClick={onVisitNext}
                  disabled={isStartingRegistration}
                  loading={isStartingRegistration}
                  className="flex-1"
                  icon={<ArrowRight className="h-4 w-4" />}
                >
                  Continue to Live Face Capture
                </Button>
              </div>
            </div>
          )}

          {/* ============================== STEP 3: LIVE FACE CAPTURE ============================== */}
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

              {liveFaceError && (
                <div className="rounded-xl border border-[var(--color-danger)] bg-[var(--color-danger-light)] p-4 text-xs text-[var(--color-danger-dark)] space-y-1" role="alert">
                  <div className="flex items-center gap-2 font-bold">
                    <AlertCircle className="h-4 w-4 text-[var(--color-danger)] flex-shrink-0" />
                    <span>{liveFaceError.title}</span>
                  </div>
                  <p>{liveFaceError.message}</p>
                </div>
              )}

              {photoPreview ? (
                <div className="space-y-4">
                  <div className="relative mx-auto max-w-sm overflow-hidden rounded-2xl border-2 border-[var(--color-border)] shadow-sm aspect-[3/4] bg-black">
                    <img src={photoPreview} alt="Captured face" className="w-full h-full object-cover" style={{ transform: 'scaleX(-1)' }} />
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

                  {/* Visitor framing instructions checklist */}
                  <div className="rounded-xl border border-blue-200 bg-blue-50/60 p-3 text-xs text-blue-950 space-y-1.5">
                    <p className="font-semibold text-[11px] text-blue-900 uppercase tracking-wider flex items-center gap-1.5">
                      <Sparkles className="h-3.5 w-3.5 text-blue-600" />
                      Selfie Framing Guidelines
                    </p>
                    <ul className="grid grid-cols-1 sm:grid-cols-2 gap-1 text-[11px] text-blue-900/90 list-disc list-inside">
                      <li>Keep entire head & hair inside oval</li>
                      <li>Center face and look forward</li>
                      <li>Keep forehead and chin visible</li>
                      <li>Use clear, even lighting</li>
                    </ul>
                  </div>

                  {/* Single camera viewport with oval guide */}
                  <div className="mx-auto w-full max-w-sm overflow-hidden rounded-2xl border-2 border-[var(--color-brand)] bg-black aspect-[3/4] relative flex items-center justify-center shadow-inner">
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
                      <div style={{ width: `${SELFIE_OVAL_WIDTH_PERCENT}%`, height: `${SELFIE_OVAL_HEIGHT_PERCENT}%` }} className="border-2 border-dashed border-white/80 rounded-[50%] shadow-[0_0_0_9999px_rgba(0,0,0,0.45)] flex items-center justify-center">
                        <span className="sr-only">Center face in oval</span>
                      </div>
                    </div>
                  </div>

                  <div className="flex gap-3">
                    <Button
                      variant="secondary"
                      onClick={() => {
                        faceWebcam.stop();
                        setStep('visit');
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

          {/* ============================== STEP 4: VALID ID ============================== */}
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
                id="id-file-input"
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

          {/* ============================== STEP 5: VERIFICATION ============================== */}
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
                    Extracting ID portrait and performing biometric comparison. This takes a few seconds.
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
                      onClick={onRetakeLivePhoto}
                      className="flex-1"
                      icon={<RotateCcw className="h-4 w-4" />}
                    >
                      Retake Live Photo
                    </Button>
                    <Button
                      variant="secondary"
                      onClick={onRetakeId}
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

          {/* ============================== STEP 6: REVIEW ============================== */}
          {step === 'review' && (
            <div className="space-y-6">
              <div className="text-center">
                <h2 className="text-lg font-bold text-[var(--color-text-primary)]">Review Your Information</h2>
                <p className="text-sm text-[var(--color-text-secondary)] mt-1">
                  Please verify your information before generating your E-GatePass.
                </p>
              </div>

              {currentPhase === 'submission_uncertain_hold' ? (
                <div className="rounded-xl border-2 border-amber-500 bg-amber-50 p-5 space-y-3 text-sm text-amber-950" role="alert">
                  <div className="flex items-center gap-2.5 font-bold text-base text-amber-900">
                    <AlertCircle className="h-6 w-6 text-amber-600 shrink-0" />
                    <span>Submission Held for Guard Verification</span>
                  </div>
                  <p className="text-xs leading-relaxed text-amber-900">
                    Your pass generation was interrupted and may have been processed by the server. To prevent duplicate pass creation or security locks, this submission is frozen.
                  </p>
                  <div className="rounded-lg bg-white/80 p-3 border border-amber-200 text-xs space-y-1 font-mono">
                    <p><span className="text-slate-500 font-sans">Visitor:</span> <strong className="font-sans">{getValues('firstName')} {getValues('lastName')}</strong></p>
                    <p><span className="text-slate-500 font-sans">Request Reference:</span> <span className="text-slate-800 break-all">{portalTransactionRef.current?.requestId ?? issueRequestId.current}</span></p>
                  </div>
                  <p className="text-xs text-amber-800">
                    Please show your valid physical ID to the campus gate guard to look up or verify your entry pass.
                  </p>
                </div>
              ) : (currentPhase === 'existing_pass_conflict' || portalTransactionRef.current?.phase === 'existing_pass_conflict') ? (
                <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 space-y-2 text-sm text-amber-900" role="alert">
                  <div className="flex items-center gap-2 font-semibold text-amber-950">
                    <AlertCircle className="h-5 w-5 text-amber-600 shrink-0" />
                    <span>Existing Pass Detected</span>
                  </div>
                  <p>
                    An existing pass was already created for this request, but the local retry no longer matches it. Do not create another pass. Please ask the Guard for assistance.
                  </p>
                </div>
              ) : (currentPhase === 'ambiguous' || portalTransactionRef.current?.phase === 'ambiguous') ? (
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

              {/* Standalone Vehicle Save Option for Vehicles */}
              {getValues('arrivalMode') === 'vehicle' && (
                <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
                  <label className="flex items-start gap-3 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={saveVehicle}
                      onChange={(e) => setSaveVehicle(e.target.checked)}
                      className="mt-0.5 h-4 w-4 rounded border-[var(--color-border)] text-[#7A0A0A] focus:ring-[#7A0A0A] cursor-pointer"
                    />
                    <div className="text-xs text-[var(--color-text-secondary)]">
                      <strong className="text-[var(--color-text-primary)]">Save this vehicle for future visits</strong>{' '}
                      <span className="text-[11px] font-medium text-[var(--color-text-muted)]">(optional)</span>
                      <p className="text-[11px] mt-0.5 text-[var(--color-text-muted)]">
                        Stores vehicle details for 1-click selection on future visits.
                      </p>
                    </div>
                  </label>
                </div>
              )}

              {/* Group 1: Visitor Information */}
              <div className="rounded-xl bg-[var(--color-surface)] p-4 text-sm border border-[var(--color-border)] space-y-3">
                <div className="flex items-center justify-between border-b border-[var(--color-border)] pb-2">
                  <span className="font-bold text-xs uppercase tracking-wider text-[var(--color-text-secondary)]">
                    Visitor Information
                  </span>
                  {currentPhase !== 'existing_pass_conflict' &&
                    portalTransactionRef.current?.phase !== 'existing_pass_conflict' &&
                    currentPhase !== 'ambiguous' &&
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
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                  <div>
                    <span className="text-[var(--color-text-secondary)] block">Full Name:</span>
                    <p className="font-semibold text-sm text-[var(--color-text-primary)] mt-0.5">
                      {[getValues('firstName'), getValues('middleName'), getValues('lastName')].filter(Boolean).join(' ')}
                    </p>
                  </div>
                  <div>
                    <span className="text-[var(--color-text-secondary)] block">Contact Number:</span>
                    <p className="font-semibold text-sm text-[var(--color-text-primary)] mt-0.5">
                      {normalizePhMobile(getValues('contactNumber')) || getValues('contactNumber')}
                    </p>
                  </div>
                  <div className="sm:col-span-2">
                    <span className="text-[var(--color-text-secondary)] block">Residential Address:</span>
                    <p className="font-semibold text-sm text-[var(--color-text-primary)] mt-0.5 leading-relaxed">
                      {selectedPsgc ? formatStructuredAddress({
                        regionName: selectedPsgc.region.name,
                        provinceName: selectedPsgc.province?.name,
                        cityName: selectedPsgc.city.name,
                        barangayName: selectedPsgc.barangay.name,
                        houseBuilding: homeBuilding,
                        street: homeStreet,
                      }) : 'Not specified'}
                    </p>
                  </div>
                </div>
              </div>

              {/* Group 2: Visit Information */}
              <div className="rounded-xl bg-[var(--color-surface)] p-4 text-sm border border-[var(--color-border)] space-y-3">
                <div className="flex items-center justify-between border-b border-[var(--color-border)] pb-2">
                  <span className="font-bold text-xs uppercase tracking-wider text-[var(--color-text-secondary)]">
                    Visit Information
                  </span>
                  {currentPhase !== 'existing_pass_conflict' &&
                    portalTransactionRef.current?.phase !== 'existing_pass_conflict' &&
                    currentPhase !== 'ambiguous' &&
                    portalTransactionRef.current?.phase !== 'ambiguous' && (
                    <button
                      type="button"
                      onClick={() => setStep('visit')}
                      className="text-xs font-semibold text-[var(--color-brand)] hover:underline"
                    >
                      Edit Details
                    </button>
                  )}
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                  <div>
                    <span className="text-[var(--color-text-secondary)] block">Destination Office:</span>
                    <p className="font-semibold text-sm text-[var(--color-text-primary)] mt-0.5">
                      {offices.find((o) => o.id === selectedOfficeId)?.name || 'Designated Office'}
                    </p>
                  </div>
                  <div>
                    <span className="text-[var(--color-text-secondary)] block">Visit Type:</span>
                    <p className="font-semibold text-sm text-[var(--color-text-primary)] mt-0.5">
                      {visitType === 'specific_person' ? 'Specific Person Appointment' : 'General Office Visit'}
                    </p>
                  </div>

                  {visitType === 'specific_person' ? (
                    <>
                      <div>
                        <span className="text-[var(--color-text-secondary)] block">Faculty / Staff Member:</span>
                        <p className="font-semibold text-sm text-[#7A0A0A] mt-0.5">
                          {requestedPersonName.trim() || personnelList.find((p) => p.id === selectedPersonnelId)?.name || 'Designated Personnel'}
                        </p>
                      </div>
                      <div>
                        <span className="text-[var(--color-text-secondary)] block">Verified Visitor Email:</span>
                        <p className="font-semibold text-sm text-emerald-700 mt-0.5 flex items-center gap-1">
                          <CheckCircle2 className="h-3.5 w-3.5" />
                          {visitorEmail}
                        </p>
                      </div>
                      <div className="sm:col-span-2">
                        <span className="text-[var(--color-text-secondary)] block">Appointment Purpose:</span>
                        <p className="font-semibold text-sm text-[var(--color-text-primary)] mt-0.5">{specificPurpose || getValues('purpose')}</p>
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="sm:col-span-2">
                        <span className="text-[var(--color-text-secondary)] block">General Visit Purpose:</span>
                        <p className="font-semibold text-sm text-[var(--color-text-primary)] mt-0.5">{getValues('purpose')}</p>
                      </div>
                      {/* Accidental Selection Prevention Disclaimer */}
                      <div className="sm:col-span-2 rounded-xl border border-amber-300 bg-amber-50 p-3.5 text-xs text-amber-950 space-y-2 mt-1">
                        <div className="flex items-center gap-2 font-bold text-amber-900">
                          <AlertTriangle className="h-4 w-4 text-amber-600 shrink-0" />
                          <span>General Office Visit Confirmation</span>
                        </div>
                        <p className="leading-relaxed">
                          You selected a <strong>General Office Visit</strong>. You are <strong>not</strong> requesting an appointment with a specific faculty member or employee. Once you enter campus, you must report to the office where staff will confirm your arrival.
                        </p>
                        <button
                          type="button"
                          onClick={() => setStep('visit')}
                          className="font-bold text-[#7A0A0A] underline hover:opacity-80 block"
                        >
                          Click here if you meant to meet with a specific faculty member or employee.
                        </button>
                      </div>
                    </>
                  )}

                  <div>
                    <span className="text-[var(--color-text-secondary)] block">Visit Date:</span>
                    <p className="font-semibold text-sm text-[var(--color-text-primary)] mt-0.5">{getValues('visitDate')}</p>
                  </div>
                </div>
              </div>

              {/* Group 3: Vehicle Declaration */}
              <div className="rounded-xl bg-[var(--color-surface)] p-4 text-sm border border-[var(--color-border)] space-y-3">
                <div className="flex items-center justify-between border-b border-[var(--color-border)] pb-2">
                  <span className="font-bold text-xs uppercase tracking-wider text-[var(--color-text-secondary)]">
                    Arrival & Vehicle
                  </span>
                  {currentPhase !== 'existing_pass_conflict' &&
                    portalTransactionRef.current?.phase !== 'existing_pass_conflict' &&
                    currentPhase !== 'ambiguous' &&
                    portalTransactionRef.current?.phase !== 'ambiguous' && (
                    <button
                      type="button"
                      onClick={() => setStep('visit')}
                      className="text-xs font-semibold text-[var(--color-brand)] hover:underline"
                    >
                      Edit Details
                    </button>
                  )}
                </div>
                {getValues('arrivalMode') === 'vehicle' ? (
                  <div>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
                      <div>
                        <span className="text-[var(--color-text-secondary)] block">Plate Number:</span>
                        <p className="font-mono font-bold text-sm text-[#7A0A0A] mt-0.5">{getValues('plateNumber')}</p>
                      </div>
                      <div>
                        <span className="text-[var(--color-text-secondary)] block">Vehicle Type:</span>
                        <p className="font-semibold capitalize text-[var(--color-text-primary)] mt-0.5">{getValues('vehicleType')}</p>
                      </div>
                      <div>
                        <span className="text-[var(--color-text-secondary)] block">Color:</span>
                        <p className="font-semibold text-[var(--color-text-primary)] mt-0.5">{getValues('vehicleColor')}</p>
                      </div>
                      <div>
                        <span className="text-[var(--color-text-secondary)] block">Make / Model:</span>
                        <p className="font-semibold text-[var(--color-text-primary)] mt-0.5">{getValues('makeModel') || '—'}</p>
                      </div>
                    </div>
                    {vehiclePhotoPreview && (
                      <div className="mt-3 pt-3 border-t border-[var(--color-border)] flex items-center gap-3">
                        <img
                          src={vehiclePhotoPreview}
                          alt="Declared vehicle"
                          className="h-14 w-24 object-cover rounded-lg border border-[var(--color-border)] shadow-2xs"
                        />
                        <div className="text-xs">
                          <span className="font-semibold text-[var(--color-text-primary)] block">Vehicle Photo Attached</span>
                          <span className="text-[11px] text-[var(--color-text-secondary)]">Vehicle photo captured for physical gate inspection.</span>
                        </div>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="flex items-center gap-2 text-xs text-[var(--color-text-secondary)]">
                    <User className="h-4 w-4 text-[var(--color-brand)]" />
                    <span>No vehicle declared. Arriving as pedestrian, transit, or drop-off.</span>
                  </div>
                )}
              </div>

              {/* Group 4: Photo Previews */}
              <div className="rounded-xl bg-[var(--color-surface)] p-4 text-sm border border-[var(--color-border)] space-y-3">
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
                        style={{ transform: 'scaleX(-1)' }}
                      />
                      {currentPhase !== 'ambiguous' &&
                        currentPhase !== 'submission_uncertain_hold' && (
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
                      )}
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
                      {currentPhase !== 'ambiguous' &&
                        currentPhase !== 'submission_uncertain_hold' && (
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
                  )}
                  {vehiclePhotoPreview && (
                    <div className="text-center">
                      <p className="text-xs text-[var(--color-text-secondary)] mb-1">Declared Vehicle</p>
                      <img
                        src={vehiclePhotoPreview}
                        alt="Declared vehicle"
                        className="h-24 w-36 object-cover rounded-lg border border-[var(--color-border)] shadow-sm mx-auto"
                      />
                    </div>
                  )}
                </div>
              </div>

              <div className="flex flex-col sm:flex-row gap-3">
                {currentPhase === 'submission_uncertain_hold' ? (
                  <Button
                    onClick={handleStartOver}
                    className="flex-1"
                    icon={<RotateCcw className="h-4 w-4" />}
                  >
                    Start Over
                  </Button>
                ) : (
                  <>
                    <Button
                      variant="secondary"
                      onClick={() => setStep('visit')}
                      className="flex-1"
                      disabled={currentPhase === 'existing_pass_conflict' || currentPhase === 'ambiguous'}
                      icon={<ArrowLeft className="h-4 w-4" />}
                    >
                      Back to Details
                    </Button>
                    <Button
                      onClick={onSubmit}
                      disabled={!identityVerified || currentPhase === 'existing_pass_conflict'}
                      className="flex-1"
                      icon={<CheckCircle2 className="h-4 w-4" />}
                    >
                      {visitType === 'specific_person'
                        ? 'Submit Request for Office Approval'
                        : 'Generate E-GatePass'}
                    </Button>
                  </>
                )}
              </div>
            </div>
          )}

          {/* ============================== RETURNING VISITOR 1:1 LOOKUP ============================== */}
          {step === 'returning_lookup' && (
            <div className="space-y-6">
              <div className="text-center">
                <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-[#F8EEEE] text-[#7A0A0A] text-xs font-semibold mb-2">
                  <UserCheck className="h-3.5 w-3.5" />
                  <span>Returning Visitor Frontdoor</span>
                </div>
                <h2 className="text-xl font-bold text-[var(--color-text-primary)]">
                  Find Your Enrolled Profile
                </h2>
                <p className="text-sm text-[var(--color-text-secondary)] mt-1.5">
                  Enter your registered full name to locate your profile for 1:1 live facial verification.
                </p>
              </div>

              {returningSearchError && (
                <div className="rounded-xl border border-[var(--color-danger)] bg-[var(--color-danger-light)] p-4 text-xs text-[var(--color-danger-dark)] flex items-start gap-2" role="alert">
                  <AlertCircle className="h-4 w-4 text-[var(--color-danger)] flex-shrink-0 mt-0.5" />
                  <span>{returningSearchError}</span>
                </div>
              )}

              <div className="rounded-2xl border border-[var(--color-border)] bg-white p-5 space-y-4 shadow-xs">
                <div className="grid gap-3 sm:grid-cols-2">
                  <FormField label="First Name" requirement="required">
                    <Input
                      placeholder="e.g. Juan"
                      value={returningLookupFirst}
                      onChange={(e) => setReturningLookupFirst(e.target.value)}
                      disabled={isSearchingReturning}
                    />
                  </FormField>
                  <FormField label="Middle Name" requirement="optional">
                    <Input
                      placeholder="e.g. Dela"
                      value={returningLookupMiddle}
                      onChange={(e) => setReturningLookupMiddle(e.target.value)}
                      disabled={isSearchingReturning}
                    />
                  </FormField>
                </div>
                <FormField label="Last Name" requirement="required">
                  <Input
                    placeholder="e.g. Cruz"
                    value={returningLookupLast}
                    onChange={(e) => setReturningLookupLast(e.target.value)}
                    disabled={isSearchingReturning}
                  />
                </FormField>

                <FormField label="Registered Mobile Number" requirement="required">
                  <Input
                    type="tel"
                    placeholder="e.g. 09171234567"
                    value={returningLookupContact}
                    onChange={(e) => setReturningLookupContact(e.target.value)}
                    disabled={isSearchingReturning}
                  />
                </FormField>

                <Button
                  onClick={onSearchReturningProfile}
                  disabled={!returningLookupFirst.trim() || !returningLookupLast.trim() || !returningLookupContact.trim() || isSearchingReturning}
                  loading={isSearchingReturning}
                  className="w-full"
                  icon={<Search className="h-4 w-4" />}
                >
                  Search Profile
                </Button>
              </div>

              <div className="flex gap-3 pt-2">
                <Button
                  variant="secondary"
                  onClick={() => {
                    setStep('frontdoor');
                  }}
                  className="flex-1"
                  icon={<ArrowLeft className="h-4 w-4" />}
                >
                  Back to Setup
                </Button>
              </div>
            </div>
          )}

          {/* ============================== RETURNING VISITOR SEARCH RESULTS ============================== */}
          {step === 'returning_results' && (
            <div className="space-y-6">
              <div className="text-center">
                <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-[#F8EEEE] text-[#7A0A0A] text-xs font-semibold mb-2">
                  <UserCheck className="h-3.5 w-3.5" />
                  <span>Returning Visitor Frontdoor</span>
                </div>
                <h2 className="text-xl font-bold text-[var(--color-text-primary)]">
                  {returningCandidates.length === 0 ? 'No Matching Profiles Found' : 'Select Your Profile'}
                </h2>
                <p className="text-sm text-[var(--color-text-secondary)] mt-1.5">
                  {returningCandidates.length === 0
                    ? `No active returning visitor profile found for "${returningLookupFirst.trim()} ${returningLookupLast.trim()}".`
                    : 'Choose your profile to proceed with 1:1 live facial verification.'}
                </p>
              </div>

              {returningCandidates.length === 0 ? (
                <div className="rounded-2xl border border-amber-200 bg-amber-50 p-6 text-center space-y-4 shadow-xs">
                  <div className="mx-auto w-12 h-12 rounded-full bg-amber-100 flex items-center justify-center text-amber-700">
                    <User className="w-6 h-6" />
                  </div>
                  <div className="space-y-1">
                    <h3 className="text-base font-bold text-amber-950">No Enrolled Profile Matched</h3>
                    <p className="text-xs text-amber-800 max-w-md mx-auto leading-relaxed">
                      We could not find an enrolled returning visitor profile under "{returningLookupFirst.trim()} {returningLookupLast.trim()}". Please check your spelling or register as a new visitor.
                    </p>
                  </div>
                  <div className="pt-2 flex flex-col sm:flex-row gap-3 justify-center">
                    <Button
                      variant="secondary"
                      onClick={() => {
                        setSelectedReturningCandidate(null);
                        setStep('returning_lookup');
                      }}
                      icon={<ArrowLeft className="h-4 w-4" />}
                    >
                      Back to Search
                    </Button>
                    <Button
                      variant="primary"
                      onClick={() => {
                        beginNewVisitorSetup();
                      }}
                      icon={<UserPlus className="h-4 w-4" />}
                    >
                      Register as New Visitor
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="flex items-center justify-between px-1">
                    <span className="text-xs font-bold uppercase tracking-wider text-[var(--color-text-muted)]">
                      {returningCandidates.length} {returningCandidates.length === 1 ? 'profile' : 'profiles'} found
                    </span>
                    <span className="text-[11px] text-[var(--color-text-secondary)] font-medium">
                      Privacy-masked for safety
                    </span>
                  </div>

                  <div className="max-h-[360px] overflow-y-auto space-y-2.5 pr-1">
                    {returningCandidates.map((cand) => {
                      const isSelected = selectedReturningCandidate?.profileId === cand.profileId;
                      return (
                        <div
                          key={cand.profileId}
                          onClick={() => setSelectedReturningCandidate(cand)}
                          role="button"
                          tabIndex={0}
                          className={`p-4 rounded-xl border-2 transition-all cursor-pointer flex items-center justify-between ${
                            isSelected
                              ? 'border-[#7A0A0A] bg-[#F8EEEE]/40 shadow-xs'
                              : 'border-[var(--color-border)] bg-white hover:border-slate-300'
                          }`}
                        >
                          <div className="space-y-1">
                            <div className="flex items-center gap-2">
                              <span className="font-bold text-sm text-[var(--color-text-primary)]">
                                {cand.maskedName}
                              </span>
                              {isSelected && (
                                <span className="bg-[#7A0A0A] text-white text-[10px] font-bold px-2 py-0.5 rounded-full">
                                  Selected
                                </span>
                              )}
                            </div>
                            <div className="text-xs text-[var(--color-text-secondary)] flex items-center gap-3">
                              <span>Phone: {cand.maskedContact}</span>
                              <span>•</span>
                              <span>{cand.partialLocality}</span>
                            </div>
                          </div>
                          <div
                            className={`h-5 w-5 rounded-full border flex items-center justify-center ${
                              isSelected ? 'border-[#7A0A0A] bg-[#7A0A0A] text-white' : 'border-slate-300 bg-white'
                            }`}
                          >
                            {isSelected && <div className="h-2 w-2 rounded-full bg-white" />}
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  <div className="pt-2 space-y-2">
                    <Button
                      onClick={() => {
                        invalidatePortalEvidenceCheckpoint(portalTransactionRef.current, 'photo');
                        setReturningCaptureStage('live');
                        setReturningSelfieBlob(null);
                        if (returningSelfieUrl) {
                          URL.revokeObjectURL(returningSelfieUrl);
                          setReturningSelfieUrl(null);
                        }
                        setReturningIdentifyError(null);
                        setStep('returning_capture');
                        void faceWebcam.start();
                      }}
                      disabled={!selectedReturningCandidate}
                      className="w-full min-h-[50px] text-sm font-bold"
                      icon={<Camera className="h-4 w-4" />}
                    >
                      Proceed to Live Face Verification
                    </Button>
                    <Button
                      variant="secondary"
                      onClick={() => {
                        setSelectedReturningCandidate(null);
                        setStep('returning_lookup');
                      }}
                      className="w-full"
                      icon={<ArrowLeft className="h-4 w-4" />}
                    >
                      Back to Search
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ============================== RETURNING VISITOR CAPTURE ============================== */}
          {step === 'returning_capture' && (
            <div className="space-y-6">
              <div className="text-center">
                {selectedReturningCandidate && (
                  <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-emerald-50 text-emerald-900 border border-emerald-200 text-xs font-semibold mb-2">
                    <UserCheck className="h-3.5 w-3.5 text-emerald-700" />
                    <span>Verifying Profile: {selectedReturningCandidate.maskedName}</span>
                  </div>
                )}
                <h2 className="text-lg font-bold text-[var(--color-text-primary)]">
                  {returningCaptureStage === 'review' ? 'Review Your Selfie' : 'Capture Your Selfie'}
                </h2>
                <p className="text-sm text-[var(--color-text-secondary)] mt-1">
                  {returningCaptureStage === 'review'
                    ? 'Check your photo. Make sure your full face is visible, clearly focused, and well-lit before submitting.'
                    : 'Look directly at the camera with good lighting. Position your face inside the guide.'}
                </p>
              </div>

              {returningIdentifyError && returningCaptureStage === 'review' && (
                <div className="rounded-xl border border-[var(--color-danger)] bg-[var(--color-danger-light)] p-4 text-xs text-[var(--color-danger-dark)] space-y-2" role="alert">
                  <div className="flex items-center gap-2 font-bold text-sm">
                    <AlertCircle className="h-5 w-5 text-[var(--color-danger)] flex-shrink-0" />
                    <span>We could not verify this photo.</span>
                  </div>
                  <p className="text-xs leading-relaxed">{returningIdentifyError}</p>
                  <div className="pt-2 flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      onClick={onRetakeReturningSelfie}
                      className="min-h-[44px]"
                      icon={<RotateCcw className="h-4 w-4" />}
                    >
                      Retake Selfie
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        onRetakeReturningSelfie();
                        setRegistrationMode('new');
                        setStep('form');
                      }}
                      className="min-h-[44px]"
                    >
                      Register as New Visitor
                    </Button>
                  </div>
                </div>
              )}

              {/* STAGE 1: Live Camera Stream */}
              {returningCaptureStage === 'live' && (
                <div className="space-y-4">
                  <div className="mx-auto w-full max-w-sm overflow-hidden rounded-2xl border-2 border-[var(--color-brand)] bg-black aspect-[3/4] relative flex items-center justify-center shadow-inner">
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
                        style={{ transform: 'none' }}
                        className="h-full w-full object-cover"
                      />
                    )}
                    <div className="absolute inset-0 pointer-events-none flex items-center justify-center">
                      <div style={{ width: `${SELFIE_OVAL_WIDTH_PERCENT}%`, height: `${SELFIE_OVAL_HEIGHT_PERCENT}%` }} className="border-2 border-dashed border-white/80 rounded-[50%] shadow-[0_0_0_9999px_rgba(0,0,0,0.45)] flex items-center justify-center">
                        <span className="sr-only">Center face in oval</span>
                      </div>
                    </div>
                  </div>

                  <div className="flex flex-col-reverse sm:flex-row gap-3 pt-2">
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={() => {
                        faceWebcam.stop();
                        invalidatePortalEvidenceCheckpoint(portalTransactionRef.current, 'photo');
                        if (returningSelfieUrl) {
                          URL.revokeObjectURL(returningSelfieUrl);
                          setReturningSelfieUrl(null);
                        }
                        setReturningSelfieBlob(null);
                        setReturningIdentifyError(null);
                        setStep('returning_lookup');
                      }}
                      className="w-full sm:flex-1 min-h-[56px] sm:min-h-11 text-[15px] sm:text-sm"
                      icon={<ArrowLeft className="h-5 w-5" />}
                    >
                      Back
                    </Button>
                    <Button
                      type="button"
                      onClick={onCaptureReturningSelfie}
                      disabled={!faceWebcam.isActive || faceWebcam.isStarting}
                      className="w-full sm:flex-1 min-h-[56px] sm:min-h-11 text-[15px] sm:text-sm"
                      icon={<Camera className="h-5 w-5" />}
                    >
                      Capture Selfie
                    </Button>
                  </div>
                </div>
              )}

              {/* STAGE 2: Still-Photo Review & Explicit Confirmation */}
              {returningCaptureStage === 'review' && (
                <div className="space-y-4">
                  <div className="mx-auto w-full max-w-sm overflow-hidden rounded-2xl border-2 border-[var(--color-border-strong)] bg-black aspect-[3/4] relative flex items-center justify-center shadow-inner">
                    {isIdentifyingReturning && (
                      <div className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-black/60 text-white text-xs p-4 text-center">
                        <Loader2 className="h-7 w-7 animate-spin mb-2 text-[var(--color-brand)]" />
                        <span className="font-semibold text-sm">Verifying facial identity…</span>
                        <span className="text-xs text-white/80 mt-1">Comparing photo against saved template</span>
                      </div>
                    )}
                    {returningSelfieUrl && (
                      <img
                        src={returningSelfieUrl}
                        alt="Captured selfie preview"
                        className="h-full w-full object-cover"
                      />
                    )}
                  </div>

                  <div className="flex flex-col-reverse sm:flex-row gap-3 pt-2">
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={onRetakeReturningSelfie}
                      disabled={isIdentifyingReturning}
                      className="w-full sm:flex-1 min-h-[56px] sm:min-h-11 text-[15px] sm:text-sm"
                      icon={<RotateCcw className="h-5 w-5" />}
                    >
                      Retake Photo
                    </Button>
                    <Button
                      type="button"
                      onClick={onConfirmReturningVerification}
                      disabled={isIdentifyingReturning || !returningSelfieBlob}
                      loading={isIdentifyingReturning}
                      className="w-full sm:flex-1 min-h-[56px] sm:min-h-11 text-[15px] sm:text-sm"
                      icon={<CheckCircle2 className="h-5 w-5" />}
                    >
                      Verify This Photo
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ============================== RETURNING VISITOR CONFIRM ============================== */}
          {step === 'returning_confirm' && returningProfile && (
            <div className="space-y-6">
              <div className="text-center">
                <h2 className="text-xl font-black text-[var(--color-text-primary)]">
                  Welcome back, {returningProfile.firstName}!
                </h2>
                <p className="text-sm text-[var(--color-text-secondary)] mt-1">
                  {returningProfile.verificationState === 'provisional'
                    ? "Face match is provisional. Please present your physical ID at the gate upon arrival for security verification."
                    : "Your identity has been verified via biometrics. Confirm today's visit details below."}
                </p>
              </div>

              {/* Verified / Provisional Identity Badge */}
              {returningProfile.verificationState === 'provisional' ? (
                <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-xs text-amber-950 flex items-center justify-between">
                  <div>
                    <span className="text-[11px] uppercase tracking-wider text-amber-800 font-semibold block">Match Candidate</span>
                    <span className="font-bold text-base text-amber-950">{returningProfile.fullName}</span>
                  </div>
                  <span className="rounded-full bg-amber-600 text-white font-bold text-[10px] px-2.5 py-0.5 uppercase tracking-wide">
                    Provisional Match (Guard Verification at Gate)
                  </span>
                </div>
              ) : (
                <div className="rounded-xl border border-emerald-300 bg-emerald-50 p-4 text-xs text-emerald-950 flex items-center justify-between">
                  <div>
                    <span className="text-[11px] uppercase tracking-wider text-emerald-800 font-semibold block">Verified Name</span>
                    <span className="font-bold text-base text-emerald-950">{returningProfile.fullName}</span>
                  </div>
                  <span className="rounded-full bg-emerald-600 text-white font-bold text-[10px] px-2.5 py-0.5 uppercase tracking-wide">
                    Verified Identity
                  </span>
                </div>
              )}

              {/* Editable Contact & Address for Today */}
              <div className="space-y-4">
                <FormField label="Mobile Number" requirement="required" error={errors.contactNumber?.message}>
                  <Input type="tel" {...register('contactNumber')} />
                </FormField>

                <StructuredAddressField
                  value={selectedPsgc}
                  onChange={(val) => {
                    setSelectedPsgc(val);
                    setAddressError(null);
                  }}
                  houseBuilding={homeBuilding}
                  onHouseBuildingChange={setHomeBuilding}
                  street={homeStreet}
                  onStreetChange={setHomeStreet}
                  error={addressError || undefined}
                />
              </div>

              <label className="flex items-center gap-2 cursor-pointer text-xs text-[var(--color-text-secondary)]">
                <input
                  type="checkbox"
                  checked={saveReturningUpdates}
                  onChange={(e) => setSaveReturningUpdates(e.target.checked)}
                  className="rounded text-[var(--color-brand)]"
                />
                <span>Update my profile with these contact details for future visits</span>
              </label>

              {/* Visit Purpose & Date */}
              <VisitPurposeField
                value={purpose || ''}
                onChange={(val) => setValue('purpose', val, { shouldValidate: true })}
                purposes={visitPurposes}
                error={errors.purpose?.message}
              />

              {/* Destination Office & Visit Date */}
              <div className="space-y-4">
                <div>
                  <label htmlFor="returning-destination-office-select" className="block text-xs font-bold uppercase tracking-wider text-[var(--color-text-primary)] mb-1">
                    Destination University Office
                  </label>
                  <div className="relative">
                    <Building2 className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-text-muted)]" />
                    <select
                      id="returning-destination-office-select"
                      value={selectedOfficeId}
                      onChange={(e) => setSelectedOfficeId(e.target.value)}
                      className="w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] py-2.5 pl-9 pr-8 text-sm font-semibold text-[var(--color-text-primary)] focus:border-[#7A0A0A] focus:outline-none focus:ring-1 focus:ring-[#7A0A0A]"
                    >
                      <option value="">Campus General Visit (or select specific office)</option>
                      {offices.map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.name}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <div className="space-y-2">
                  <label className="block text-xs font-bold uppercase tracking-wider text-[var(--color-text-primary)]">
                    Visit Date & Availability Calendar <span className="text-[var(--color-danger)]">*</span>
                  </label>
                  <VisitorMonthlyCalendar
                    selectedOfficeId={selectedOfficeId || 'general'}
                    selectedOfficeName={offices.find((o) => o.id === selectedOfficeId)?.name || 'Campus'}
                    selectedDate={getValues('visitDate') || ''}
                    onSelectDate={(date) => setValue('visitDate', date, { shouldValidate: true })}
                    officeSchedules={officeSchedules}
                    campusClosures={calendarClosures}
                    minDate={today}
                    maxDate={latestVisitDate}
                  />
                  <input type="date" className="sr-only" min={today} max={latestVisitDate} {...register('visitDate')} />
                  {errors.visitDate && (
                    <p className="text-xs font-semibold text-[var(--color-danger)] mt-1">
                      {errors.visitDate.message}
                    </p>
                  )}
                </div>
              </div>

              {/* Explicit Arrival Method For Today's Visit */}
              <div className="space-y-3 pt-2 border-t border-[var(--color-border)]">
                <label className="block text-xs font-bold uppercase tracking-wider text-[var(--color-text-muted)]">
                  Arrival Method For Today's Visit *
                </label>
                <div className="grid grid-cols-2 gap-3">
                  <Button
                    type="button"
                    variant={arrivalMode === 'no_vehicle' ? 'primary' : 'secondary'}
                    onClick={() => {
                      setValue('arrivalMode', 'no_vehicle');
                      setSelectedSavedVehicleId('none');
                      setValue('plateNumber', '');
                      setValue('vehicleColor', '');
                      setValue('makeModel', '');
                      setVehiclePhotoBlob(null);
                      vehiclePhotoUrl.clear();
                    }}
                    className="flex items-center justify-center gap-2 text-xs font-bold"
                  >
                    <User className="h-4 w-4" />
                    <span>On Foot / Transit</span>
                  </Button>
                  <Button
                    type="button"
                    variant={arrivalMode === 'vehicle' ? 'primary' : 'secondary'}
                    onClick={() => {
                      setValue('arrivalMode', 'vehicle');
                      if (returningProfile.savedVehicles && returningProfile.savedVehicles.length > 0) {
                        const firstVeh = returningProfile.savedVehicles[0];
                        if (firstVeh) {
                          setSelectedSavedVehicleId(firstVeh.id);
                          setValue('vehicleType', firstVeh.vehicleType);
                          setValue('plateNumber', firstVeh.plateNumber);
                          setValue('vehicleColor', firstVeh.color);
                          setValue('makeModel', firstVeh.makeModel || '');
                        }
                      } else {
                        setSelectedSavedVehicleId('new');
                      }
                    }}
                    className="flex items-center justify-center gap-2 text-xs font-bold"
                  >
                    <Car className="h-4 w-4" />
                    <span>With Vehicle</span>
                  </Button>
                </div>

                {arrivalMode === 'vehicle' && (
                  <div className="space-y-4 rounded-xl border border-slate-200 bg-slate-50/70 p-4 mt-3">
                    {/* Saved vehicles choice if available */}
                    {returningProfile.savedVehicles && returningProfile.savedVehicles.length > 0 && (
                      <div className="space-y-2">
                        <label className="block text-xs font-bold uppercase tracking-wider text-slate-700">
                          Select Vehicle
                        </label>
                        <div className="grid grid-cols-1 gap-2">
                          {returningProfile.savedVehicles.map((veh) => (
                            <div
                              key={veh.id}
                              onClick={() => {
                                setSelectedSavedVehicleId(veh.id);
                                setValue('vehicleType', veh.vehicleType);
                                setValue('plateNumber', veh.plateNumber);
                                setValue('vehicleColor', veh.color);
                                setValue('makeModel', veh.makeModel || '');
                              }}
                              role="button"
                              tabIndex={0}
                              className={`p-3 rounded-xl border text-xs cursor-pointer flex items-center justify-between transition-all ${
                                selectedSavedVehicleId === veh.id
                                  ? 'border-[var(--color-brand)] bg-[var(--color-brand-light)] font-bold shadow-xs'
                                  : 'border-slate-200 bg-white hover:border-slate-300'
                              }`}
                            >
                              <div className="flex items-center gap-2">
                                <Car className="h-4 w-4 text-[#7A0A0A]" />
                                <span>
                                  <strong>{veh.plateNumber}</strong> ({veh.vehicleType}) • {veh.color} {veh.makeModel ? `• ${veh.makeModel}` : ''}
                                </span>
                              </div>
                              {selectedSavedVehicleId === veh.id && <CheckCircle2 className="h-4 w-4 text-[var(--color-brand)]" />}
                            </div>
                          ))}

                          <div
                            onClick={() => {
                              setSelectedSavedVehicleId('new');
                              setValue('plateNumber', '');
                              setValue('vehicleColor', '');
                              setValue('makeModel', '');
                            }}
                            role="button"
                            tabIndex={0}
                            className={`p-3 rounded-xl border text-xs cursor-pointer flex items-center justify-between transition-all ${
                              selectedSavedVehicleId === 'new'
                                ? 'border-[var(--color-brand)] bg-[var(--color-brand-light)] font-bold shadow-xs'
                                : 'border-slate-200 bg-white hover:border-slate-300'
                            }`}
                          >
                            <span>+ Enter a Different Vehicle</span>
                            {selectedSavedVehicleId === 'new' && <CheckCircle2 className="h-4 w-4 text-[var(--color-brand)]" />}
                          </div>
                        </div>
                      </div>
                    )}

                    {/* Manual vehicle inputs if new vehicle selected or no saved vehicles */}
                    {(!returningProfile.savedVehicles || returningProfile.savedVehicles.length === 0 || selectedSavedVehicleId === 'new') && (
                      <div className="space-y-3 pt-2 border-t border-slate-200">
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                          <FormField label="Vehicle Type" requirement="required">
                            <select
                              value={getValues('vehicleType') || 'car'}
                              onChange={(e) => setValue('vehicleType', e.target.value as any)}
                              className="w-full text-xs rounded-xl border border-slate-300 bg-white px-3 py-2 text-slate-900 font-medium"
                            >
                              <option value="car">Car / Sedan</option>
                              <option value="motorcycle">Motorcycle</option>
                              <option value="suv">SUV</option>
                              <option value="van">Van</option>
                              <option value="pickup">Pickup</option>
                              <option value="truck">Truck</option>
                              <option value="other">Other</option>
                            </select>
                          </FormField>

                          <FormField label="Plate Number" requirement="required" error={errors.plateNumber?.message}>
                            <Input
                              placeholder="e.g. ABC 1234 or 123ABC"
                              {...register('plateNumber')}
                            />
                          </FormField>
                        </div>

                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                          <FormField label="Color" requirement="required" error={errors.vehicleColor?.message}>
                            <select
                              value={getValues('vehicleColor') || 'White'}
                              onChange={(e) => setValue('vehicleColor', e.target.value)}
                              className="w-full text-xs rounded-xl border border-slate-300 bg-white px-3 py-2 text-slate-900 font-medium"
                            >
                              {CONTROLLED_VEHICLE_COLORS.map((col) => (
                                <option key={col} value={col}>{col}</option>
                              ))}
                            </select>
                          </FormField>

                          <FormField label="Make & Model" requirement="required" error={errors.makeModel?.message}>
                            <Input
                              placeholder="e.g. Toyota Vios"
                              {...register('makeModel')}
                            />
                          </FormField>
                        </div>

                        <label className="flex items-center gap-2 cursor-pointer text-xs text-slate-600">
                          <input
                            type="checkbox"
                            checked={saveVehicle}
                            onChange={(e) => setSaveVehicle(e.target.checked)}
                            className="rounded text-[var(--color-brand)]"
                          />
                          <span>Save this vehicle to my returning profile</span>
                        </label>
                      </div>
                    )}

                    {/* CURRENT VISIT VEHICLE PHOTO CAPTURE (Required for all vehicles) */}
                    <div className="space-y-2 pt-3 border-t border-slate-200">
                      <div className="flex items-center justify-between">
                        <label className="block text-xs font-bold uppercase tracking-wider text-slate-800 flex items-center gap-1.5">
                          <Camera className="h-4 w-4 text-[#7A0A0A]" />
                          Current Visit Vehicle Photo *
                        </label>
                        <span className="text-[10px] font-bold text-red-700 bg-red-100 px-2 py-0.5 rounded-full">
                          Required
                        </span>
                      </div>
                      <p className="text-[11px] text-slate-600">
                        A real-time photo of your vehicle is required for gate security verification today.
                      </p>

                      {vehiclePhotoPreview ? (
                        <div className="relative rounded-xl overflow-hidden border border-slate-200 aspect-video max-h-48 bg-slate-900 flex items-center justify-center">
                          <img
                            src={vehiclePhotoPreview}
                            alt="Current vehicle photo"
                            className="h-full w-full object-cover"
                          />
                          <button
                            type="button"
                            onClick={handleRemoveVehiclePhoto}
                            className="absolute top-2 right-2 rounded-full bg-red-600 text-white p-1.5 shadow-md hover:bg-red-700 transition-colors"
                            title="Remove photo"
                          >
                            <X className="h-4 w-4" />
                          </button>
                        </div>
                      ) : (
                        <div>
                          <input
                            ref={vehicleFileInputRef}
                            type="file"
                            accept="image/jpeg,image/png,image/webp"
                            onChange={(e) => {
                              const f = e.target.files?.[0];
                              if (f) void handleVehiclePhotoSelected(f);
                            }}
                            className="hidden"
                            id="returning-vehicle-photo-input"
                          />
                          <Button
                            type="button"
                            variant="secondary"
                            onClick={() => vehicleFileInputRef.current?.click()}
                            disabled={isProcessingVehiclePhoto}
                            icon={
                              isProcessingVehiclePhoto ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                              ) : (
                                <Camera className="h-4 w-4" />
                              )
                            }
                            className="w-full text-xs font-bold"
                          >
                            {isProcessingVehiclePhoto ? 'Processing photo…' : 'Take or Upload Vehicle Photo'}
                          </Button>
                        </div>
                      )}
                      {vehiclePhotoError && (
                        <p className="text-xs text-red-600 font-medium">{vehiclePhotoError}</p>
                      )}
                    </div>
                  </div>
                )}
              </div>

              <div className="flex gap-3 pt-2">
                <Button
                  variant="secondary"
                  onClick={() => setStep('frontdoor')}
                  className="flex-1"
                  icon={<ArrowLeft className="h-4 w-4" />}
                >
                  Start Over
                </Button>
                <Button
                  onClick={onReturningConfirmNext}
                  className="flex-1"
                  icon={<ArrowRight className="h-4 w-4" />}
                >
                  Review Pass Details
                </Button>
              </div>
            </div>
          )}

          {/* ============================== RETURNING VISITOR REVIEW ============================== */}
          {step === 'returning_review' && returningProfile && (
            <div className="space-y-6">
              <div className="text-center">
                <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-[#F8EEEE] text-[#7A0A0A] text-xs font-semibold mb-2">
                  <UserCheck className="h-3.5 w-3.5" />
                  <span>Returning Visitor Pass</span>
                </div>
                <h2 className="text-xl font-bold text-[var(--color-text-primary)]">
                  Review Your Visit Details
                </h2>
                <p className="text-sm text-[var(--color-text-secondary)] mt-1">
                  Please verify your information before generating your E-GatePass.
                </p>
              </div>

              {submitError && (
                <div className="rounded-md border border-[var(--color-danger)] bg-[var(--color-danger-light)] p-3 text-sm text-[var(--color-danger-dark)]" role="alert">
                  {submitError}
                </div>
              )}

              {/* Verification Badge */}
              <div className="rounded-xl border border-emerald-300 bg-emerald-50 p-3.5 flex items-center justify-between text-xs text-emerald-900">
                <div className="flex items-center gap-2">
                  <CheckCircle2 className="h-5 w-5 text-emerald-600 flex-shrink-0" />
                  <div>
                    <span className="font-bold block">Biometric Identity Verified</span>
                    <span className="text-[11px] text-emerald-800">Your live face matches your enrolled returning profile.</span>
                  </div>
                </div>
                <span className="rounded-full bg-emerald-600 text-white font-bold text-[10px] px-2.5 py-0.5 uppercase tracking-wide">
                  Verified
                </span>
              </div>

              {/* Group 1: Verified Visitor Information */}
              <div className="rounded-xl bg-[var(--color-surface)] p-4 text-sm border border-[var(--color-border)] space-y-3">
                <div className="flex items-center justify-between border-b border-[var(--color-border)] pb-2">
                  <span className="font-bold text-xs uppercase tracking-wider text-[var(--color-text-secondary)]">
                    Visitor Information
                  </span>
                  <button
                    type="button"
                    onClick={() => setStep('returning_confirm')}
                    className="text-xs font-semibold text-[var(--color-brand)] hover:underline"
                  >
                    Edit Details
                  </button>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                  <div>
                    <span className="text-[var(--color-text-secondary)] block">Full Name:</span>
                    <p className="font-semibold text-sm text-[var(--color-text-primary)] mt-0.5">
                      {returningProfile.fullName}
                    </p>
                  </div>
                  <div>
                    <span className="text-[var(--color-text-secondary)] block">Contact Number:</span>
                    <p className="font-semibold text-sm text-[var(--color-text-primary)] mt-0.5">
                      {getValues('contactNumber') || returningProfile.contactNumber}
                    </p>
                  </div>
                  <div className="sm:col-span-2">
                    <span className="text-[var(--color-text-secondary)] block">Residential Address:</span>
                    <p className="font-semibold text-sm text-[var(--color-text-primary)] mt-0.5 leading-relaxed">
                      {selectedPsgc
                        ? formatStructuredAddress({
                            regionName: selectedPsgc.region.name,
                            provinceName: selectedPsgc.province?.name,
                            cityName: selectedPsgc.city.name,
                            barangayName: selectedPsgc.barangay.name,
                            houseBuilding: homeBuilding,
                            street: homeStreet,
                          })
                        : (returningProfile?.homeAddress || 'No residential address specified')}
                    </p>
                  </div>
                  <div className="sm:col-span-2">
                    <span className="text-[var(--color-text-secondary)] block">Profile Update for Future Visits:</span>
                    <p className="font-semibold text-xs text-[var(--color-text-primary)] mt-0.5">
                      {saveReturningUpdates
                        ? 'Yes, updated contact details will be saved to your profile'
                        : 'No, using today\'s details for this visit only'}
                    </p>
                  </div>
                </div>
              </div>

              {/* Group 2: Visit Details */}
              <div className="rounded-xl bg-[var(--color-surface)] p-4 text-sm border border-[var(--color-border)] space-y-3">
                <div className="flex items-center justify-between border-b border-[var(--color-border)] pb-2">
                  <span className="font-bold text-xs uppercase tracking-wider text-[var(--color-text-secondary)]">
                    Visit Details
                  </span>
                  <button
                    type="button"
                    onClick={() => setStep('returning_confirm')}
                    className="text-xs font-semibold text-[var(--color-brand)] hover:underline"
                  >
                    Edit Details
                  </button>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                  <div className="sm:col-span-2">
                    <span className="text-[var(--color-text-secondary)] block">Purpose of Visit:</span>
                    <p className="font-semibold text-sm text-[var(--color-text-primary)] mt-0.5">
                      {getValues('purpose') || 'Campus Visit'}
                    </p>
                  </div>
                  <div>
                    <span className="text-[var(--color-text-secondary)] block">Visit Date:</span>
                    <p className="font-semibold text-sm text-[var(--color-text-primary)] mt-0.5">
                      {getValues('visitDate') || 'Today'}
                    </p>
                  </div>
                  <div>
                    <span className="text-[var(--color-text-secondary)] block">Arrival Method:</span>
                    <p className="font-semibold text-sm text-[var(--color-text-primary)] mt-0.5">
                      {getValues('arrivalMode') === 'vehicle' ? 'With Vehicle' : 'On Foot / Transit'}
                    </p>
                  </div>
                  {getValues('arrivalMode') === 'vehicle' && (
                    <>
                      <div>
                        <span className="text-[var(--color-text-secondary)] block">Vehicle:</span>
                        <p className="font-semibold text-sm text-[var(--color-text-primary)] mt-0.5">
                          {getValues('plateNumber')} ({getValues('vehicleType')})
                        </p>
                      </div>
                      <div>
                        <span className="text-[var(--color-text-secondary)] block">Color & Model:</span>
                        <p className="font-semibold text-sm text-[var(--color-text-primary)] mt-0.5">
                          {getValues('vehicleColor')} {getValues('makeModel') ? `• ${getValues('makeModel')}` : ''}
                        </p>
                      </div>
                    </>
                  )}
                </div>
              </div>

              {/* Group 3: Portrait and ID History */}
              <div className="rounded-xl bg-[var(--color-surface)] p-4 text-sm border border-[var(--color-border)] space-y-3">
                <span className="font-bold text-xs uppercase tracking-wider text-[var(--color-text-secondary)] block border-b border-[var(--color-border)] pb-2">
                  Portrait and ID History
                </span>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  {/* Original Registration Portrait */}
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold text-[var(--color-text-secondary)] block">
                        Original Registration Portrait
                      </span>
                      {originalPortraitDate && (
                        <span className="text-[10px] text-[var(--color-text-muted)] font-medium">
                          Registered: {new Date(originalPortraitDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                        </span>
                      )}
                    </div>
                    {originalPortraitUrl ? (
                      <div className="rounded-lg overflow-hidden border border-[var(--color-border)] aspect-[3/4] max-h-48 bg-slate-100 flex items-center justify-center">
                        <AuthenticatedImage
                          srcUrl={originalPortraitUrl}
                          authToken={portalToken || portalTransactionRef.current?.token}
                          alt="Original registration portrait"
                          className="h-full w-full object-cover"
                        />
                      </div>
                    ) : (
                      <div className="rounded-lg border border-dashed border-[var(--color-border)] aspect-[3/4] max-h-48 flex items-center justify-center text-xs text-[var(--color-text-muted)] p-3 text-center">
                        Original portrait on file
                      </div>
                    )}
                  </div>

                  {/* Previously Submitted ID */}
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold text-[var(--color-text-secondary)] block">
                        Previously Submitted ID
                      </span>
                      {historicalIdSubmittedDate && (
                        <span className="text-[10px] text-[var(--color-text-muted)] font-medium">
                          Submitted: {new Date(historicalIdSubmittedDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                        </span>
                      )}
                    </div>
                    {loadingHistoricalId ? (
                      <div className="rounded-lg border border-[var(--color-border)] aspect-[3/4] max-h-48 bg-slate-50 flex flex-col items-center justify-center text-center p-3 text-xs text-[var(--color-text-secondary)]">
                        <Loader2 className="w-5 h-5 animate-spin text-[#7A0A0A] mb-2" />
                        <span>Loading previously submitted ID…</span>
                      </div>
                    ) : historicalIdPreview ? (
                      <div className="rounded-lg overflow-hidden border border-[var(--color-border)] aspect-[3/4] max-h-48 bg-slate-100 flex items-center justify-center">
                        <img
                          src={historicalIdPreview}
                          alt="Previously submitted ID document"
                          className="h-full w-full object-cover"
                        />
                      </div>
                    ) : (
                      <div className="rounded-lg border border-amber-200 bg-amber-50/70 aspect-[3/4] max-h-48 flex flex-col items-center justify-center text-center p-3 text-xs text-amber-900">
                        <Info className="w-5 h-5 text-amber-700 mb-1.5" />
                        <span className="font-semibold">Previous ID document is on file with campus records.</span>
                      </div>
                    )}
                  </div>

                  {/* Current Vehicle Photo if applicable */}
                  {getValues('arrivalMode') === 'vehicle' && vehiclePhotoPreview && (
                    <div className="sm:col-span-2 space-y-1.5 pt-2 border-t border-[var(--color-border)]">
                      <span className="text-xs font-semibold text-[var(--color-text-secondary)] block">
                        Today's Vehicle Photo
                      </span>
                      <div className="rounded-lg overflow-hidden border border-[var(--color-border)] aspect-video max-h-40 bg-slate-100 flex items-center justify-center">
                        <img
                          src={vehiclePhotoPreview}
                          alt="Today's vehicle photo"
                          className="h-full w-full object-cover"
                        />
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* Action Buttons */}
              <div className="flex gap-3 pt-2">
                <Button
                  variant="secondary"
                  onClick={() => setStep('returning_confirm')}
                  className="flex-1"
                  icon={<ArrowLeft className="h-4 w-4" />}
                >
                  Edit Visit Details
                </Button>
                <Button
                  onClick={onSubmit}
                  disabled={!identityVerified || currentPhase === 'existing_pass_conflict'}
                  className="flex-1"
                  icon={<CheckCircle2 className="h-4 w-4" />}
                >
                  {visitType === 'specific_person'
                    ? 'Submit Request for Office Approval'
                    : 'Generate E-GatePass'}
                </Button>
              </div>
            </div>
          )}

          {/* ============================== STEP 7: GENERATING ============================== */}
          {step === 'generating' && (
            <div role="status" aria-live="polite" aria-label="Generating gate pass" className="py-16 text-center space-y-4">
              {qrRenderingError ? (
                <div className="space-y-4 max-w-md mx-auto">
                  <AlertCircle className="mx-auto h-12 w-12 text-amber-600" />
                  <h3 className="text-lg font-bold text-[var(--color-text-primary)]">Pass Issued — QR Generation Paused</h3>
                  <p className="text-sm text-[var(--color-text-secondary)]">
                    Your pass was safely recorded, but preparing the visual QR image encountered an issue. Click below to render your QR code.
                  </p>
                  <Button
                    type="button"
                    onClick={handleRetryQrRendering}
                    className="w-full bg-[#7A0A0A] hover:bg-[#5C0808] text-white font-semibold py-2.5 rounded-xl shadow-sm"
                  >
                    Retry QR Code Rendering
                  </Button>
                </div>
              ) : (
                <>
                  <Loader2 className="mx-auto h-12 w-12 animate-spin text-[var(--color-brand)]" />
                  <h3 className="text-lg font-bold text-[var(--color-text-primary)]">Issuing Official E-GatePass…</h3>
                  <p className="text-sm text-[var(--color-text-secondary)]">Securing your pass record and generating QR token.</p>
                </>
              )}
            </div>
          )}

          {/* ============================== SPECIFIC-PERSON REQUEST SUBMITTED SCREEN ============================== */}
          {step === 'request_submitted' && (
            <div className="space-y-6">
              <div className="text-center">
                <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-amber-100 text-amber-700 shadow-xs">
                  <Clock3 className="h-8 w-8" />
                </div>
                <h2 className="text-xl font-black text-[var(--color-text-primary)] mt-3">Visit Request Submitted!</h2>
                <div className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-amber-100 px-3 py-1 text-xs font-extrabold uppercase tracking-wide text-amber-800">
                  <Clock className="h-3.5 w-3.5" />
                  <span>Pending Office Approval</span>
                </div>
                <p className="text-sm text-[var(--color-text-secondary)] mt-2 max-w-md mx-auto">
                  Your appointment request has been securely submitted for review.
                </p>
              </div>

              <div className="rounded-2xl border border-[var(--color-border)] bg-white p-5 shadow-xs space-y-4">
                <div className="border-b border-[var(--color-border)] pb-3">
                  <span className="text-xs font-bold uppercase tracking-wider text-[var(--color-text-secondary)] block">
                    Request Summary
                  </span>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
                  <div>
                    <span className="text-[var(--color-text-secondary)] block">Target Office:</span>
                    <p className="font-bold text-sm text-[var(--color-text-primary)] mt-0.5">
                      {submittedRequestData?.officeName}
                    </p>
                  </div>
                  <div>
                    <span className="text-[var(--color-text-secondary)] block">Personnel / Faculty:</span>
                    <p className="font-bold text-sm text-[#7A0A0A] mt-0.5">
                      {submittedRequestData?.personnelName}
                    </p>
                  </div>
                  <div>
                    <span className="text-[var(--color-text-secondary)] block">Scheduled Date:</span>
                    <p className="font-bold text-sm text-[var(--color-text-primary)] mt-0.5">
                      {submittedRequestData?.visitDate}
                    </p>
                  </div>
                  <div>
                    <span className="text-[var(--color-text-secondary)] block">Verified Visitor Email:</span>
                    <p className="font-bold text-sm text-emerald-700 mt-0.5 flex items-center gap-1">
                      <CheckCircle2 className="h-3.5 w-3.5" />
                      {submittedRequestData?.visitorEmail}
                    </p>
                  </div>
                </div>

                <div className="rounded-xl border border-amber-200 bg-amber-50/70 p-4 text-xs text-amber-950 space-y-2">
                  <p className="font-bold text-amber-900">What happens next?</p>
                  <p className="leading-relaxed">
                    1. <strong>No QR pass is issued yet.</strong> Specific-person appointments require authorization from the designated office personnel.
                  </p>
                  <p className="leading-relaxed">
                    2. Once the office reviews and <strong>approves</strong> your request, an official digital gate pass with a scannable QR code will be emailed directly to <strong>{submittedRequestData?.visitorEmail}</strong>.
                  </p>
                  <p className="leading-relaxed">
                    3. If the appointment is rejected, you will receive an email explaining the office&apos;s reason.
                  </p>
                  <div className="mt-3 pt-2 border-t border-amber-200 text-amber-900 leading-relaxed font-medium">
                    <strong>Attendance Notice:</strong> After entering the campus, proceed to the office and inform the specific person or office staff that you have arrived. Ask them to confirm your arrival so your office visit is recorded. A gate scan alone is not proof of office attendance.
                  </div>
                </div>

                {/* Email Delivery Status Card */}
                {submittedRequestData?.visitorEmail && (
                  <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-xs space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="font-bold text-slate-900">Submission Acknowledgement Email</span>
                      {(() => {
                        const status = submittedRequestData.emailDeliveryStatus || 'pending';
                        if (status === 'delivered') {
                          return (
                            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 text-emerald-800 text-[10px] font-bold px-2 py-0.5">
                              <CheckCircle2 className="h-3 w-3" /> Delivered
                            </span>
                          );
                        }
                        if (status === 'sent') {
                          return (
                            <span className="inline-flex items-center gap-1 rounded-full bg-blue-100 text-blue-800 text-[10px] font-bold px-2 py-0.5">
                              <CheckCircle2 className="h-3 w-3" /> Sent to Provider
                            </span>
                          );
                        }
                        if (status === 'failed') {
                          return (
                            <span className="inline-flex items-center gap-1 rounded-full bg-rose-100 text-rose-800 text-[10px] font-bold px-2 py-0.5">
                              <AlertTriangle className="h-3 w-3" /> Delivery Issue
                            </span>
                          );
                        }
                        return (
                          <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 text-amber-800 text-[10px] font-bold px-2 py-0.5">
                            <Clock className="h-3 w-3" /> Processing
                          </span>
                        );
                      })()}
                    </div>
                    <p className="text-slate-600 leading-relaxed">
                      {(() => {
                        const status = submittedRequestData.emailDeliveryStatus || 'pending';
                        if (status === 'delivered') return `Delivery confirmed to ${submittedRequestData.visitorEmail}. Check your inbox for your tracking confirmation.`;
                        if (status === 'sent') return `Tracking confirmation email accepted by the email provider for delivery to ${submittedRequestData.visitorEmail}.`;
                        if (status === 'failed') return `Email dispatch encountered an issue. Please save your private tracking link below to monitor your request status.`;
                        return `Your submission acknowledgement email is currently queued for delivery to ${submittedRequestData.visitorEmail}.`;
                      })()}
                    </p>
                  </div>
                )}

                {submittedRequestData?.trackingUrl && (
                  <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-xs space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="font-bold text-slate-900 flex items-center gap-1.5">
                        <Clock className="h-4 w-4 text-amber-600" />
                        Track Request Status Online
                      </span>
                      <span className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide">Account-Free</span>
                    </div>
                    <p className="text-slate-600 leading-relaxed">
                      You can monitor your review status anytime using this link:
                    </p>
                    {submittedRequestData.trackingToken && (
                      <div className="text-[11px] font-mono bg-white p-2 rounded-lg border border-slate-200 text-slate-800">
                        Tracking Token: <span className="font-bold">{submittedRequestData.trackingToken}</span>
                      </div>
                    )}
                    <div className="pt-1 flex flex-col sm:flex-row gap-2">
                      <a
                        href={submittedRequestData.trackingUrl}
                        className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-[#700f14] px-4 py-2 text-xs font-bold text-white hover:bg-[#851218] transition-colors shadow-xs"
                      >
                        <Clock className="h-3.5 w-3.5" />
                        <span>Open Status Tracker</span>
                      </a>
                      <button
                        type="button"
                        onClick={async () => {
                          try {
                            if (submittedRequestData.trackingUrl) {
                              await navigator.clipboard.writeText(submittedRequestData.trackingUrl);
                              toast.success('Tracking link copied to clipboard!');
                            }
                          } catch {
                            toast.error('Failed to copy link. Please copy the URL directly.');
                          }
                        }}
                        className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-300 bg-white px-4 py-2 text-xs font-bold text-slate-800 hover:bg-slate-100 transition-colors shadow-xs"
                      >
                        <Copy className="h-3.5 w-3.5 text-slate-600" />
                        <span>Copy Tracking Link</span>
                      </button>
                    </div>
                  </div>
                )}
              </div>

              <div className="flex flex-col sm:flex-row gap-3 pt-2">
                <Button
                  onClick={() => {
                    window.location.href = '/';
                  }}
                  className="flex-1"
                  icon={<CheckCircle2 className="h-4 w-4" />}
                >
                  Done / Return to Home
                </Button>
                <Button
                  variant="secondary"
                  onClick={handleStartOver}
                  className="flex-1"
                  icon={<RotateCcw className="h-4 w-4" />}
                >
                  Register Another Visit
                </Button>
              </div>
            </div>
          )}

          {/* ============================== STEP 8: DELIVERY / DONE ============================== */}
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
                  <p className="font-semibold text-sm text-emerald-950">Email Submitted Successfully</p>
                  <p>A copy of your E-GatePass was submitted to the email provider for your verified email. Please check your inbox and spam folder.</p>
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
                  <Suspense fallback={<div className="h-64 w-full animate-pulse bg-gray-100 rounded-2xl" />}>
                    <InstitutionalPassCard presentation={passPresentation} qrDataUrl={qrDataUrl} />
                  </Suspense>
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

          {/* Persistent security verification widget shared across all registration phases */}
          <TurnstileWidget
            ref={turnstileRef}
            execution="execute"
            appearance="interaction-only"
          />
        </Card>
      )}

      {/* Returning Visitor Safety Gate Modal */}
      {showReturningGateModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl space-y-4">
            <div className="flex items-center gap-3 text-amber-900">
              <div className="h-10 w-10 rounded-xl bg-amber-100 flex items-center justify-center text-amber-700 flex-shrink-0">
                <ShieldAlert className="h-5 w-5" />
              </div>
              <div>
                <h3 className="font-bold text-base text-[var(--color-text-primary)]">Biometric Verification Setup Pending</h3>
                <p className="text-xs text-[var(--color-text-secondary)]">Production Readiness Gate Enforced</p>
              </div>
            </div>

            <div className="text-xs text-[var(--color-text-secondary)] space-y-2 leading-relaxed">
              <p>
                Returning visitor 1:1 facial verification requires physical camera calibration on EARIST gate hardware and cryptographic key provisioning before it can be safely activated in production.
              </p>
              <p>
                To maintain campus security standards and avoid false rejections or unauthorized entry, this feature remains gated until physical campus testing is complete.
              </p>
              <p className="font-medium text-[var(--color-text-primary)]">
                Please register as a New Visitor to receive your official E-GatePass today.
              </p>
            </div>

            {capabilitiesDiagnostics && (
              <div className="rounded-xl border border-amber-200 bg-amber-50/60 p-3 text-[11px] space-y-1.5 text-amber-900">
                <div className="font-semibold text-amber-950">Readiness Breakdown:</div>
                <div className="flex items-center justify-between">
                  <span>Facial Model Inference Engine:</span>
                  <span className="font-bold">{capabilitiesDiagnostics.facialRecognitionConfigured ? 'Ready' : 'Pending'}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span>Facial Profile Enrollment:</span>
                  <span className="font-bold">{capabilitiesDiagnostics.returningEnrollmentAvailable ? 'Ready' : 'Pending Provisioning'}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span>Template Crypto Keys:</span>
                  <span className="font-bold">{capabilitiesDiagnostics.returningCryptoConfigured ? 'Configured' : 'Pending Provisioning'}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span>Verification Threshold:</span>
                  <span className="font-bold">
                    {capabilitiesDiagnostics.thresholdMode === 'calibrated'
                      ? 'Calibrated'
                      : capabilitiesDiagnostics.thresholdMode === 'provisional'
                      ? 'Provisional (0.363)'
                      : 'Pending Calibration'}
                  </span>
                </div>
                <div className="flex items-center justify-between border-t border-amber-200/80 pt-1 mt-1">
                  <span>Verification Status:</span>
                  <span className="font-bold">
                    {capabilitiesDiagnostics.returningVisitorAvailable
                      ? (capabilitiesDiagnostics.thresholdMode === 'provisional' ? 'Active (Provisional)' : 'Active')
                      : 'Setup Pending'}
                  </span>
                </div>
              </div>
            )}

            <div className="flex gap-3 pt-2">
              <Button
                variant="secondary"
                onClick={() => setShowReturningGateModal(false)}
                className="flex-1"
              >
                Close
              </Button>
              <Button
                onClick={() => {
                  setShowReturningGateModal(false);
                  beginNewVisitorSetup();
                }}
                className="flex-1"
                icon={<ArrowRight className="h-4 w-4" />}
              >
                Register as New Visitor
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Email Pass Modal */}
      {passId && (
        <Suspense fallback={null}>
          <EmailPassModal
            isOpen={showEmailModal && !showSkipWarning}
            onClose={() => setShowEmailModal(false)}
            passId={passId || ''}
            qrToken={rawQrToken || ''}
            source="portal"
            mode={step === 'delivery' ? 'delivery-gate' : 'modal'}
            onSuccess={() => {
              setEmailDeliverySecured(true);
              setEmailOutcomeUnknown(false);
              setEmailSkipped(false);
              setShowEmailModal(false);
              setStep('done');
            }}
            onUnknown={() => {
              setEmailDeliverySecured(false);
              setEmailOutcomeUnknown(true);
              setEmailSkipped(false);
              setShowEmailModal(false);
              setStep('done');
            }}
            onSkip={() => setShowSkipWarning(true)}
          />
        </Suspense>
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

      {/* Automatic Returning Visitor Candidate Match Modal */}
      {showCandidateMatchModal && candidateMatch && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-xs animate-in fade-in duration-200">
          <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl border border-[var(--color-border)] space-y-4">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-xl bg-amber-100 text-amber-900 flex items-center justify-center shrink-0">
                <UserCheck className="h-5 w-5 text-[#7A0A0A]" />
              </div>
              <div>
                <h3 className="font-bold text-base text-[var(--color-text-primary)]">
                  You may have visited EARIST before!
                </h3>
                <p className="text-xs text-[var(--color-text-secondary)] mt-0.5">
                  We found a matching visitor profile from a previous campus visit.
                </p>
              </div>
            </div>

            <div className="rounded-xl border border-amber-200/80 bg-amber-50/50 p-4 space-y-3">
              <div className="flex items-center gap-4">
                {candidateMatch.previewUrl ? (
                  <div className="h-16 w-16 rounded-xl overflow-hidden border border-amber-300 bg-slate-100 shrink-0">
                    <AuthenticatedImage
                      srcUrl={candidateMatch.previewUrl}
                      authToken={portalToken || portalTransactionRef.current?.token}
                      alt="Previous visit photo preview"
                      className="h-full w-full object-cover"
                    />
                  </div>
                ) : (
                  <div className="h-16 w-16 rounded-xl border border-dashed border-amber-300 bg-amber-100/50 flex items-center justify-center shrink-0">
                    <User className="h-7 w-7 text-amber-800" />
                  </div>
                )}
                <div className="min-w-0 flex-1 space-y-1 text-xs">
                  <div>
                    <span className="text-[var(--color-text-muted)] block text-[10px] uppercase font-semibold">Matched Name</span>
                    <p className="font-bold text-sm text-[var(--color-text-primary)] truncate">{candidateMatch.maskedName}</p>
                  </div>
                  <div>
                    <span className="text-[var(--color-text-muted)] block text-[10px] uppercase font-semibold">Contact & Locality</span>
                    <p className="text-[var(--color-text-secondary)] font-medium">
                      {candidateMatch.maskedContact} • {candidateMatch.partialLocality || 'Manila'}
                    </p>
                  </div>
                  {candidateMatch.registeredAt && (
                    <p className="text-[10px] text-amber-800 font-medium">
                      First visit: {new Date(candidateMatch.registeredAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                    </p>
                  )}
                </div>
              </div>
              <p className="text-[11px] text-amber-900 leading-relaxed border-t border-amber-200/60 pt-2">
                Verify with a quick live selfie against your original portrait to skip ID upload and use your saved preferences.
              </p>
            </div>

            <div className="flex flex-col sm:flex-row gap-2.5 pt-2">
              <Button
                variant="primary"
                onClick={onAcceptReturningCandidate}
                className="flex-1 justify-center"
                icon={<UserCheck className="h-4 w-4" />}
              >
                Verify as Returning Visitor
              </Button>
              <Button
                variant="secondary"
                onClick={onDeclineReturningCandidate}
                className="flex-1 justify-center"
                icon={<UserPlus className="h-4 w-4" />}
              >
                Continue as New Visitor
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Returning Visitor Biometric Verification Failure Warning Modal */}
      {showBiometricFailureModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-xs animate-in fade-in duration-200">
          <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl border border-rose-200 space-y-4">
            <div className="flex items-center gap-3 text-rose-900">
              <div className="h-10 w-10 rounded-xl bg-rose-100 flex items-center justify-center text-rose-700 shrink-0">
                <AlertTriangle className="h-5 w-5" />
              </div>
              <div>
                <h3 className="font-bold text-base text-[var(--color-text-primary)]">Biometric Verification Unsuccessful</h3>
                <p className="text-xs text-[var(--color-text-secondary)]">Photo did not match enrolled template</p>
              </div>
            </div>

            <p className="text-xs text-[var(--color-text-secondary)] leading-relaxed">
              {returningIdentifyError || 'We could not verify your live photo against your previously enrolled facial profile. You can retry capturing your selfie with better lighting, or continue as a new visitor.'}
            </p>

            <div className="pt-2 flex flex-col sm:flex-row gap-3 justify-end">
              <Button
                variant="secondary"
                onClick={() => {
                  setShowBiometricFailureModal(false);
                  onRetakeReturningSelfie();
                }}
                icon={<RotateCcw className="h-4 w-4" />}
              >
                Retry Biometric Match
              </Button>
              <Button
                variant="primary"
                onClick={() => {
                  setShowBiometricFailureModal(false);
                  beginNewVisitorSetup();
                }}
                icon={<UserPlus className="h-4 w-4" />}
              >
                Continue as New Visitor
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Institutional Data Privacy Notice Modal */}
      {showPrivacyModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-xs animate-in fade-in duration-200">
          <div className="w-full max-w-lg max-h-[85vh] rounded-2xl bg-white p-6 shadow-2xl border border-[var(--color-border)] flex flex-col space-y-4">
            <div className="flex items-center justify-between border-b border-[var(--color-border)] pb-3">
              <div className="flex items-center gap-2.5">
                <div className="h-9 w-9 rounded-xl bg-[#7A0A0A]/10 text-[#7A0A0A] flex items-center justify-center shrink-0">
                  <ShieldCheck className="h-5 w-5" />
                </div>
                <div>
                  <h3 className="font-bold text-base text-[var(--color-text-primary)]">
                    Institutional Data Privacy Notice
                  </h3>
                  <p className="text-[11px] text-[var(--color-text-secondary)]">
                    Eulogio "Amang" Rodriguez Institute of Science and Technology (EARIST)
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setShowPrivacyModal(false)}
                className="text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] p-1 rounded-lg hover:bg-slate-100"
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
                    Face photos are normally retained for{' '}
                    {typeof photoRetentionDays === 'number' ? `${photoRetentionDays} days` : '30 days'}{' '}
                    under institutional policy.
                  </li>
                  <li>
                    Valid ID images, when collected, are normally retained for{' '}
                    {typeof idRetentionDays === 'number' ? `${idRetentionDays} days` : '30 days'}{' '}
                    under institutional policy.
                  </li>
                  <li>
                    Visitor records are retained for{' '}
                    {typeof visitorRetentionDays === 'number' ? `${visitorRetentionDays} days` : '90 days'}{' '}
                    under institutional policy.
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
                onClick={() => setShowPrivacyModal(false)}
                className="w-full sm:w-auto"
              >
                I Understand
              </Button>
            </div>
          </div>
        </div>
      )}
    </PageShell>
  );
}
