import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import { onAuthStateChanged, signOut, type User } from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';
import { auth, db } from '@/lib/firebase';
import { toast } from 'sonner';
import type { AppUser, AuthRole, AuthState, Device } from '@/types';
import { isUserRole } from '@/lib/permissions';

const AuthContext = createContext<AuthState>({
  status: 'loading',
  uid: null,
  role: null,
  userData: null,
});

export function useAuth(): AuthState {
  return useContext(AuthContext);
}

/**
 * Resolves the role of the signed-in user by checking Firestore documents.
 * Order: users/{uid} (guard/admin) → devices/{uid} (entry/exit/kiosk) → anonymous visitor
 */
async function resolveRole(
  user: User
): Promise<{ role: AuthRole; userData: AppUser | Device | null }> {
  // Check if this is an anonymous user (visitor)
  if (user.isAnonymous) {
    return { role: 'visitor', userData: null };
  }

  // Check users collection (guard/admin)
  const userDoc = await getDoc(doc(db, 'users', user.uid));
  if (userDoc.exists()) {
    const data = userDoc.data() as AppUser;
    if (data.active && isUserRole(data.role)) {
      return { role: data.role, userData: data };
    }
    // Inactive user — treat as unauthenticated
    return { role: null, userData: null };
  }

  // Check devices collection
  const deviceDoc = await getDoc(doc(db, 'devices', user.uid));
  if (deviceDoc.exists()) {
    const data = deviceDoc.data() as Device;
    if (data.status === 'active') {
      return { role: data.type, userData: data };
    }
    // Revoked device — treat as unauthenticated
    return { role: null, userData: null };
  }

  // No matching document — unknown role
  return { role: null, userData: null };
}

interface AuthProviderProps {
  children: ReactNode;
}

export function AuthProvider({ children }: AuthProviderProps) {
  const [state, setState] = useState<AuthState>({
    status: 'loading',
    uid: null,
    role: null,
    userData: null,
  });

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      if (!user) {
        setState({
          status: 'unauthenticated',
          uid: null,
          role: null,
          userData: null,
        });
        return;
      }

      try {
        const { role, userData } = await resolveRole(user);

        if (!role) {
          await signOut(auth);
          setState({
            status: 'unauthenticated',
            uid: null,
            role: null,
            userData: null,
          });
          return;
        }

        if (role === 'admin' || role === 'superadmin' || role === 'guard') {
          await user.reload();
          if (!auth.currentUser?.emailVerified) {
            await signOut(auth);
            toast.error(
              'Account not verified. Please verify your email first. Check your inbox, spam, or trash folder for the verification email.',
              { id: 'unverified-toast' }
            );
            // setState to unauthenticated will happen on the next onAuthStateChanged(null)
            return;
          }
          // Force token refresh so Firestore rules receive email_verified: true
          await auth.currentUser?.getIdToken(true);
        }

        if (role === 'guard' && userData && 'mustChangePassword' in userData && userData.mustChangePassword === true) {
          setState({
            status: 'requires_password_change',
            uid: user.uid,
            role,
            userData,
          });
          return;
        }

        setState({
          status: 'authenticated',
          uid: user.uid,
          role,
          userData,
        });
      } catch (error) {
        console.error('Failed to resolve user role:', error);
        setState({
          status: 'unauthenticated',
          uid: null,
          role: null,
          userData: null,
        });
      }
    });

    return unsubscribe;
  }, []);

  return <AuthContext.Provider value={state}>{children}</AuthContext.Provider>;
}
