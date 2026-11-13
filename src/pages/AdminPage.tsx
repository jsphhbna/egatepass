import { NavLink, Outlet, useNavigate, useLocation, Link } from 'react-router-dom';
import { signOutCurrentActor } from '@/services/auth';
import { useAuth } from '@/hooks/useAuth';
import {
  ChevronDown,
  ChevronRight,
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
  Printer,
} from 'lucide-react';
import { BrandMark } from '@/components/BrandMark';
import { ConfirmModal } from '@/components/ui';
import { useState, useRef, useEffect } from 'react';
import { formatUserRole, isSuperAdmin } from '@/lib/permissions';
import { RouteErrorBoundary } from '@/components/RouteErrorBoundary';

interface NavChildItem {
  to: string;
  label: string;
}

interface NavGroupItem {
  id: string;
  label: string;
  icon: any;
  basePath: string;
  children?: NavChildItem[];
  superAdminOnly?: boolean;
}

const navGroups: NavGroupItem[] = [
  {
    id: 'dashboard',
    label: 'Dashboard',
    icon: LayoutDashboard,
    basePath: '/admin',
    children: [
      { to: '/admin?tab=overview', label: 'Overview' },
      { to: '/admin?tab=analytics', label: 'Analytics' },
    ],
  },
  {
    id: 'visitors',
    label: 'Visitors',
    icon: FileText,
    basePath: '/admin/visitors',
    children: [
      { to: '/admin/visitors?tab=search', label: 'Search & Records' },
      { to: '/admin/visitors?tab=reports', label: 'Visitor Reports' },
      { to: '/admin/visitors?tab=offline', label: 'Offline Mode Recorded' },
    ],
  },
  {
    id: 'devices',
    label: 'Devices',
    icon: Tablet,
    basePath: '/admin/devices',
    children: [
      { to: '/admin/devices?tab=all', label: 'All Terminals' },
      { to: '/admin/devices?tab=scanners', label: 'Gate Scanners' },
      { to: '/admin/devices?tab=stations', label: 'Kiosks & Stations' },
    ],
  },
  {
    id: 'users',
    label: 'Users',
    icon: Users,
    basePath: '/admin/users',
    children: [
      { to: '/admin/users?tab=staff', label: 'Staff Accounts' },
      { to: '/admin/users?tab=directory', label: 'Office Directory' },
    ],
  },
  { id: 'emergency', label: 'Emergency', icon: AlertTriangle, basePath: '/admin/emergency' },
  { id: 'audit', label: 'Audit Logs', icon: ClipboardList, basePath: '/admin/audit' },
  { id: 'templates', label: 'Print Templates', icon: Printer, basePath: '/admin/templates', superAdminOnly: true },
  {
    id: 'settings',
    label: 'Settings',
    icon: Settings,
    basePath: '/admin/settings',
    children: [
      { to: '/admin/settings?tab=general', label: 'General' },
      { to: '/admin/settings?tab=calendar', label: 'Campus Calendar' },
      { to: '/admin/settings?tab=visitor_ux', label: 'Visitor Experience' },
      { to: '/admin/settings?tab=security', label: 'Security & Privacy' },
      { to: '/admin/settings?tab=retention', label: 'Data Retention' },
      { to: '/admin/settings?tab=personal', label: 'Personal Profile' },
    ],
  },
];

