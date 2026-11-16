import { createContext, useContext, useEffect, useState, useRef, type ReactNode } from 'react';
import type { User } from '@supabase/supabase-js';
import { toast } from 'sonner';
import { getSupabaseAvailabilityMessage, supabase } from '@/lib/supabase';
import type { AuthActor, AuthRole, AuthState, DeviceAuthActor, StaffAuthActor } from '@/types';
import { isUserRole } from '@/lib/permissions';

const unavailableMessage = getSupabaseAvailabilityMessage();

export interface ExtendedAuthState extends AuthState {
  aal: 'aal1' | 'aal2' | null;
  hasMfaEnabled: boolean;
  requiresMfa: boolean;
}

const initialState: ExtendedAuthState = {
  status: supabase ? 'loading' : 'unauthenticated',
  uid: null,
  role: null,
  userData: null,
  aal: null,
  hasMfaEnabled: false,
  requiresMfa: false,
  serviceStatus: supabase ? 'available' : 'unavailable',
  serviceMessage: unavailableMessage,
  refresh: async () => {},
};

const AuthContext = createContext<ExtendedAuthState>(initialState);

export function useAuth(): ExtendedAuthState {
  return useContext(AuthContext);
}

function parseTokenClaims(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split('.');
    const payload = parts[1];
    if (!payload) return null;
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(base64)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function resolveRole(user: User): Promise<{
  role: AuthRole;
  userData: AuthActor | null;
  aal: 'aal1' | 'aal2' | null;
  hasMfaEnabled: boolean;
}> {
  if (!supabase) return { role: null, userData: null, aal: null, hasMfaEnabled: false };
  if (user.is_anonymous === true) return { role: 'visitor', userData: null, aal: null, hasMfaEnabled: false };

  let aal: 'aal1' | 'aal2' | null = null;

  // Safety invariant: A recovery session must NEVER be treated as an operational staff session
  const { data: sessionData } = await supabase.auth.getSession();
  if (sessionData?.session?.access_token) {
    const claims = parseTokenClaims(sessionData.session.access_token);
    const isRecovery = Array.isArray(claims?.amr) && claims.amr.some((m: any) => m?.method === 'recovery');
    if (isRecovery) {
      return { role: null, userData: null, aal: null, hasMfaEnabled: false };
    }
    if (claims?.aal === 'aal1' || claims?.aal === 'aal2') {
      aal = claims.aal;
    } else {
      try {
        const { data: aalData } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
        if (aalData?.currentLevel === 'aal1') {
          aal = 'aal1';
        } else if (aalData?.currentLevel === 'aal2') {
          aal = 'aal2';
        }
      } catch {
        // Fallback silently if assurance level check is unsupported
      }
    }
  }

  const staffResult = await supabase
    .from('staff_profiles')
    .select('display_name, role, active, must_change_password, privacy_accepted_at')
    .eq('user_id', user.id)
    .maybeSingle();

  if (staffResult.error) throw staffResult.error;
  if (staffResult.data) {
    const profile = staffResult.data;
    if (!profile.active || !isUserRole(profile.role)) return { role: null, userData: null, aal: null, hasMfaEnabled: false };
    if (profile.role === 'guard') {
      await supabase.auth.signOut();
      return { role: null, userData: null, aal: null, hasMfaEnabled: false };
    }

    // Resolve MFA factors for human staff
    let hasMfaEnabled = false;
    if (aal === 'aal2') {
      hasMfaEnabled = true;
    } else {
      try {
        const { data: factorsData, error: factorsError } = await supabase.auth.mfa.listFactors();
        if (factorsError) {
          console.error('Failed to list MFA factors for staff:', factorsError);
          // Fail closed: treat as having MFA enabled to prevent unverified bypass
          hasMfaEnabled = true;
        } else {
          const factors = factorsData?.all ?? [];
          hasMfaEnabled = factors.some((f) => f.factor_type === 'totp' && f.status === 'verified') ||
            (factorsData?.totp?.length ?? 0) > 0;
        }
      } catch (factorErr) {
        console.error('Exception resolving staff MFA factors:', factorErr);
        // Fail closed
        hasMfaEnabled = true;
      }
    }

    const userData: StaffAuthActor = {
      kind: 'staff',
      name: profile.display_name,
      email: user.email ?? '',
      role: profile.role,
      active: profile.active,
      mustChangePassword: profile.must_change_password,
      privacyAcceptedAt: profile.privacy_accepted_at,
    };
    return { role: profile.role, userData, aal, hasMfaEnabled };
  }

  const deviceResult = await supabase
    .from('devices')
    .select('alias, name, type, gate, status')
    .eq('user_id', user.id)
    .maybeSingle();

  if (deviceResult.error) throw deviceResult.error;
  if (deviceResult.data?.status === 'active') {
    const device = deviceResult.data;
    const userData: DeviceAuthActor = {
      kind: 'device',
      alias: device.alias,
      name: device.name,
      type: device.type,
      gate: device.gate,
      status: device.status,
    };
    return { role: device.type, userData, aal, hasMfaEnabled: false };
  }

  return { role: null, userData: null, aal: null, hasMfaEnabled: false };
}

interface AuthProviderProps {
  children: ReactNode;
}

export function AuthProvider({ children }: AuthProviderProps) {
  const [state, setState] = useState<ExtendedAuthState>(initialState);
  const authGenerationRef = useRef(0);

  useEffect(() => {
    if (!supabase) return;
    let active = true;

    async function applyUser(user: User | null, generation: number) {
      if (!active || generation !== authGenerationRef.current) return;
      if (!user) {
        setState({ ...initialState, status: 'unauthenticated' });
        return;
      }

      try {
        const { role, userData, aal, hasMfaEnabled } = await resolveRole(user);
        if (!active || generation !== authGenerationRef.current) return;

        if (!role) {
          await supabase!.auth.signOut();
          if (active && generation === authGenerationRef.current) {
            setState({ ...initialState, status: 'unauthenticated' });
          }
          return;
        }

        if ((role === 'admin' || role === 'superadmin' || role === 'guard' || role === 'office_staff') && !user.email_confirmed_at) {
          await supabase!.auth.signOut();
          if (active && generation === authGenerationRef.current) {
            toast.error('Account not verified. Please verify your email first. Check your inbox, spam, or trash folder for the verification email.', { id: 'unverified-toast' });
            setState({ ...initialState, status: 'unauthenticated' });
          }
          return;
        }

        const requiresPasswordChange =
          userData?.kind === 'staff' &&
          userData.mustChangePassword === true;

        const isHumanStaff = userData?.kind === 'staff';
        const requiresMfa = isHumanStaff && hasMfaEnabled && aal !== 'aal2';

        if (active && generation === authGenerationRef.current) {
          setState({
            status: requiresPasswordChange ? 'requires_password_change' : 'authenticated',
            uid: user.id,
            role,
            userData,
            aal,
            hasMfaEnabled,
            requiresMfa,
            serviceStatus: 'available',
            serviceMessage: null,
            refresh,
          });
        }
      } catch (error) {
        console.error('Failed to resolve the signed-in identity.', error);
        if (active && generation === authGenerationRef.current) {
          setState({
            ...initialState,
            status: 'unauthenticated',
            serviceStatus: 'unavailable',
            serviceMessage: 'Staff and device services are temporarily unavailable. Please try again later.',
            refresh,
          });
        }
      }
    }

    const refresh = async () => {
      if (!supabase) return;
      const generation = ++authGenerationRef.current;
      const { data } = await supabase.auth.getSession();
      await applyUser(data.session?.user ?? null, generation);
    };

    const initialGeneration = ++authGenerationRef.current;
    void supabase.auth.getSession().then(({ data, error }) => {
      if (!active || initialGeneration !== authGenerationRef.current) return;
      if (error) {
        console.error('Unable to restore the sign-in session.', error);
        setState({ ...initialState, status: 'unauthenticated' });
        return;
      }
      void applyUser(data.session?.user ?? null, initialGeneration);
    });

    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      const generation = ++authGenerationRef.current;
      window.setTimeout(() => void applyUser(session?.user ?? null, generation), 0);
    });

    return () => {
      active = false;
      authGenerationRef.current++;
      listener.subscription.unsubscribe();
    };
  }, []);

  return <AuthContext.Provider value={state}>{children}</AuthContext.Provider>;
}