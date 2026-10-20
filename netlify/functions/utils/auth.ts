import { getFirestore } from 'firebase-admin/firestore';
import { adminAuth } from '../firebase-admin';

export type StaffRole = 'guard' | 'admin' | 'superadmin';

export interface AuthContext {
  uid: string;
  email: string;
  role: StaffRole;
}

const STAFF_ROLES: readonly StaffRole[] = ['guard', 'admin', 'superadmin'];

function isStaffRole(value: unknown): value is StaffRole {
  return typeof value === 'string' && STAFF_ROLES.includes(value as StaffRole);
}

export async function requireAuth(authHeader: string | undefined): Promise<AuthContext> {
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw new Error('Unauthorized: Missing or invalid authorization header');
  }

  const token = authHeader.slice('Bearer '.length);
  let decodedToken;
  try {
    decodedToken = await adminAuth.verifyIdToken(token);
  } catch {
    throw new Error('Unauthorized: Invalid or expired token');
  }
  
  if (!decodedToken.email_verified) {
    throw new Error('Forbidden: Email not verified');
  }

  const db = getFirestore();
  const userDoc = await db.collection('users').doc(decodedToken.uid).get();

  if (!userDoc.exists) {
    throw new Error('Forbidden: User record not found');
  }

  const userData = userDoc.data();
  if (userData?.active !== true) {
    throw new Error('Forbidden: Account is deactivated');
  }
  if (!isStaffRole(userData.role)) {
    throw new Error('Forbidden: Account role is invalid');
  }

  return {
    uid: decodedToken.uid,
    email: decodedToken.email || '',
    role: userData.role,
  };
}

export async function requireRole(authHeader: string | undefined, allowedRoles: string[]): Promise<AuthContext> {
  const context = await requireAuth(authHeader);
  if (!allowedRoles.includes(context.role)) {
    console.warn('Authorization denied', {
      actorUid: context.uid,
      actorRole: context.role,
      allowedRoles,
    });
    throw new Error(`Forbidden: Requires one of roles: ${allowedRoles.join(', ')}`);
  }
  return context;
}

export async function requireAdmin(authHeader: string | undefined): Promise<AuthContext> {
  return requireRole(authHeader, ['admin', 'superadmin']);
}

export async function requireSuperAdmin(authHeader: string | undefined): Promise<AuthContext> {
  return requireRole(authHeader, ['superadmin']);
}

export async function requireGuardOrAdmin(authHeader: string | undefined): Promise<AuthContext> {
  return requireRole(authHeader, ['admin', 'superadmin', 'guard']);
}

export function handleAuthError(error: unknown) {
  const message = error instanceof Error ? error.message : 'Internal Server Error';
  const statusCode = message.startsWith('Unauthorized') ? 401 : message.startsWith('Forbidden') ? 403 : 500;
  
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ error: statusCode === 500 ? 'Internal Server Error' : message }),
  };
}