export function AdminPage() {
  const { userData, role } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});
  const triggerButtonRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLElement>(null);

  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!sidebarOpen) return;

    // Move focus into the drawer when opened
    const timer = setTimeout(() => {
      closeButtonRef.current?.focus();
    }, 50);

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        setSidebarOpen(false);
        triggerButtonRef.current?.focus();
        return;
      }

      if (event.key === 'Tab' && drawerRef.current) {
        const focusables = drawerRef.current.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        );
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (!first || !last) return;

        if (event.shiftKey) {
          if (document.activeElement === first) {
            event.preventDefault();
            last.focus();
          }
        } else {
          if (document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [sidebarOpen]);

  const adminName = userData?.kind === 'staff' ? userData.name : 'Admin';
  const adminRoleLabel = isSuperAdmin(role) ? formatUserRole('superadmin') : 'Admin';

  const [isSigningOut, setIsSigningOut] = useState(false);
  const [showSignOutModal, setShowSignOutModal] = useState(false);

  async function handleSignOut() {
    setIsSigningOut(true);
    try {
      await signOutCurrentActor();
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
        ref={triggerButtonRef}
        type="button"
        onClick={() => setSidebarOpen(true)}
        className="fixed left-3 top-3 z-40 flex min-h-11 min-w-11 items-center justify-center rounded-md border border-[var(--color-border)] bg-white text-[var(--color-text-primary)] shadow-sm md:hidden"
        aria-label="Open menu"
        aria-expanded={sidebarOpen}
        aria-controls="admin-navigation-drawer"
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
        id="admin-navigation-drawer"
        ref={drawerRef}
        role={sidebarOpen ? 'dialog' : undefined}
        aria-modal={sidebarOpen ? 'true' : undefined}
        aria-label="Administrative navigation"
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
            ref={closeButtonRef}
            type="button"
            onClick={() => {
              setSidebarOpen(false);
              triggerButtonRef.current?.focus();
            }}
            className="flex min-h-11 min-w-11 items-center justify-center rounded-md text-white/70 hover:bg-white/10 hover:text-white md:hidden"
            aria-label="Close menu"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Nav */}
        <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-1" aria-label="Admin navigation">
          {navGroups
            .filter((item) => !item.superAdminOnly || isSuperAdmin(role))
            .map((item) => {
              const Icon = item.icon;
              const hasChildren = Boolean(item.children && item.children.length > 0);
              const isParentActive =
                item.basePath === '/admin'
                  ? location.pathname === '/admin'
                  : location.pathname.startsWith(item.basePath);
              const isExpanded = expandedGroups[item.id] ?? isParentActive;

              return (
                <div key={item.id} className="space-y-1">
                  {hasChildren ? (
                    <div>
                      <button
                        type="button"
                        onClick={() => {
                          setExpandedGroups((prev) => ({
                            ...prev,
                            [item.id]: !isExpanded,
                          }));
                        }}
                        className={`flex min-h-11 w-full items-center justify-between rounded-md px-3 text-sm font-semibold transition-colors ${
                          isParentActive
                            ? 'bg-white/15 text-white'
                            : 'text-white/75 hover:bg-white/10 hover:text-white'
                        }`}
                        aria-expanded={isExpanded}
                      >
                        <div className="flex items-center gap-3">
                          <Icon className="h-4 w-4" />
                          <span>{item.label}</span>
                        </div>
                        {isExpanded ? (
                          <ChevronDown className="h-4 w-4 opacity-70" />
                        ) : (
                          <ChevronRight className="h-4 w-4 opacity-70" />
                        )}
                      </button>

                      {isExpanded && item.children && (
                        <div className="ml-5 pl-2 mt-1 border-l border-white/15 space-y-1">
                          {item.children.map((child) => {
                            const currentFull = location.pathname + location.search;
                            const isChildActive =
                              child.to.includes('tab=overview')
                                ? location.pathname === '/admin' && (!location.search || location.search === '?tab=overview')
                                : child.to.includes('tab=general')
                                ? location.pathname === '/admin/settings' && (!location.search || location.search === '?tab=general')
                                : child.to.includes('tab=search')
                                ? location.pathname === '/admin/visitors' && (!location.search || location.search === '?tab=search')
                                : child.to.includes('tab=staff')
                                ? location.pathname === '/admin/users' && (!location.search || location.search === '?tab=staff')
                                : child.to.includes('admin/devices?tab=all')
                                ? location.pathname === '/admin/devices' && (!location.search || location.search === '?tab=all')
                                : currentFull === child.to;

                            return (
                              <Link
                                key={child.to}
                                to={child.to}
                                onClick={() => setSidebarOpen(false)}
                                className={`flex min-h-9 items-center rounded-md px-2.5 text-xs font-medium no-underline transition-colors ${
                                  isChildActive
                                    ? 'bg-white text-[var(--color-brand-dark)] font-bold shadow-xs'
                                    : 'text-white/70 hover:bg-white/10 hover:text-white'
                                }`}
                              >
                                <span>{child.label}</span>
                              </Link>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  ) : (
                    <NavLink
                      to={item.basePath}
                      onClick={() => setSidebarOpen(false)}
                      className={({ isActive }) =>
                        `flex min-h-11 items-center gap-3 rounded-md px-3 text-sm font-semibold no-underline transition-colors ${
                          isActive
                            ? 'bg-white text-[var(--color-brand-dark)] shadow-sm'
                            : 'text-white/75 hover:bg-white/10 hover:text-white'
                        }`
                      }
                    >
                      <Icon className="h-4 w-4" />
                      <span>{item.label}</span>
                    </NavLink>
                  )}
                </div>
              );
            })}
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
      <main id="main-content" aria-hidden={sidebarOpen ? 'true' : undefined} inert={sidebarOpen ? true : undefined} className="min-w-0 flex-1 overflow-y-auto p-4 pt-20 md:p-6 lg:p-8 xl:p-10">
        <div className="mx-auto w-full max-w-7xl 2xl:max-w-[1600px]">
          <RouteErrorBoundary>
            <Outlet />
          </RouteErrorBoundary>
        </div>
      </main>
    </div>
  );
}
