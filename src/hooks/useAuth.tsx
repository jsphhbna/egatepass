import { createContext, useContext, useEffect, useState, useRef, type ReactNode } from 'react';
import type { User } from '@supabase/supabase-js';
import { toast } from 'sonner';
import { getSupabaseAvailabilityMessage, supabase } from '@/lib/supabase';
import type { AuthActor, AuthRole, AuthState, DeviceAuthActor, StaffAuthActor } from '@/types';
import { isUserRole } from '@/lib/permissions';

const unavailableMessage = getSupabaseAvailabilityMessage();

const initialState: AuthState = {
  status: supabase ? 'loading' : 'unauthenticated',
  uid: null,
  role: null,
  userData: null,
  serviceStatus: supabase ? 'available' : 'unavailable',
  serviceMessage: unavailableMessage,
  refresh: async () => {},
};

const AuthContext = createContext<AuthState>(initialState);

export function useAuth(): AuthState {
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

async function resolveRole(user: User): Promise<{ role: AuthRole; userData: AuthActor | null }> {
  if (!supabase) return { role: null, userData: null };
  if (user.is_anonymous === true) return { role: 'visitor', userData: null };

  // Safety invariant: A recovery session must NEVER be treated as an operational staff session
  const { data: sessionData } = await supabase.auth.getSession();
  if (sessionData?.session?.access_token) {
    const claims = parseTokenClaims(sessionData.session.access_token);
    const isRecovery = Array.isArray(claims?.amr) && claims.amr.some((m: any) => m?.method === 'recovery');
    if (isRecovery) {
      return { role: null, userData: null };
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
    if (!profile.active || !isUserRole(profile.role)) return { role: null, userData: null };
    if (profile.role === 'guard') {
      await supabase.auth.signOut();
      return { role: null, userData: null };
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
    return { role: profile.role, userData };
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
    return { role: device.type, userData };
  }

  return { role: null, userData: null };
}

interface AuthProviderProps {
  children: ReactNode;
}

export function AuthProvider({ children }: AuthProviderProps) {
  const [state, setState] = useState<AuthState>(initialState);
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
        const { role, userData } = await resolveRole(user);
        if (!active || generation !== authGenerationRef.current) return;

        if (!role) {
          await supabase!.auth.signOut();
          if (active && generation === authGenerationRef.current) {
            setState({ ...initialState, status: 'unauthenticated' });
          }
          return;
        }

        if ((role === 'admin' || role === 'superadmin' || role === 'guard') && !user.email_confirmed_at) {
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

        if (active && generation === authGenerationRef.current) {
          setState({
            status: requiresPasswordChange ? 'requires_password_change' : 'authenticated',
            uid: user.id,
            role,
            userData,
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