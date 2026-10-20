import { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { Toaster } from 'sonner';
import { AuthProvider } from '@/hooks/useAuth';
import { ProtectedRoute } from '@/components/ProtectedRoute';
import { LandingPage } from '@/pages/LandingPage';
import { LoginPage } from '@/pages/LoginPage';
import { AdminPage } from '@/pages/AdminPage';
import { PrivacyModal } from '@/components/PrivacyModal';
import { OfflineBanner } from '@/components/OfflineBanner';
import { LoadingState } from '@/components/ui';

const GetPassPage = lazy(() => import('@/pages/GetPassPage').then((module) => ({ default: module.GetPassPage })));
const ForgotPasswordPage = lazy(() => import('@/pages/ForgotPasswordPage').then((module) => ({ default: module.ForgotPasswordPage })));
const KioskPage = lazy(() => import('@/pages/KioskPage').then((module) => ({ default: module.KioskPage })));
const GuardPage = lazy(() => import('@/pages/GuardPage').then((module) => ({ default: module.GuardPage })));
const AdminDashboard = lazy(() => import('@/pages/AdminDashboard').then((module) => ({ default: module.AdminDashboard })));
const AdminUsers = lazy(() => import('@/pages/AdminUsers').then((module) => ({ default: module.AdminUsers })));
const AdminRecords = lazy(() => import('@/pages/AdminRecords').then((module) => ({ default: module.AdminRecords })));
const AdminSettings = lazy(() => import('@/pages/AdminSettings').then((module) => ({ default: module.AdminSettings })));
const AdminEmergency = lazy(() => import('@/pages/AdminEmergency').then((module) => ({ default: module.AdminEmergency })));
const AdminAuditLogs = lazy(() => import('@/pages/AdminAuditLogs').then((module) => ({ default: module.AdminAuditLogs })));
const DevicesPage = lazy(() => import('@/pages/DevicesPage').then((module) => ({ default: module.DevicesPage })));
const EntryScanPage = lazy(() => import('@/pages/EntryScanPage').then((module) => ({ default: module.EntryScanPage })));
const ExitScanPage = lazy(() => import('@/pages/ExitScanPage').then((module) => ({ default: module.ExitScanPage })));

function RouteLoadingFallback() {
  return (
    <main id="main-content" className="min-h-[40vh] bg-[var(--color-canvas)]">
      <LoadingState label="Loading page..." className="min-h-[40vh]" />
    </main>
  );
}

export function App() {
  return (
    <AuthProvider>
      <OfflineBanner />
      <PrivacyModal />
      <BrowserRouter>
        <a href="#main-content" className="skip-link">
          Skip to main content
        </a>

        <Suspense fallback={<RouteLoadingFallback />}>
          <Routes>
          {/* Public routes */}
          <Route path="/" element={<LandingPage />} />
          <Route path="/get-pass" element={<GetPassPage />} />
          <Route path="/login" element={<LoginPage />} />
          <Route path="/forgot-password" element={<ForgotPasswordPage />} />

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

          {/* Guard — requires guard or admin role */}
          <Route element={<ProtectedRoute allowedRoles={['guard', 'admin', 'superadmin']} />}>
            <Route path="/guard" element={<GuardPage />} />
          </Route>

          {/* Admin — requires admin role, uses nested layout */}
          <Route element={<ProtectedRoute allowedRoles={['admin', 'superadmin']} />}>
            <Route path="/admin" element={<AdminPage />}>
              <Route index element={<AdminDashboard />} />
              <Route path="visitors" element={<AdminRecords />} />
              <Route path="devices" element={<DevicesPage />} />
              <Route path="users" element={<AdminUsers />} />
              <Route path="emergency" element={<AdminEmergency />} />
              <Route path="audit" element={<AdminAuditLogs />} />
              <Route path="settings" element={<AdminSettings />} />
            </Route>
          </Route>
          </Routes>
        </Suspense>

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
