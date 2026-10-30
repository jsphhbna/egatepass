import { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { Toaster } from 'sonner';
import { AuthProvider, useAuth } from '@/hooks/useAuth';
import { ProtectedRoute } from '@/components/ProtectedRoute';
import { LandingPage } from '@/pages/LandingPage';
import { OfflineBanner } from '@/components/OfflineBanner';
import { LoadingState } from '@/components/ui';
import { PrivacyModal } from '@/components/PrivacyModal';

import { RouteErrorBoundary } from '@/components/RouteErrorBoundary';

const GetPassPage = lazy(() => import('@/pages/GetPassPage').then((module) => ({ default: module.GetPassPage })));
const LoginPage = lazy(() => import('@/pages/LoginPage').then((module) => ({ default: module.LoginPage })));
const AdminPage = lazy(() => import('@/pages/AdminPage').then((module) => ({ default: module.AdminPage })));
const ForgotPasswordPage = lazy(() => import('@/pages/ForgotPasswordPage').then((module) => ({ default: module.ForgotPasswordPage })));
const ResetPasswordPage = lazy(() => import('@/pages/ResetPasswordPage').then((module) => ({ default: module.ResetPasswordPage })));
const KioskPage = lazy(() => import('@/pages/KioskPage').then((module) => ({ default: module.KioskPage })));
const GuardPage = lazy(() => import('@/pages/GuardPage').then((module) => ({ default: module.GuardPage })));
const LegacyGuardPage = lazy(() => import('@/pages/LegacyGuardPage').then((module) => ({ default: module.LegacyGuardPage })));
const AdminDashboard = lazy(() => import('@/pages/AdminDashboard').then((module) => ({ default: module.AdminDashboard })));
const AdminUsers = lazy(() => import('@/pages/AdminUsers').then((module) => ({ default: module.AdminUsers })));
const AdminRecords = lazy(() => import('@/pages/AdminRecords').then((module) => ({ default: module.AdminRecords })));
const AdminSettings = lazy(() => import('@/pages/AdminSettings').then((module) => ({ default: module.AdminSettings })));
const AdminEmergency = lazy(() => import('@/pages/AdminEmergency').then((module) => ({ default: module.AdminEmergency })));
const AdminAuditLogs = lazy(() => import('@/pages/AdminAuditLogs').then((module) => ({ default: module.AdminAuditLogs })));
const AdminPrintTemplatesPage = lazy(() => import('@/pages/AdminPrintTemplatesPage').then((module) => ({ default: module.AdminPrintTemplatesPage })));
const DevicesPage = lazy(() => import('@/pages/DevicesPage').then((module) => ({ default: module.DevicesPage })));
const EntryScanPage = lazy(() => import('@/pages/EntryScanPage').then((module) => ({ default: module.EntryScanPage })));
const ExitScanPage = lazy(() => import('@/pages/ExitScanPage').then((module) => ({ default: module.ExitScanPage })));
const NotFoundPage = lazy(() => import('@/pages/NotFoundPage').then((module) => ({ default: module.NotFoundPage })));

function GetPassLoadingFallback() {
  return (
    <main id="main-content" className="flex min-h-[60vh] flex-col items-center justify-center bg-[var(--color-canvas)] px-4 py-16" role="status" aria-live="polite">
      <div className="flex flex-col items-center text-center">
        <img src="/earist-logo.png" alt="EARIST seal" className="h-12 w-12 object-contain" />
        <span className="mt-3 text-lg font-black tracking-tight text-[#700f14]">E-GatePass</span>
        <div className="mt-6 flex items-center gap-2.5 text-sm font-semibold text-[var(--color-text-secondary)]">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-[var(--color-border)] border-t-[var(--color-brand)]" aria-hidden="true" />
          <span>Opening visitor registration…</span>
        </div>
      </div>
    </main>
  );
}

function RouteLoadingFallback() {
  return (
    <main id="main-content" className="min-h-[40vh] bg-[var(--color-canvas)]">
      <LoadingState label="Loading page..." className="min-h-[40vh]" />
    </main>
  );
}

function AuthenticatedPrivacyGate() {
  const { status, role } = useAuth();
  if (status !== 'authenticated' || !['guard', 'admin', 'superadmin'].includes(role ?? '')) return null;
  return <PrivacyModal />;
}

export function App() {
  return (
    <AuthProvider>
      <OfflineBanner />
      <AuthenticatedPrivacyGate />
      <BrowserRouter>
        <a href="#main-content" className="skip-link">
          Skip to main content
        </a>

        <RouteErrorBoundary>
          <Suspense fallback={<RouteLoadingFallback />}>
            <Routes>
            {/* Public routes */}
            <Route path="/" element={<LandingPage />} />
            <Route
              path="/get-pass"
              element={
                <Suspense fallback={<GetPassLoadingFallback />}>
                  <GetPassPage />
                </Suspense>
              }
            />
            <Route path="/login" element={<LoginPage />} />
            <Route path="/forgot-password" element={<ForgotPasswordPage />} />
            <Route path="/reset-password" element={<ResetPasswordPage />} />

            {/* Kiosk — requires kiosk device account */}
            <Route element={<ProtectedRoute allowedRoles={['kiosk']} />}>
              <Route path="/kiosk" element={<KioskPage />} />
            </Route>

            {/* Scanner tablets — requires matching device account */}
            <Route element={<ProtectedRoute allowedRoles={['entry']} />}>
              <Route path="/scan/entry" element={<EntryScanPage />} />
            </Route>
            <Route element={<ProtectedRoute allowedRoles={['exit']} />}>
              <Route path="/scan/exit" element={<ExitScanPage />} />
            </Route>

            {/* Guard Station — requires guard_station device or admin role */}
            <Route element={<ProtectedRoute allowedRoles={['guard_station', 'admin', 'superadmin']} />}>
              <Route path="/guard" element={<GuardPage />} />
            </Route>

            {/* Admin — requires admin role, uses nested layout */}
            <Route element={<ProtectedRoute allowedRoles={['admin', 'superadmin']} />}>
              <Route path="/admin" element={<AdminPage />}>
                <Route index element={<AdminDashboard />} />
                <Route path="visitors" element={<AdminRecords />} />
                <Route path="devices" element={<DevicesPage />} />
                <Route path="users" element={<AdminUsers />} />
                <Route path="legacy-guard" element={<LegacyGuardPage />} />
                <Route path="emergency" element={<AdminEmergency />} />
                <Route path="audit" element={<AdminAuditLogs />} />
                <Route path="templates" element={<AdminPrintTemplatesPage />} />
                <Route path="settings" element={<AdminSettings />} />
              </Route>
            </Route>

            {/* Catch-all 404 */}
            <Route path="*" element={<NotFoundPage />} />
            </Routes>
          </Suspense>
        </RouteErrorBoundary>

        <Toaster
          position="top-center"
          richColors
          closeButton
          toastOptions={{
            style: {
              borderRadius: 'var(--radius-md)',
            },
          }}
        />
      </BrowserRouter>
    </AuthProvider>
  );
}
