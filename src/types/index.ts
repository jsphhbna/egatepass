import { Timestamp } from 'firebase/firestore';

/* ============================================================
   USER ROLES
   ============================================================ */
export type UserRole = 'guard' | 'admin' | 'superadmin';

export type DeviceType = 'entry' | 'exit' | 'kiosk';

export type DeviceStatus = 'active' | 'revoked';

/* ============================================================
   PASS STATUS LIFECYCLE
   issued → pending → inside (approved) | rejected → exited
   expired is reached from issued when now > validUntil
   ============================================================ */
export type PassStatus =
  | 'issued'
  | 'pending'
  | 'inside'
  | 'rejected'
  | 'exited'
  | 'expired';

export type PassSource = 'portal' | 'kiosk';

/* ============================================================
   VISIT LOG EVENTS
   ============================================================ */
export type VisitLogEvent =
  | 'invalid_scan'
  | 'scan_entry'
  | 'approved'
  | 'rejected'
  | 'scan_exit';

/* ============================================================
   FIRESTORE DOCUMENT TYPES
   ============================================================ */
export interface Visitor {
  fullName: string;
  contactNumber: string;
  purpose: string;
  visitDate: string; // ISO date string YYYY-MM-DD
  idImagePublicId: string;
  photoPublicId: string;
  consentAcceptedAt: Timestamp;
  createdAt: Timestamp;
  createdByUid: string;
  imagesPurgedAt: Timestamp | null;
}

export interface GatePass {
  visitorId: string;
  visitorName: string;
  purpose: string;
  photoPublicId: string;
  idImagePublicId: string | null;
  source: PassSource;
  status: PassStatus;
  validFrom: Timestamp;
  validUntil: Timestamp;
  issuedAt: Timestamp;
  scannedAt: Timestamp | null;
  timeIn: Timestamp | null;
  timeOut: Timestamp | null;
  entryDeviceId: string | null;
  exitDeviceId: string | null;
  decidedByUid: string | null;
  rejectionReason: string | null;
  gate: string | null;
}

export interface VisitLog {
  passToken: string;
  visitorId: string;
  event: VisitLogEvent;
  reason: string | null;
  deviceId: string | null;
  gate: string | null;
  guardUid: string | null;
  guardName?: string | null;
  timestamp: Timestamp;
}

export interface AppUser {
  name: string;
  email: string;
  role: UserRole;
  active: boolean;
  privacyAcceptedAt: Timestamp | null;
  mustChangePassword?: boolean;
  createdAt: Timestamp;
}

export interface Device {
  name: string;
  type: DeviceType;
  gate: string;
  email?: string;
  status: DeviceStatus;
  createdBy: string;
  createdAt: Timestamp;
  lastSeen: Timestamp | null;
}

export interface AuditLog {
  actorUid: string;
  actorRole?: UserRole;
  action: string;
  target: string;
  targetUid?: string;
  previousRole?: UserRole;
  newRole?: UserRole;
  previousActive?: boolean;
  newActive?: boolean;
  details: string;
  timestamp: Timestamp;
}

export interface AppSettings {
  workingHours: {
    start: string; // "HH:mm" format
    end: string;
    timezone: 'Asia/Manila';
  };
  rejectionReasons: string[];
  visitPurposes: VisitPurposeOption[];
  retentionDays: number;
  peakMode: boolean;
}

export interface VisitPurposeOption {
  label: string;
  requiresDetails: boolean;
  detailPrompt: string;
}

/* ============================================================
   AUTH CONTEXT TYPES
   ============================================================ */
export type AuthRole = UserRole | DeviceType | 'visitor' | null;

export interface AuthState {
  status: 'loading' | 'authenticated' | 'unauthenticated' | 'requires_password_change';
  uid: string | null;
  role: AuthRole;
  userData: AppUser | Device | null;
}
