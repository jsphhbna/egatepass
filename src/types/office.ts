export type OfficeApprovalStatus = 'not_required' | 'pending' | 'approved' | 'rejected';

export type OfficeAttendanceStatus =
  | 'awaiting_entry'
  | 'awaiting_office_confirmation'
  | 'confirmed'
  | 'exited_unconfirmed'
  | 'completed'
  | 'cancelled'
  | 'expired';

export type OfficeVisitType = 'general' | 'specific_person';

export interface Office {
  id: string;
  name: string;
  description?: string | null;
  active: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface OfficePersonnel {
  id: string;
  officeId: string;
  name: string;
  title: string;
  active: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface OfficeStaffAssignment {
  id: string;
  userId: string;
  officeId: string;
  officeName?: string;
  createdAt?: string;
}

export interface OfficeVisitRecord {
  id: string;
  visitType: OfficeVisitType;
  officeId: string;
  officeName?: string;
  personnelId?: string | null;
  personnelName?: string | null;
  personnelTitle?: string | null;

  approvalStatus: OfficeApprovalStatus;
  rejectionReason?: string | null;
  decidedAt?: string | null;
  decidedBy?: string | null;

  attendanceStatus: OfficeAttendanceStatus;
  confirmedAt?: string | null;
  confirmedBy?: string | null;

  visitorId?: string | null;
  passId?: string | null;

  visitorFirstName: string;
  visitorMiddleName?: string | null;
  visitorLastName: string;
  visitorFullName: string;
  visitorDisplayName?: string | null;
  visitorName?: string;
  portraitPreviewToken?: string | null;
  visitorContactNumber: string;
  visitorEmail?: string | null;
  visitorEmailVerified: boolean;
  visitorPhotoPath?: string | null;
  visitorIdPath?: string | null;

  purpose: string;
  visitDate: string;
  arrivalMode: 'no_vehicle' | 'vehicle';

  vehicleDetails?: {
    vehicleType?: string;
    plateNumber?: string;
    color?: string;
    makeModel?: string;
  } | null;

  addressDetails?: {
    regionName?: string;
    provinceName?: string;
    cityName?: string;
    barangayName?: string;
    homeBuilding?: string;
    homeStreet?: string;
    postalCode?: string;
  } | null;

  gateEntryScannedAt?: string | null;
  timeIn?: string | null;
  timeOut?: string | null;
  passStatus?: string | null;

  emailDeliveryStatus?: 'none' | 'pending' | 'processing' | 'sent' | 'delivered' | 'failed' | 'unknown' | 'reconciliation_required' | null;
  emailDispatchedAt?: string | null;
  emailError?: string | null;
  outboxStatus?: 'pending' | 'processing' | 'sent' | 'delivered' | 'failed' | 'unknown' | 'reconciliation_required' | null;
  providerMessageId?: string | null;
  leaseExpiresAt?: string | null;
  retryCount?: number;
  registrationMode?: 'new' | 'returning';

  requestId: string;
  createdAt: string;
  updatedAt: string;
}

export interface OfficeVisitEvent {
  id: string;
  officeVisitId: string;
  eventType: string;
  actorId?: string | null;
  actorRole?: string | null;
  metadata?: Record<string, unknown> | null;
  createdAt: string;
}
