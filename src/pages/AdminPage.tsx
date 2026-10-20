import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { signOut } from 'firebase/auth';
import { auth } from '@/lib/firebase';
import { useAuth } from '@/hooks/useAuth';
import {
  LayoutDashboard,
  Users,
  Tablet,
  Settings,
  FileText,
  AlertTriangle,
  ClipboardList,
  LogOut,
  Menu,
  X,
} from 'lucide-react';
import { BrandMark } from '@/components/BrandMark';
import { ConfirmModal } from '@/components/ui';
import { useState } from 'react';
import type { AppUser } from '@/types';
import { formatUserRole, isSuperAdmin } from '@/lib/permissions';

const navItems = [
  { to: '/admin', icon: LayoutDashboard, label: 'Dashboard', end: true },
  { to: '/admin/visitors', icon: FileText, label: 'Visitors', end: false },
  { to: '/admin/devices', icon: Tablet, label: 'Devices', end: false },
  { to: '/admin/users', icon: Users, label: 'Users', end: false },
  { to: '/admin/emergency', icon: AlertTriangle, label: 'Emergency', end: false },
  { to: '/admin/audit', icon: ClipboardList, label: 'Audit Logs', end: false },
  { to: '/admin/settings', icon: Settings, label: 'Settings', end: false },
];

export function AdminPage() {
  const { userData, role } = useAuth();
  const navigate = useNavigate();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const adminName = (userData as AppUser | null)?.name ?? 'Admin';
  const adminRoleLabel = isSuperAdmin(role) ? formatUserRole('superadmin') : 'Admin';

  const [isSigningOut, setIsSigningOut] = useState(false);
  const [showSignOutModal, setShowSignOutModal] = useState(false);

  async function handleSignOut() {
    setIsSigningOut(true);
    try {
      await signOut(auth);
      navigate('/login', { replace: true });
    } finally {
      setIsSigningOut(false);
      setShowSignOutModal(false);
    }
  }

  return (
    <div className="flex min-h-dvh bg-[var(--color-canvas)]">
      {/* Mobile hamburger */}
      <button
        type="button"
        onClick={() => setSidebarOpen(true)}
        className="fixed left-3 top-3 z-40 flex min-h-11 min-w-11 items-center justify-center rounded-md border border-[var(--color-border)] bg-white text-[var(--color-text-primary)] shadow-sm md:hidden"
        aria-label="Open menu"
      >
        <Menu className="h-5 w-5" />
      </button>

      {/* Overlay */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-40 bg-[var(--color-overlay-strong)] md:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside
        className={`fixed inset-y-0 left-0 z-50 flex w-64 flex-col bg-[var(--color-brand-dark)] text-white shadow-md transition-transform duration-200 md:sticky md:top-0 md:h-dvh md:translate-x-0 ${
          sidebarOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        {/* Header */}
        <div className="flex min-h-16 items-center justify-between border-b border-white/10 px-4">
          <div className="flex items-center gap-2">
            <BrandMark size="sm" className="bg-white" />
            <span className="text-sm font-bold text-white">EARIST E-GatePass</span>
          </div>
          <button
            type="button"
            onClick={() => setSidebarOpen(false)}
            className="flex min-h-11 min-w-11 items-center justify-center rounded-md text-white/70 hover:bg-white/10 hover:text-white md:hidden"
            aria-label="Close menu"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Nav */}
        <nav className="flex-1 overflow-y-auto px-3 py-4" aria-label="Admin navigation">
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              onClick={() => setSidebarOpen(false)}
              className={({ isActive }) => `mb-1 flex min-h-11 items-center gap-3 rounded-md px-3 text-sm font-semibold no-underline ${isActive ? 'bg-white text-[var(--color-brand-dark)] shadow-sm' : 'text-white/75 hover:bg-white/10 hover:text-white'}`}
            >
              <item.icon className="h-4 w-4" />
              {item.label}
            </NavLink>
          ))}
        </nav>

        {/* Footer */}
        <div className="border-t border-white/10 p-3">
          <p className="mb-2 truncate text-xs font-medium text-white/60">
            Signed in as {adminName} · {adminRoleLabel}
          </p>
          <button
            type="button"
            onClick={() => setShowSignOutModal(true)}
            className="flex min-h-10 w-full items-center justify-center gap-2 rounded-md border border-white/20 px-3 text-xs font-semibold text-white/80 hover:border-white/40 hover:bg-white/10 hover:text-white"
          >
            <LogOut className="h-3 w-3" />
            Sign Out
          </button>
        </div>
      </aside>

      <ConfirmModal
        isOpen={showSignOutModal}
        onClose={() => setShowSignOutModal(false)}
        title="Confirm Sign Out"
        description="Are you sure you want to log out of your account?"
        onConfirm={handleSignOut}
        confirmText={isSigningOut ? "Signing Out..." : "Sign Out"}
        cancelText="Cancel"
        isDestructive={true}
        loading={isSigningOut}
      />

      {/* Main content */}
      <main id="main-content" className="min-w-0 flex-1 overflow-y-auto p-4 pt-20 md:p-6 lg:p-8">
        <Outlet />
      </main>
    </div>
  );
}

