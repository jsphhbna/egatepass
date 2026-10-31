import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
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
  PortalSessionError,
  type PortalIssueTransaction,
  type AddressProvenance,
} from '@/services/visitorRegistration';
import { TurnstileWidget, type TurnstileWidgetRef } from '@/components/TurnstileWidget';
import { generateBrandedQrDataUrl } from '@/lib/brandedQr';
import QRCode from 'qrcode';
import { recognizeIdImage, terminateLocalOcrWorker, getNextOcrJobId } from '@/lib/ocr';
import { evaluateLiveFaceQuality, evaluateIdImageQuality } from '@/lib/imageQuality';
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
  MapPin,
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

export interface AddressSuggestionDto {
  placeId: string;
  formatted: string;
  addressLine1?: string;
  city?: string;
  state?: string;
  postcode?: string;
  countryCode: 'ph';
  lat: number;
  lon: number;
  resultType: string;
  confidence?: number;
}

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
      homeAddress: z
        .string()
        .trim()
        .min(5, 'Please select a verified home address from search suggestions')
        .max(300, 'Home address is too long'),
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
    })
    .superRefine((data, ctx) => {
      if (data.arrivalMode === 'vehicle') {
        if (!data.vehicleType || data.vehicleType.trim() === '') {
          ctx.addIssue({
            path: ['vehicleType'],
            code: z.ZodIssueCode.custom,
            message: 'Please select a vehicle type',
          });
        }
        const plateRes = normalizeVehiclePlate(data.plateNumber || '');
        if (!plateRes.valid) {
          ctx.addIssue({
            path: ['plateNumber'],
            code: z.ZodIssueCode.custom,
            message: plateRes.error || 'Please enter a valid plate number',
          });
        }
        if (!data.vehicleColor || data.vehicleColor.trim().length < 2) {
          ctx.addIssue({
            path: ['vehicleColor'],
            code: z.ZodIssueCode.custom,
            message: 'Please enter vehicle color',
          });
        }
        if (!data.makeModel || data.makeModel.trim().length < 2 || data.makeModel.trim().length > 100) {
          ctx.addIssue({
            path: ['makeModel'],
            code: z.ZodIssueCode.custom,
            message: 'Vehicle make and model must be between 2 and 100 characters',
          });
        }
      }
    });
}

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
  | 'returning_capture'
  | 'returning_confirm';

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
  const [showReturningGateModal, setShowReturningGateModal] = useState(false);

  // Returning visitor profile state
  const [returningProfile, setReturningProfile] = useState<{
    profileId: string;
    fullName: string;
    firstName: string;
    middleName?: string;
    lastName: string;
    contactNumber: string;
    homeAddress?: string;
    matchToken: string;
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
  const [rememberVisitor, setRememberVisitor] = useState(false);
  const [saveVehicle, setSaveVehicle] = useState(false);

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

  // Address Search & Autocomplete State
  const [addressQuery, setAddressQuery] = useState('');
  const [addressSuggestions, setAddressSuggestions] = useState<AddressSuggestionDto[]>([]);
  const [isSearchingAddress, setIsSearchingAddress] = useState(false);
  const [selectedAddress, setSelectedAddress] = useState<AddressSuggestionDto | null>(null);
  const [addressDetail, setAddressDetail] = useState('');
  const [addressSearchError, setAddressSearchError] = useState<string | null>(null);
  const addressCacheRef = useRef<Map<string, AddressSuggestionDto[]>>(new Map());
  const activeSearchRef = useRef<{ query: string; controller: AbortController } | null>(null);

  // Controlled Vehicle Catalog State
  const [availableMakes, setAvailableMakes] = useState<string[]>([]);
  const [selectedMake, setSelectedMake] = useState<string>('');
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [selectedModel, setSelectedModel] = useState<string>('');
  const [customMakeModel, setCustomMakeModel] = useState<string>('');
  const [isManualVehicle, setIsManualVehicle] = useState<boolean>(false);
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

  // Query capabilities on mount for returning visitor gate
  useEffect(() => {
    fetch('/api/passes/capabilities')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        setReturningAvailable(Boolean(data?.returningVisitorAvailable));
      })
      .catch(() => {
        setReturningAvailable(false);
      });
  }, []);

  function onRetakeId() {
    invalidatePortalEvidenceCheckpoint(portalTransactionRef.current, 'id');
    setIdBlob(null);
    idUrl.clear();
    setIdReusedFromOcr(false);
    setIdentityVerified(false);
    setVerificationError(null);
    setIdQualityError(null);
    setStep('id');
  }

  function resetRegistrationFlow() {
    ocrGenerationRef.current += 1;
    void terminateLocalOcrWorker();
    invalidatePortalEvidenceCheckpoint(portalTransactionRef.current, 'photo');
    invalidatePortalEvidenceCheckpoint(portalTransactionRef.current, 'id');
    invalidatePortalEvidenceCheckpoint(portalTransactionRef.current, 'vehicle');
    portalTransactionRef.current = null;
    livePhotoIntentIdRef.current = null;
    setStep('arrival_setup');
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
    setSelectedAddress(null);
    setAddressQuery('');
    setAddressSuggestions([]);
    setSetupArrivalMode(null);
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
    trigger,
    getValues,
    setValue,
    watch,
    formState: { errors },
  } = useForm<GetPassFormData>({
    resolver: zodResolver(formSchema),
    mode: 'onChange',
    defaultValues: {
      purpose: '',
      arrivalMode: (validArrival || undefined) as any,
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
    setValue('plateNumber', '');
    setValue('vehicleColor', '');
    setValue('makeModel', '');
    setValue('vehicleType', 'car');
    setSelectedMake('');
    setSelectedModel('');
    setCustomMakeModel('');
    setIsManualVehicle(false);
    setVehiclePhotoBlob(null);
    vehiclePhotoUrl.clear();
    setVehiclePhotoError(null);
    invalidatePortalEvidenceCheckpoint(portalTransactionRef.current, 'vehicle');
    if (vehicleFileInputRef.current) {
      vehicleFileInputRef.current.value = '';
    }
  }

  // Address autocomplete debounced search effect
  useEffect(() => {
    const trimmed = addressQuery.trim();
    if (selectedAddress || trimmed.length < 4) {
      setAddressSuggestions([]);
      setIsSearchingAddress(false);
      return;
    }

    const cached = addressCacheRef.current.get(trimmed.toLowerCase());
    if (cached) {
      setAddressSuggestions(cached);
      setIsSearchingAddress(false);
      setAddressSearchError(null);
      return;
    }

    const controller = new AbortController();
    activeSearchRef.current = { query: trimmed, controller };

    const timer = setTimeout(async () => {
      setIsSearchingAddress(true);
      setAddressSearchError(null);
      try {
        const res = await fetch(`/api/address/autocomplete?q=${encodeURIComponent(trimmed)}`, {
          signal: controller.signal,
        });
        if (!res.ok) {
          if (res.status === 429) {
            setAddressSearchError('Address search rate limit reached. Please wait a moment.');
          } else {
            setAddressSearchError('Address suggestions temporarily unavailable.');
          }
          setAddressSuggestions([]);
          return;
        }
        const data = await res.json();
        const suggestions = Array.isArray(data?.suggestions)
          ? data.suggestions
          : Array.isArray(data)
            ? data
            : [];
        addressCacheRef.current.set(trimmed.toLowerCase(), suggestions);
        if (activeSearchRef.current?.query === trimmed) {
          setAddressSuggestions(suggestions);
        }
      } catch (err: any) {
        if (err.name === 'AbortError') return;
        setAddressSearchError('Unable to connect to address search service.');
        setAddressSuggestions([]);
      } finally {
        if (activeSearchRef.current?.query === trimmed) {
          setIsSearchingAddress(false);
        }
      }
    }, 350);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [addressQuery, selectedAddress]);

  // Vehicle makes and models loading
  const selectedVehicleType = watch('vehicleType') || 'car';

  useEffect(() => {
    let active = true;
    setIsLoadingMakes(true);
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
        if (!list.includes(selectedMake) && selectedMake !== 'Other / Not Listed') {
          setSelectedMake(list[0] || 'Other / Not Listed');
        }
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
    if (!selectedMake || selectedMake === 'Other / Not Listed') {
      setAvailableModels([]);
      setIsManualVehicle(true);
      return;
    }
    let active = true;
    setIsLoadingModels(true);
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
        if (!list.includes(selectedModel) && selectedModel !== 'Other / Not Listed') {
          setSelectedModel(list[0] || 'Other / Not Listed');
        }
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
    if (isManualVehicle) {
      setValue('makeModel', customMakeModel.trim());
    } else {
      const full = [selectedMake, selectedModel].filter((x) => x && x !== 'Other / Not Listed').join(' ');
      setValue('makeModel', full);
    }
  }, [isManualVehicle, customMakeModel, selectedMake, selectedModel, setValue]);

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
    if (!selectedAddress) {
      toast.error('Please search and select a verified home address from the suggestions.');
      return;
    }
    if (!data.consent) {
      toast.error('You must accept the Data Privacy Act notice to proceed.');
      return;
    }

    setStep('visit');
  }

  // ============================================================
  // STEP 2: VISIT & VEHICLE DETAILS (onVisitNext advances to Photo)
  // ============================================================
  async function onVisitNext() {
    const vals = getValues();
    if (!vals.purpose || vals.purpose.trim().length < 3) {
      toast.error('Please describe the purpose of your visit (minimum 3 characters).');
      return;
    }
    if (!vals.visitDate) {
      toast.error('Please select a visit date.');
      return;
    }

    if (vals.arrivalMode === 'vehicle') {
      if (!vals.vehicleType || vals.vehicleType.trim() === '') {
        toast.error('Please select a vehicle type.');
        return;
      }
      const plateRes = normalizeVehiclePlate(vals.plateNumber || '');
      if (!plateRes.valid) {
        toast.error(plateRes.error || 'Please enter a valid plate number.');
        return;
      }
      setValue('plateNumber', plateRes.displayPlate, { shouldValidate: true });
      if (!vals.vehicleColor || vals.vehicleColor.trim().length < 2) {
        toast.error('Please specify the vehicle color.');
        return;
      }
      if (!vals.makeModel || vals.makeModel.trim().length < 2 || vals.makeModel.trim().length > 100) {
        toast.error('Please specify the vehicle make and model (2-100 characters).');
        return;
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
      portalTransactionRef.current = null;
      livePhotoIntentIdRef.current = null;
    }

    setIsStartingRegistration(true);
    try {
      let freshCaptchaToken: string | undefined;
      if (turnstileRef.current) {
        freshCaptchaToken = await turnstileRef.current.executeChallenge();
      }

      const tx = await createPortalIssueTransaction(freshCaptchaToken);
      portalTransactionRef.current = tx;
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
  // RETURNING VISITOR CAPTURE & IDENTIFY
  // ============================================================
  async function onCaptureReturningFace() {
    const blob = faceWebcam.capture({ mirror: false });
    if (!blob) {
      toast.error('Failed to capture photo. Please hold steady and try again.');
      return;
    }

    setIsIdentifyingReturning(true);
    setReturningIdentifyError(null);

    try {
      let freshCaptchaToken: string | undefined;
      if (turnstileRef.current) {
        freshCaptchaToken = await turnstileRef.current.executeChallenge();
      }

      const formData = new FormData();
      formData.append('photo', blob, 'face.jpg');
      if (freshCaptchaToken) formData.append('captchaToken', freshCaptchaToken);

      const res = await fetch('/api/passes/identify-returning', {
        method: 'POST',
        body: formData,
      });

      const data = await res.json().catch(() => null);

      if (!res.ok || !data?.matched) {
        setReturningIdentifyError(
          data?.message || 'We could not find a matching profile. Please register as a New Visitor.'
        );
        return;
      }

      // Profile matched!
      setReturningProfile({
        profileId: data.profile.id,
        fullName: data.profile.fullName,
        firstName: data.profile.firstName,
        middleName: data.profile.middleName,
        lastName: data.profile.lastName,
        contactNumber: data.profile.contactNumber,
        homeAddress: data.profile.homeAddress,
        matchToken: data.matchToken,
        savedVehicles: data.profile.savedVehicles || [],
      });

      // Prepopulate form values
      setValue('firstName', data.profile.firstName, { shouldValidate: true });
      if (data.profile.middleName) setValue('middleName', data.profile.middleName);
      setValue('lastName', data.profile.lastName, { shouldValidate: true });
      setValue('contactNumber', data.profile.contactNumber, { shouldValidate: true });
      if (data.profile.homeAddress) setValue('homeAddress', data.profile.homeAddress, { shouldValidate: true });

      setPhotoBlob(blob);
      photoUrl.setFromBlob(blob);
      setIdentityVerified(true);
      faceWebcam.stop();

      // If they have saved vehicles, default to the first one or 'none'
      if (data.profile.savedVehicles && data.profile.savedVehicles.length > 0) {
        const firstVeh = data.profile.savedVehicles[0];
        setSelectedSavedVehicleId(firstVeh.id);
        setValue('arrivalMode', 'vehicle');
        setValue('vehicleType', firstVeh.vehicleType);
        setValue('plateNumber', firstVeh.plateNumber);
        setValue('vehicleColor', firstVeh.color);
        setValue('makeModel', firstVeh.makeModel || '');
      } else {
        setSelectedSavedVehicleId('none');
        setValue('arrivalMode', 'no_vehicle');
      }

      setStep('returning_confirm');
      toast.success(`Welcome back, ${data.profile.firstName}!`);
    } catch (err: any) {
      setReturningIdentifyError(err?.message || 'Identification failed. Please try again or register as a New Visitor.');
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
    if (!vals.homeAddress || vals.homeAddress.trim().length < 5) {
      toast.error('Please enter your complete home address.');
      return;
    }
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
    }

    setStep('review');
  }

  // ============================================================
  // OPTIONAL OCR EXTRACTION (In Memory)
  // ============================================================
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

      invalidatePortalEvidenceCheckpoint(portalTransactionRef.current, 'id');
      setIdBlob(normalized);
      idUrl.setFromBlob(normalized);
      setIdReusedFromOcr(true);
      setIdQualityError(null);

      // Invalidate existing verified state if ID changes
      setIdentityVerified(false);
      setVerificationError(null);

      // 2. Perform local OCR recognition in browser memory: recognizeIdImage(file)
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
      if (err instanceof PortalSessionError || err?.code?.startsWith?.('portal_session') || msg.includes('session') || msg.includes('visitor registration')) {
        setLiveFaceError({
          category: 'session',
          title: 'Registration Session Error',
          message: 'Your visitor registration session changed or expired. Please continue again to securely restart this registration.',
          reasonCode: err?.code || 'portal_session_mismatch',
        });
        const tx = portalTransactionRef.current;
        portalTransactionRef.current = null;
        livePhotoIntentIdRef.current = null;
        if (tx) {
          invalidatePortalEvidenceCheckpoint(tx, 'photo');
          invalidatePortalEvidenceCheckpoint(tx, 'id');
        }
        setStep('form');
        toast.error('Registration session expired. Returning to visitor details.');
        return;
      }
      if (msg.includes('upload') || msg.includes('authorized') || msg.includes('403') || msg.includes('401') || msg.includes('visitor identity required')) {
        setLiveFaceError({
          category: 'upload',
          title: 'Photo Upload Error',
          message: 'The photo could not be authorized for this visitor session. Please restart the registration session and try again.',
          reasonCode: 'upload_intent_unauthorized',
        });
        toast.error('Photo upload could not be authorized.');
        return;
      }
      if (msg.includes('network') || msg.includes('fetch') || msg.includes('timeout') || msg.includes('failed to fetch')) {
        setLiveFaceError({
          category: 'network',
          title: 'Connection Problem',
          message: 'Network interruption occurred while communicating with the server. Please check your connection and try again.',
          reasonCode: 'network_interruption',
        });
        toast.error('Network connection problem.');
        return;
      }
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
        portalTransactionRef.current = null;
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
    portalTransactionRef.current = null;
    livePhotoIntentIdRef.current = null;
    issueRequestId.current = crypto.randomUUID();
    setRegistrationMode('new');
    resetRegistrationFlow();
    setStep('frontdoor');
  }

  function handleAmbiguousCancelAndAskGuard() {
    toast.info('Submission cancelled. The previous pass may have been created. Please proceed to the Guard Station with your valid ID for assistance.');
    setStep('form');
  }

  function handleRetryExactSubmission() {
    void onSubmit();
  }

  // ============================================================
  // STEP 6: PASS ISSUANCE (onSubmit)
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

      const addressProv: AddressProvenance | undefined = selectedAddress ? {
        provider: 'geoapify',
        placeId: selectedAddress.placeId,
        resultType: selectedAddress.resultType,
        confidence: selectedAddress.confidence,
        lat: selectedAddress.lat,
        lon: selectedAddress.lon,
        city: selectedAddress.city,
        state: selectedAddress.state,
        postcode: selectedAddress.postcode,
        countryCode: 'ph',
        addressDetail: addressDetail.trim() || undefined,
      } : undefined;

      const formData: any = {
        ...rawFormData,
        contactNumber: phNormalized,
        arrivalMode: rawFormData.arrivalMode,
        addressProvenance: addressProv,
        vehicle: rawFormData.arrivalMode === 'vehicle'
          ? {
              vehicleType: rawFormData.vehicleType || 'car',
              plateNumber: plateResult?.displayPlate || rawFormData.plateNumber || '',
              color: rawFormData.vehicleColor || '',
              makeModel: rawFormData.makeModel || null,
              catalogStatus: isManualVehicle ? 'manual' : 'catalog',
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
        rememberVisitor,
      };

      const result = await issueVisitorPass('portal', formData, photoBlob, idBlob, issueRequestId.current, undefined, portalTransactionRef.current, vehiclePhotoBlob);

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
        plateNumber: effectiveVisitor.arrivalMode === 'vehicle' && effectiveVisitor.vehicle?.plateNumber
          ? effectiveVisitor.vehicle.plateNumber
          : null,
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
    { id: 'form', title: 'Personal' },
    { id: 'visit', title: 'Visit' },
    { id: 'photo', title: 'Live Face' },
    { id: 'id', title: 'Valid ID' },
    { id: 'verify', title: 'Verify' },
    { id: 'review', title: 'Review' },
  ];

  const currentStepIndex =
    step === 'done' || step === 'delivery' || step === 'generating'
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
          {/* Stepper only for 6-step New Visitor or verification phases */}
          {step !== 'frontdoor' && step !== 'arrival_setup' && step !== 'returning_capture' && step !== 'returning_confirm' && step !== 'done' && step !== 'delivery' && step !== 'generating' && (
            <div className="mb-8">
              <div className="mb-3 text-center">
                <span className="inline-block rounded-full bg-[#F8EEEE] px-3 py-1 text-xs font-bold text-[#7A0A0A]">
                  {currentStepTitle} • Step {currentStepIndex + 1} of 6
                </span>
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
                    setRegistrationMode('new');
                    setStep('arrival_setup');
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
                    setStep('returning_capture');
                    void faceWebcam.start();
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
                        <span className="rounded-full bg-slate-100 text-slate-700 border border-slate-300 px-2.5 py-0.5 text-[10px] font-bold">
                          Scheduled Maintenance
                        </span>
                      )}
                    </div>
                    <div>
                      <h3 className="font-bold text-base text-[var(--color-text-primary)]">Returning Visitor</h3>
                      <p className="text-xs text-[var(--color-text-secondary)] mt-1 leading-relaxed">
                        Fast check-in using your previously enrolled facial profile and saved visitor credentials.
                      </p>
                      {returningAvailable === false && (
                        <p className="text-[11px] text-slate-600 mt-2 font-medium">
                          Returning visitor verification is currently undergoing scheduled campus maintenance. Please proceed as a New Visitor.
                        </p>
                      )}
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
                    onChange={handleOcrFileSelected}
                    className="hidden"
                  />

                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    disabled={isProcessingOcr}
                    loading={isProcessingOcr}
                    onClick={() => ocrFileInputRef.current?.click()}
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

              {/* Address Field: Controlled Autocomplete & Verified Provenance */}
              <div className="space-y-2">
                <label className="block text-xs font-bold uppercase tracking-wider text-[var(--color-text-muted)]">
                  Home Address <span className="text-[var(--color-danger)]">*</span>
                </label>
                {selectedAddress ? (
                  <div className="rounded-xl border-2 border-[#7A0A0A]/30 bg-[#F8EEEE]/40 p-4 space-y-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-start gap-2.5">
                        <MapPin className="h-5 w-5 text-[#7A0A0A] mt-0.5 flex-shrink-0" />
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="font-bold text-sm text-[var(--color-text-primary)]">
                              Verified Address
                            </span>
                            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 text-emerald-800 px-2 py-0.5 text-[10px] font-bold">
                              <CheckCircle2 className="h-3 w-3 text-emerald-600" />
                              Geoapify Verified
                            </span>
                          </div>
                          <p className="text-sm text-[var(--color-text-primary)] mt-1 leading-relaxed">
                            {selectedAddress.formatted}
                          </p>
                          {(selectedAddress.city || selectedAddress.state) && (
                            <p className="text-xs text-[var(--color-text-secondary)] mt-0.5">
                              {[selectedAddress.city, selectedAddress.state, selectedAddress.postcode].filter(Boolean).join(', ')}
                            </p>
                          )}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedAddress(null);
                          setValue('homeAddress', '', { shouldValidate: true });
                          setAddressQuery('');
                        }}
                        className="text-xs font-bold text-[#7A0A0A] hover:underline px-2 py-1 rounded-lg hover:bg-white/60 transition-colors"
                      >
                        Change
                      </button>
                    </div>

                    <div className="pt-2 border-t border-[#7A0A0A]/15">
                      <label className="block text-[11px] font-semibold text-[var(--color-text-secondary)] mb-1">
                        Unit / Room / House No. / Building (Optional)
                      </label>
                      <Input
                        placeholder="e.g. Unit 302, Building A"
                        value={addressDetail}
                        onChange={(e) => setAddressDetail(e.target.value)}
                      />
                    </div>
                  </div>
                ) : (
                  <div className="relative space-y-1.5">
                    <div className="relative">
                      <Input
                        id="home-address"
                        data-testid="address-search-input"
                        placeholder="Type street, barangay, city, or place name in Philippines..."
                        value={addressQuery}
                        onChange={(e) => {
                          setAddressQuery(e.target.value);
                          setSelectedAddress(null);
                          setValue('homeAddress', e.target.value, { shouldValidate: true });
                          setAddressSearchError(null);
                        }}
                        autoComplete="off"
                      />
                      {isSearchingAddress && (
                        <div className="absolute right-3 top-3">
                          <Loader2 className="h-4 w-4 animate-spin text-[#7A0A0A]" />
                        </div>
                      )}
                    </div>

                    <p className="text-xs text-[var(--color-text-secondary)]">
                      Please search and select your address from official map suggestions (min. 4 characters).
                    </p>

                    {addressSearchError && (
                      <p className="text-xs text-[var(--color-danger)] font-medium">
                        {addressSearchError}
                      </p>
                    )}

                    {addressSuggestions.length > 0 && (
                      <div className="absolute z-20 w-full mt-1 bg-white rounded-xl border border-[var(--color-border)] shadow-lg overflow-hidden max-h-60 overflow-y-auto">
                        {addressSuggestions.map((item) => (
                          <div
                            key={item.placeId}
                            onClick={() => {
                              setSelectedAddress(item);
                              setValue('homeAddress', item.formatted, { shouldValidate: true });
                              setAddressSuggestions([]);
                              setAddressQuery('');
                            }}
                            role="button"
                            tabIndex={0}
                            className="p-3 hover:bg-[#F8EEEE]/60 cursor-pointer border-b border-slate-100 last:border-b-0 text-left transition-colors"
                          >
                            <div className="flex items-start gap-2">
                              <MapPin className="h-4 w-4 text-[#7A0A0A] mt-0.5 flex-shrink-0" />
                              <div>
                                <p className="text-xs font-bold text-[var(--color-text-primary)]">
                                  {item.addressLine1 || item.formatted}
                                </p>
                                <p className="text-[11px] text-[var(--color-text-secondary)] mt-0.5">
                                  {[item.city, item.state, item.postcode].filter(Boolean).join(', ')}
                                </p>
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
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
                  <input id="consent" type="checkbox" {...register('consent')} className="mt-1 h-4 w-4 text-[var(--color-brand)] rounded" />
                  <span className="text-xs text-[var(--color-text-secondary)] leading-relaxed">
                    I consent to the collection and processing of my personal information, face photo, and valid ID pursuant to the <strong>Data Privacy Act of 2012</strong> for the purpose of campus security and visitor management.
                  </span>
                </label>
                {errors.consent && (
                  <p className="text-xs text-[var(--color-danger-dark)] mt-2 font-medium">{errors.consent.message}</p>
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
                  icon={<ArrowRight className="h-4 w-4" />}
                >
                  Next: Visit Details
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

              {/* Purpose of Visit */}
              <FormField label="Purpose of Visit" requirement="required" error={errors.purpose?.message}>
                <VisitPurposeField
                  value={purpose || ''}
                  onChange={(val) => setValue('purpose', val, { shouldValidate: true })}
                  purposes={visitPurposes}
                  error={errors.purpose?.message}
                />
              </FormField>

              {/* Visit Date */}
              <FormField
                label="Visit Date"
                requirement="required"
                error={errors.visitDate?.message}
                hint={`Schedule from today (${today}) up to ${latestVisitDate}`}
              >
                <Input
                  id="visit-date"
                  type="date"
                  min={today}
                  max={latestVisitDate}
                  {...register('visitDate')}
                />
              </FormField>

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
                      <label className="block text-xs font-bold uppercase tracking-wider text-[var(--color-text-muted)] mb-1">
                        Vehicle Make <span className="text-[var(--color-danger)]">*</span>
                      </label>
                      <select
                        value={selectedMake}
                        onChange={(e) => setSelectedMake(e.target.value)}
                        disabled={isLoadingMakes}
                        className="box-border w-full min-w-0 max-w-full rounded-xl border border-[var(--color-border)] bg-white px-3.5 py-2.5 text-base sm:text-sm text-[var(--color-text-primary)] focus:border-[#7A0A0A] focus:outline-none focus:ring-1 focus:ring-[#7A0A0A]"
                      >
                        {availableMakes.map((m) => (
                          <option key={m} value={m}>
                            {m}
                          </option>
                        ))}
                        <option value="Other / Not Listed">Other / Not Listed</option>
                      </select>
                    </div>

                    {!isManualVehicle && (
                      <div>
                        <label className="block text-xs font-bold uppercase tracking-wider text-[var(--color-text-muted)] mb-1">
                          Vehicle Model
                        </label>
                        <select
                          value={selectedModel}
                          onChange={(e) => setSelectedModel(e.target.value)}
                          disabled={isLoadingModels || availableModels.length === 0}
                          className="box-border w-full min-w-0 max-w-full rounded-xl border border-[var(--color-border)] bg-white px-3.5 py-2.5 text-base sm:text-sm text-[var(--color-text-primary)] focus:border-[#7A0A0A] focus:outline-none focus:ring-1 focus:ring-[#7A0A0A]"
                        >
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

                  {/* Manual Make / Model Input when "Other" selected */}
                  {isManualVehicle && (
                    <FormField
                      label="Custom Make & Model"
                      requirement="required"
                      hint="Specify make and model (e.g. Isuzu D-Max, Yamaha NMAX)"
                    >
                      <Input
                        placeholder="e.g. Isuzu D-Max"
                        value={customMakeModel}
                        onChange={(e) => setCustomMakeModel(e.target.value)}
                      />
                    </FormField>
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

              <TurnstileWidget
                ref={turnstileRef}
                execution="execute"
                appearance="interaction-only"
              />

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
              <div className="rounded-xl bg-[var(--color-surface)] p-4 text-sm border border-[var(--color-border)] space-y-3">
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
                    <div className="flex items-center gap-2">
                      <span className="text-[var(--color-text-secondary)] block">Home Address:</span>
                      {selectedAddress && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 text-emerald-800 px-2 py-0.5 text-[10px] font-bold">
                          <CheckCircle2 className="h-3 w-3 text-emerald-600" />
                          Geoapify Verified
                        </span>
                      )}
                    </div>
                    <p className="font-semibold text-[var(--color-text-primary)] mt-0.5 leading-relaxed">
                      {selectedAddress
                        ? [addressDetail.trim(), selectedAddress.formatted].filter(Boolean).join(', ')
                        : getValues('homeAddress')}
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
                  {portalTransactionRef.current?.phase !== 'existing_pass_conflict' &&
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
                    <span className="text-[var(--color-text-secondary)] block">Purpose of Visit:</span>
                    <p className="font-semibold text-sm text-[var(--color-text-primary)] mt-0.5">{getValues('purpose')}</p>
                  </div>
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
                  {portalTransactionRef.current?.phase !== 'existing_pass_conflict' &&
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
                          <span className="text-[11px] text-[var(--color-text-secondary)]">Captured and verified for gate inspection</span>
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
                      />
                      {portalTransactionRef.current?.phase !== 'ambiguous' && (
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
                      {portalTransactionRef.current?.phase !== 'ambiguous' && (
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

              {/* Biometric & Vehicle Retention Checkboxes */}
              <div className="space-y-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-canvas)] p-4 text-xs">
                <label className="flex items-start gap-2.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={rememberVisitor}
                    onChange={(e) => setRememberVisitor(e.target.checked)}
                    className="mt-0.5 h-4 w-4 rounded text-[var(--color-brand)] focus:ring-[var(--color-brand)]"
                  />
                  <div className="text-[var(--color-text-secondary)]">
                    <strong className="text-[var(--color-text-primary)]">Remember me for faster future visits</strong> (optional)
                    <p className="text-[11px] mt-0.5">
                      Securely enrolls encrypted facial biometric features so you can quickly check in on subsequent visits.
                    </p>
                  </div>
                </label>

                {getValues('arrivalMode') === 'vehicle' && (
                  <label className="flex items-start gap-2.5 cursor-pointer pt-2 border-t border-[var(--color-border)]">
                    <input
                      type="checkbox"
                      checked={saveVehicle}
                      onChange={(e) => setSaveVehicle(e.target.checked)}
                      className="mt-0.5 h-4 w-4 rounded text-[var(--color-brand)] focus:ring-[var(--color-brand)]"
                    />
                    <div className="text-[var(--color-text-secondary)]">
                      <strong className="text-[var(--color-text-primary)]">Save this vehicle to my profile</strong> (optional)
                      <p className="text-[11px] mt-0.5">
                        Stores this vehicle for 1-click selection on future visits.
                      </p>
                    </div>
                  </label>
                )}
              </div>

              <div className="flex flex-col sm:flex-row gap-3">
                <Button
                  variant="secondary"
                  onClick={() => setStep('visit')}
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

          {/* ============================== RETURNING VISITOR CAPTURE ============================== */}
          {step === 'returning_capture' && (
            <div className="space-y-6">
              <div className="text-center">
                <h2 className="text-lg font-bold text-[var(--color-text-primary)]">Returning Visitor Biometric Check-In</h2>
                <p className="text-sm text-[var(--color-text-secondary)] mt-1">
                  Look directly at the camera to verify your previously enrolled visitor profile.
                </p>
              </div>

              {returningIdentifyError && (
                <div className="rounded-xl border border-[var(--color-danger)] bg-[var(--color-danger-light)] p-4 text-xs text-[var(--color-danger-dark)] space-y-2" role="alert">
                  <div className="flex items-center gap-2 font-bold">
                    <AlertCircle className="h-4 w-4 text-[var(--color-danger)] flex-shrink-0" />
                    <span>Identification Unsuccessful</span>
                  </div>
                  <p>{returningIdentifyError}</p>
                  <div className="pt-2">
                    <Button
                      size="sm"
                      onClick={() => {
                        setRegistrationMode('new');
                        setStep('form');
                      }}
                      icon={<ArrowRight className="h-3.5 w-3.5" />}
                    >
                      Register as New Visitor
                    </Button>
                  </div>
                </div>
              )}

              <div className="mx-auto w-full max-w-md overflow-hidden rounded-2xl border-2 border-[var(--color-brand)] bg-black aspect-[4/3] relative flex items-center justify-center shadow-inner">
                {isIdentifyingReturning && (
                  <div className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-black/60 text-white text-xs">
                    <Loader2 className="h-6 w-6 animate-spin mb-1 text-[var(--color-brand)]" />
                    <span>Verifying biometric template…</span>
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
                <div className="absolute inset-0 pointer-events-none flex items-center justify-center">
                  <div className="w-48 h-64 sm:w-56 sm:h-72 border-2 border-dashed border-white/80 rounded-[50%] shadow-[0_0_0_9999px_rgba(0,0,0,0.45)] flex items-center justify-center">
                    <span className="sr-only">Center face in oval</span>
                  </div>
                </div>
              </div>

              <TurnstileWidget
                ref={turnstileRef}
                execution="execute"
                appearance="interaction-only"
              />

              <div className="flex gap-3">
                <Button
                  variant="secondary"
                  onClick={() => {
                    faceWebcam.stop();
                    setStep('frontdoor');
                  }}
                  className="flex-1"
                  icon={<ArrowLeft className="h-4 w-4" />}
                >
                  Back
                </Button>
                <Button
                  onClick={onCaptureReturningFace}
                  disabled={!faceWebcam.isActive || isIdentifyingReturning}
                  loading={isIdentifyingReturning}
                  className="flex-1"
                  icon={<Camera className="h-4 w-4" />}
                >
                  Verify My Face
                </Button>
              </div>
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
                  Your identity has been verified via biometrics. Confirm today's visit details below.
                </p>
              </div>

              {/* Verified Identity Badge */}
              <div className="rounded-xl border border-emerald-300 bg-emerald-50 p-4 text-xs text-emerald-950 flex items-center justify-between">
                <div>
                  <span className="text-[11px] uppercase tracking-wider text-emerald-800 font-semibold block">Verified Name</span>
                  <span className="font-bold text-base text-emerald-950">{returningProfile.fullName}</span>
                </div>
                <span className="rounded-full bg-emerald-600 text-white font-bold text-[10px] px-2.5 py-0.5 uppercase tracking-wide">
                  Verified Identity
                </span>
              </div>

              {/* Editable Contact & Address for Today */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <FormField label="Mobile Number" requirement="required" error={errors.contactNumber?.message}>
                  <Input type="tel" {...register('contactNumber')} />
                </FormField>
                <FormField label="Home Address" requirement="required" error={errors.homeAddress?.message}>
                  <Input {...register('homeAddress')} />
                </FormField>
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
              <FormField label="Purpose of Visit" requirement="required" error={errors.purpose?.message}>
                <VisitPurposeField
                  value={purpose || ''}
                  onChange={(val) => setValue('purpose', val, { shouldValidate: true })}
                  purposes={visitPurposes}
                  error={errors.purpose?.message}
                />
              </FormField>

              <FormField label="Visit Date" requirement="required" error={errors.visitDate?.message}>
                <Input type="date" min={today} max={latestVisitDate} {...register('visitDate')} />
              </FormField>

              {/* Saved Vehicles Selection */}
              {returningProfile.savedVehicles && returningProfile.savedVehicles.length > 0 ? (
                <div className="space-y-3">
                  <label className="block text-xs font-bold uppercase tracking-wider text-[var(--color-text-muted)]">
                    Vehicle for Today
                  </label>
                  <div className="grid grid-cols-1 gap-2.5">
                    <div
                      onClick={() => {
                        setSelectedSavedVehicleId('none');
                        setValue('arrivalMode', 'no_vehicle');
                      }}
                      role="button"
                      tabIndex={0}
                      className={`p-3 rounded-xl border text-xs cursor-pointer flex items-center justify-between transition-all ${
                        selectedSavedVehicleId === 'none'
                          ? 'border-[var(--color-brand)] bg-[var(--color-brand-light)] font-bold'
                          : 'border-[var(--color-border)] bg-white'
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <User className="h-4 w-4" />
                        <span>No Vehicle (Pedestrian / Transit)</span>
                      </div>
                      {selectedSavedVehicleId === 'none' && <CheckCircle2 className="h-4 w-4 text-[var(--color-brand)]" />}
                    </div>

                    {returningProfile.savedVehicles.map((veh) => (
                      <div
                        key={veh.id}
                        onClick={() => {
                          setSelectedSavedVehicleId(veh.id);
                          setValue('arrivalMode', 'vehicle');
                          setValue('vehicleType', veh.vehicleType);
                          setValue('plateNumber', veh.plateNumber);
                          setValue('vehicleColor', veh.color);
                          setValue('makeModel', veh.makeModel || '');
                        }}
                        role="button"
                        tabIndex={0}
                        className={`p-3 rounded-xl border text-xs cursor-pointer flex items-center justify-between transition-all ${
                          selectedSavedVehicleId === veh.id
                            ? 'border-[var(--color-brand)] bg-[var(--color-brand-light)] font-bold'
                            : 'border-[var(--color-border)] bg-white'
                        }`}
                      >
                        <div className="flex items-center gap-2">
                          <Car className="h-4 w-4 text-blue-700" />
                          <span>
                            <strong>{veh.plateNumber}</strong> ({veh.vehicleType}) • {veh.color} {veh.makeModel ? `• ${veh.makeModel}` : ''}
                          </span>
                        </div>
                        {selectedSavedVehicleId === veh.id && <CheckCircle2 className="h-4 w-4 text-[var(--color-brand)]" />}
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="space-y-3">
                  <label className="block text-xs font-bold uppercase tracking-wider text-[var(--color-text-muted)]">
                    Arrival Method
                  </label>
                  <div className="grid grid-cols-2 gap-3">
                    <Button
                      type="button"
                      variant={arrivalMode === 'no_vehicle' ? 'primary' : 'secondary'}
                      onClick={() => setValue('arrivalMode', 'no_vehicle')}
                    >
                      No Vehicle
                    </Button>
                    <Button
                      type="button"
                      variant={arrivalMode === 'vehicle' ? 'primary' : 'secondary'}
                      onClick={() => setValue('arrivalMode', 'vehicle')}
                    >
                      Bringing a Vehicle
                    </Button>
                  </div>
                </div>
              )}

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

          {/* ============================== STEP 7: GENERATING ============================== */}
          {step === 'generating' && (
            <div role="status" aria-live="polite" aria-label="Generating gate pass" className="py-16 text-center space-y-4">
              <Loader2 className="mx-auto h-12 w-12 animate-spin text-[var(--color-brand)]" />
              <h3 className="text-lg font-bold text-[var(--color-text-primary)]">Issuing Official E-GatePass…</h3>
              <p className="text-sm text-[var(--color-text-secondary)]">Securing your pass record and generating QR token.</p>
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

      {/* Returning Visitor Safety Gate Modal */}
      {showReturningGateModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl space-y-4">
            <div className="flex items-center gap-3 text-amber-900">
              <div className="h-10 w-10 rounded-xl bg-amber-100 flex items-center justify-center text-amber-700 flex-shrink-0">
                <ShieldAlert className="h-5 w-5" />
              </div>
              <div>
                <h3 className="font-bold text-base text-[var(--color-text-primary)]">Biometric Check-In Unavailable</h3>
                <p className="text-xs text-[var(--color-text-secondary)]">Safety Gate Enforced</p>
              </div>
            </div>

            <p className="text-xs text-[var(--color-text-secondary)] leading-relaxed">
              Returning visitor facial recognition is temporarily closed pending on-campus physical sensor calibration and threshold verification.
            </p>
            <p className="text-xs text-[var(--color-text-secondary)] leading-relaxed">
              Please register as a New Visitor to receive your official E-GatePass today.
            </p>

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
                  setRegistrationMode('new');
                  setStep('form');
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
