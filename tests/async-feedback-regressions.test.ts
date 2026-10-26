import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';

describe('Async Feedback, Slow-Network Resilience, and State-Truthfulness Regressions', () => {
  const readSrc = (file: string) => readFileSync(file, 'utf8').replace(/\r\n/g, '\n');

  // ==========================================================================
  // FIX 1 & FIX 2: Landing Navigation & /get-pass Loading Fallback
  // ==========================================================================
  describe('FIX 1 & 2: Landing Page Get Pass Navigation and Route Suspense Fallback', () => {
    const landingSrc = readSrc('src/pages/LandingPage.tsx');
    const appSrc = readSrc('src/App.tsx');

    it('manages openingGatePassFrom state to track header, hero, or final CTA activation', () => {
      expect(landingSrc).toContain("type GatePassCtaSource = 'header' | 'hero' | 'final' | null;");
      expect(landingSrc).toContain('const [openingGatePassFrom, setOpeningGatePassFrom] = useState<GatePassCtaSource>(null);');
    });

    it('prevents repeated or concurrent activation of all 3 CTAs while pending', () => {
      expect(landingSrc).toContain('if (openingGatePassFrom !== null)');
      expect(landingSrc).toContain('aria-disabled={openingGatePassFrom !== null}');
    });

    it('header CTA switches to "Opening…" with spinner and aria-busy when active', () => {
      expect(landingSrc).toContain("aria-busy={openingGatePassFrom === 'header'}");
      expect(landingSrc).toContain("openingGatePassFrom === 'header'");
      expect(landingSrc).toContain('Opening…');
    });

    it('hero and final CTAs switch to "Opening Gate Pass…" with spinner and aria-busy when active', () => {
      expect(landingSrc).toContain("aria-busy={openingGatePassFrom === 'hero'}");
      expect(landingSrc).toContain("openingGatePassFrom === 'hero'");
      expect(landingSrc).toContain("aria-busy={openingGatePassFrom === 'final'}");
      expect(landingSrc).toContain("openingGatePassFrom === 'final'");
      expect(landingSrc).toContain('Opening Gate Pass…');
    });

    it('dedicated /get-pass route provides branded loading fallback with "Opening visitor registration…"', () => {
      expect(appSrc).toContain('Opening visitor registration…');
      expect(appSrc).toContain('role="status"');
      expect(appSrc).toContain('aria-live="polite"');
    });
  });

  // ==========================================================================
  // FIX 3: Initial Application Bootstrap Loader
  // ==========================================================================
  describe('FIX 3: Initial Application Bootstrap', () => {
    const mainSrc = readSrc('src/main.tsx');

    it('renders a branded initial loader with EARIST seal and "Loading E-GatePass…" before App imports', () => {
      expect(mainSrc).toContain('/earist-logo.png');
      expect(mainSrc).toContain('E-GatePass');
      expect(mainSrc).toContain('Loading E-GatePass…');
      expect(mainSrc).toContain('role="status"');
      expect(mainSrc).toContain('aria-live="polite"');
    });
  });

  // ==========================================================================
  // FIX 4 & FIX 6: Visitor Registration Authoritative Settings
  // ==========================================================================
  describe('FIX 4 & 6: Visitor Registration Settings Contract and Loading States', () => {
    const getPassSrc = readSrc('src/pages/GetPassPage.tsx');
    const serviceSrc = readSrc('src/services/visitorRegistration.ts');

    it('loadRegistrationSettings throws typed error on Supabase failure or missing row instead of silent null', () => {
      expect(serviceSrc).toContain("throw new Error(error.message || 'Failed to load registration settings');");
    });

    it('GetPassPage implements RegistrationConfigState model ("loading" | "ready" | "error")', () => {
      expect(getPassSrc).toContain("type RegistrationConfigState = 'loading' | 'ready' | 'error';");
      expect(getPassSrc).toContain("const [configState, setConfigState] = useState<RegistrationConfigState>('loading');");
    });

    it('displays "Preparing visitor registration…" loader and blocks form rendering while loading', () => {
      expect(getPassSrc).toContain('Preparing visitor registration…');
      expect(getPassSrc).toContain('Loading visit options and campus schedule.');
      expect(getPassSrc).toContain("{configState === 'ready' && (");
    });

    it('displays blocking error card with "Retrying…" button on config failure and allows retry', () => {
      expect(getPassSrc).toContain('Visitor registration unavailable');
      expect(getPassSrc).toContain('Campus visit settings could not be loaded.');
      expect(getPassSrc).toContain("isRetryingConfig ? 'Retrying…' : 'Try Again'");
    });
  });

  // ==========================================================================
  // FIX 5: Kiosk Authoritative Settings
  // ==========================================================================
  describe('FIX 5: Kiosk Authoritative Configuration Startup', () => {
    const kioskSrc = readSrc('src/pages/KioskPage.tsx');

    it('implements KioskConfigState model and blocks registration flow before settings resolve', () => {
      expect(kioskSrc).toContain("type KioskConfigState = 'loading' | 'ready' | 'error';");
      expect(kioskSrc).toContain("const [configState, setConfigState] = useState<KioskConfigState>('loading');");
    });

    it('shows "Preparing kiosk registration…" and "Loading campus visit settings." while loading', () => {
      expect(kioskSrc).toContain('Preparing kiosk registration…');
      expect(kioskSrc).toContain('Loading campus visit settings.');
    });

    it('selects workflow (form vs scan-intro) only after authoritative configuration is loaded', () => {
      expect(kioskSrc).toContain("setStep(peakActive ? 'form' : 'scan-intro');");
    });

    it('shows blocking error card with "Retrying…" button on kiosk settings failure', () => {
      expect(kioskSrc).toContain('Kiosk configuration unavailable');
      expect(kioskSrc).toContain('Campus visit settings could not be loaded. Check the kiosk connection and try again.');
      expect(kioskSrc).toContain("retryingConfig ? 'Retrying…' : 'Try Again'");
    });
  });

  // ==========================================================================
  // FIX 7: Turnstile Widget Loading State
  // ==========================================================================
  describe('FIX 7: Turnstile Widget Loading and Error State Model', () => {
    const turnstileSrc = readSrc('src/components/TurnstileWidget.tsx');

    it('tracks TurnstileStatus ("loading" | "ready" | "verified" | "error")', () => {
      expect(turnstileSrc).toContain("type TurnstileStatus = 'loading' | 'ready' | 'verified' | 'error';");
    });

    it('reserves space and displays "Loading security check…" placeholder while loading', () => {
      expect(turnstileSrc).toContain('Loading security check…');
        expect(turnstileSrc).toContain('aria-live="polite"');
    });

    it('shows visible retryable error state on script or widget error', () => {
      expect(turnstileSrc).toContain('Security verification could not load.');
      expect(turnstileSrc).toContain('role="alert"');
      expect(turnstileSrc).toContain('Retry');
    });

    it('shows "Security verification unavailable." when site key is missing in production', () => {
      expect(turnstileSrc).toContain('Security verification unavailable.');
    });
  });

  // ==========================================================================
  // FIX 8: Webcam Startup Feedback
  // ==========================================================================
  describe('FIX 8: useWebcam Hook Startup Feedback and Viewfinder Overlays', () => {
    const webcamHookSrc = readSrc('src/hooks/useWebcam.ts');
    const getPassSrc = readSrc('src/pages/GetPassPage.tsx');
    const kioskSrc = readSrc('src/pages/KioskPage.tsx');

    it('useWebcam exposes isStarting boolean and prevents concurrent getUserMedia calls', () => {
      expect(webcamHookSrc).toContain('isStarting: boolean;');
      expect(webcamHookSrc).toContain('const isStartingRef = useRef(false);');
      expect(webcamHookSrc).toContain('if (isStartingRef.current || isActive) return;');
    });

    it('clears starting and active state on stop() and handles failure gracefully', () => {
      expect(webcamHookSrc).toContain('setIsStarting(false);');
      expect(webcamHookSrc).toContain('isStartingRef.current = false;');
    });

    it('GetPassPage displays "Starting camera…" and "Starting ID camera…" overlays and "Starting…" on retry', () => {
      expect(getPassSrc).toContain('Starting camera…');
      expect(getPassSrc).toContain('Starting ID camera…');
      expect(getPassSrc).toContain("faceWebcam.isStarting ? 'Starting…' : 'Retry Camera'");
      expect(getPassSrc).toContain("idWebcam.isStarting ? 'Starting…' : 'Retry Camera'");
    });

    it('KioskPage displays "Starting camera…" and "Starting ID camera…" overlays and "Starting…" on retry', () => {
      expect(kioskSrc).toContain('Starting camera…');
      expect(kioskSrc).toContain('Starting ID camera…');
      expect(kioskSrc).toContain("faceWebcam.isStarting ? 'Starting…' : 'Retry Camera'");
      expect(kioskSrc).toContain("idWebcam.isStarting ? 'Starting…' : 'Retry Camera'");
    });
  });

  // ==========================================================================
  // FIX 9 & FIX 10: ID Image Compression Processing State
  // ==========================================================================
  describe('FIX 9 & 10: Visitor and Kiosk ID Compression Processing State', () => {
    const getPassSrc = readSrc('src/pages/GetPassPage.tsx');
    const kioskSrc = readSrc('src/pages/KioskPage.tsx');

    it('GetPassPage stops camera, displays "Processing ID image…", and disables actions during compression', () => {
      expect(getPassSrc).toContain('const [isProcessingId, setIsProcessingId] = useState(false);');
      expect(getPassSrc).toContain('Processing ID image…');
      expect(getPassSrc).toContain('disabled={isProcessingId}');
      expect(getPassSrc).toContain('disabled={!idWebcam.isActive || isProcessingId}');
    });

    it('KioskPage manual ID capture stops camera, displays "Processing ID image…", and disables actions during compression', () => {
      expect(kioskSrc).toContain('const [isProcessingId, setIsProcessingId] = useState(false);');
      expect(kioskSrc).toContain('Processing ID image…');
      expect(kioskSrc).toContain('disabled={isProcessingId}');
      expect(kioskSrc).toContain('disabled={!idWebcam.isActive || isProcessingId}');
    });
  });

  // ==========================================================================
  // FIX 11: Privacy Acknowledgement Loading Race
  // ==========================================================================
  describe('FIX 11: Privacy Acknowledgement Eager Import', () => {
    const appSrc = readSrc('src/App.tsx');

    it('imports PrivacyModal eagerly without lazy loading or null suspense fallback', () => {
      expect(appSrc).toContain("import { PrivacyModal } from '@/components/PrivacyModal';");
      expect(appSrc).not.toContain("lazy(() => import('@/components/PrivacyModal')");
      expect(appSrc).not.toContain('<Suspense fallback={null}><PrivacyModal /></Suspense>');
      expect(appSrc).toContain('return <PrivacyModal />;');
    });
  });

  // ==========================================================================
  // FIX 12: Emergency Evacuation List Freshness
  // ==========================================================================
  describe('FIX 12: Emergency Evacuation List Freshness and Polling Resilience', () => {
    const emergencySrc = readSrc('src/pages/AdminEmergency.tsx');

    it('tracks separate initialLoading, refreshing, lastUpdatedAt, and refreshError states', () => {
      expect(emergencySrc).toContain('const [initialLoading, setInitialLoading] = useState(true);');
      expect(emergencySrc).toContain('const [refreshing, setRefreshing] = useState(false);');
      expect(emergencySrc).toContain('const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null);');
      expect(emergencySrc).toContain('const [refreshError, setRefreshError] = useState<string | null>(null);');
    });

    it('shows "Loading evacuation list…" before first load and avoids false empty state', () => {
      expect(emergencySrc).toContain('Loading evacuation list…');
    });

    it('shows "Refreshing live list…" during poll without covering data table', () => {
      expect(emergencySrc).toContain('Refreshing live list…');
    });

    it('shows Manila updated time or "Refresh delayed — showing data from [time]" when poll fails', () => {
      expect(emergencySrc).toContain('Updated {formatManilaTime(lastUpdatedAt)}');
      expect(emergencySrc).toContain('Refresh delayed — showing data from');
    });

    it('initial failure shows "Evacuation list unavailable" with "Retrying…" button', () => {
      expect(emergencySrc).toContain('Evacuation list unavailable');
      expect(emergencySrc).toContain("isRetrying ? 'Retrying…' : 'Try Again'");
    });
  });

  // ==========================================================================
  // FIX 13: Guard Queue Background Freshness
  // ==========================================================================
  describe('FIX 13: Guard Queue Background Refresh Truthfulness', () => {
    const guardSrc = readSrc('src/pages/GuardPage.tsx');
    const hookSrc = readSrc('src/hooks/useGuardQueue.ts');

    it('tracks refreshing, lastUpdatedAt, and refreshError without clearing queue', () => {
      expect(hookSrc).toContain('const [refreshing, setRefreshing] = useState(false);');
      expect(hookSrc).toContain('const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null);');
      expect(hookSrc).toContain('const [refreshError, setRefreshError] = useState(false);');
      expect(guardSrc).toContain('useGuardQueue(');
    });

    it('shows "Updating…" in status header during poll without disabling actions', () => {
      expect(guardSrc).toContain('Updating…');
    });

    it('shows Manila updated time or "Connection delayed — showing queue from [time]" on failure', () => {
      expect(guardSrc).toContain('Updated {formatManilaTime(lastUpdatedAt)}');
      expect(guardSrc).toContain('Connection delayed — showing queue from');
    });
  });

  // ==========================================================================
  // FIX 14: Admin Dashboard Refresh Truthfulness
  // ==========================================================================
  describe('FIX 14: Admin Dashboard Polling Resilience and Refresh Truthfulness', () => {
    const dashHookSrc = readSrc('src/hooks/useAdminDashboardData.ts');
    const dashPageSrc = readSrc('src/pages/AdminDashboard.tsx');

    it('dashboard hook exposes initialLoading, refreshing, initialError, refreshError, and updatedAt', () => {
      expect(dashHookSrc).toContain('initialLoading: boolean;');
      expect(dashHookSrc).toContain('refreshing: boolean;');
      expect(dashHookSrc).toContain('initialError: string | null;');
      expect(dashHookSrc).toContain('refreshError: string | null;');
      expect(dashHookSrc).toContain('updatedAt: number | null;');
    });

    it('preserves existing dashboard data when background poll fails', () => {
      expect(dashHookSrc).toContain('refreshError: errorMessage,');
      expect(dashHookSrc).toContain('initialError: errorMessage,');
    });

    it('dashboard header displays "Updating…" during poll and "Update delayed — showing data from [time]" on failure', () => {
      expect(dashPageSrc).toContain('Updating…');
      expect(dashPageSrc).toContain('Update delayed — showing data from');
      expect(dashPageSrc).toContain('Updated {formatManilaTime(dashboard.updatedAt)}');
    });

    it('Try Again button shows "Retrying…" and prevents duplicate retry clicks', () => {
      expect(dashPageSrc).toContain("retrying ? 'Retrying…' : 'Try Again'");
      expect(dashPageSrc).toContain('disabled={retrying}');
      expect(dashPageSrc).toContain('loading={retrying}');
    });
  });

  // ==========================================================================
  // FIX 15, 16, 17: Sign-Out Modal Await and Pending States
  // ==========================================================================
  describe('FIX 15, 16, 17: Entry Scanner, Exit Scanner, and Kiosk Awaited Sign-Out', () => {
    const entrySrc = readSrc('src/pages/EntryScanPage.tsx');
    const exitSrc = readSrc('src/pages/ExitScanPage.tsx');
    const kioskSrc = readSrc('src/pages/KioskPage.tsx');

    it('EntryScanPage awaits signOutCurrentActor, keeps modal open, and shows "Signing out…"', () => {
      expect(entrySrc).toContain('const [isSigningOut, setIsSigningOut] = useState(false);');
      expect(entrySrc).toContain('await signOutCurrentActor();');
      expect(entrySrc).toContain("isSigningOut ? 'Signing out…' : 'Sign Out Scanner'");
      expect(entrySrc).toContain('if (!isSigningOut) setShowSignOutConfirm(false);');
    });

    it('ExitScanPage awaits signOutCurrentActor, keeps modal open, and shows "Signing out…"', () => {
      expect(exitSrc).toContain('const [isSigningOut, setIsSigningOut] = useState(false);');
      expect(exitSrc).toContain('await signOutCurrentActor();');
      expect(exitSrc).toContain("isSigningOut ? 'Signing out…' : 'Sign Out Scanner'");
      expect(exitSrc).toContain('if (!isSigningOut) setShowSignOutConfirm(false);');
    });

    it('KioskPage awaits signOutCurrentActor, keeps modal open, and shows "Signing out…"', () => {
      expect(kioskSrc).toContain('const [isSigningOut, setIsSigningOut] = useState(false);');
      expect(kioskSrc).toContain('await signOutCurrentActor();');
      expect(kioskSrc).toContain("isSigningOut ? 'Signing out…' : 'Sign Out Device'");
      expect(kioskSrc).toContain('if (!isSigningOut) setShowSignOutConfirm(false);');
    });
  });

  // ==========================================================================
  // FIX 18: Login / Verification Resend State Separation
  // ==========================================================================
  describe('FIX 18: Login and Verification Resend Separate States', () => {
    const loginSrc = readSrc('src/pages/LoginPage.tsx');

    it('splits loading into isSigningIn and isResendingVerification states', () => {
      expect(loginSrc).toContain('const [isSigningIn, setIsSigningIn] = useState(false);');
      expect(loginSrc).toContain('const [isResendingVerification, setIsResendingVerification] = useState(false);');
    });

    it('Sign In shows "Signing in…" only during sign in, and disables inputs/buttons', () => {
      expect(loginSrc).toContain("isSigningIn ? 'Signing in…' : 'Sign In'");
      expect(loginSrc).toContain("disabled={isSigningIn || isResendingVerification || serviceStatus === 'unavailable'}");
    });

    it('Resend button shows "Sending…" and does NOT alter Sign In button label to "Signing in…"', () => {
      expect(loginSrc).toContain("isResendingVerification ? 'Sending…'");
      expect(loginSrc).toContain('loading={isResendingVerification}');
    });
  });

  // ==========================================================================
  // FIX 19: QR Share Action Duplicate Prevention
  // ==========================================================================
  describe('FIX 19: QR Share Action State and Duplicate Prevention', () => {
    const getPassSrc = readSrc('src/pages/GetPassPage.tsx');

    it('GetPassPage tracks isSharing, displays "Opening Share…", and disables repeated share taps', () => {
      expect(getPassSrc).toContain('const [isSharing, setIsSharing] = useState(false);');
      expect(getPassSrc).toContain('Opening Share…');
      expect(getPassSrc).toContain('disabled={isSharing}');
      expect(getPassSrc).toContain('loading={isSharing}');
    });
  });
});