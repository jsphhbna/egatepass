import { lazy } from 'react';
import { Navigate, Outlet } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import type { AuthRole } from '@/types';
import { LoadingState } from '@/components/ui';

const ForcePasswordChange = lazy(() => import('@/components/ForcePasswordChange').then((module) => ({
  default: module.ForcePasswordChange,
})));

interface ProtectedRouteProps {
  /** Roles allowed to access this route */
  allowedRoles: AuthRole[];
  /** Where to redirect if not authenticated */
  loginPath?: string;
  /** Where to redirect if authenticated but wrong role */
  unauthorizedPath?: string;
}

/**
 * Route guard that checks Firebase auth state and Firestore role.
 * Redirects to login if unauthenticated, or to unauthorized page if wrong role.
 */
export function ProtectedRoute({
  allowedRoles,
  loginPath = '/login',
  unauthorizedPath = '/login',
}: ProtectedRouteProps) {
  const { status, role } = useAuth();

  if (status === 'loading') {
    return (
      <div className="min-h-dvh bg-[var(--color-canvas)]">
        <LoadingState label="Checking your access..." className="min-h-dvh" />
      </div>
    );
  }

  if (status === 'unauthenticated') {
    return <Navigate to={loginPath} replace />;
  }

  if (status === 'requires_password_change') {
    return <ForcePasswordChange />;
  }

  if (!allowedRoles.includes(role)) {
    return <Navigate to={unauthorizedPath} replace />;
  }

  return <Outlet />;
}
