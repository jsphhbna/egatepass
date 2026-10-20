import { FieldValue, type Firestore, type Transaction, type WriteBatch } from 'firebase-admin/firestore';
import type { StaffRole } from './auth';

export type AuditActorRole = StaffRole | 'system';
export type AuditResult = 'success' | 'failure' | 'partial' | 'pending';

export interface AdministrativeAuditEvent {
  action: string;
  actorUid: string;
  actorRole: AuditActorRole;
  targetType: string;
  targetId: string;
  targetUid?: string;
  previousRole?: StaffRole | null;
  newRole?: StaffRole | null;
  previousStatus?: string | boolean | null;
  newStatus?: string | boolean | null;
  result: AuditResult;
  metadata?: Record<string, unknown>;
}

export function administrativeAuditData(event: AdministrativeAuditEvent): Record<string, unknown> {
  return {
    action: event.action,
    actorUid: event.actorUid,
    actorRole: event.actorRole,
    targetType: event.targetType,
    targetId: event.targetId,
    ...(event.targetUid ? { targetUid: event.targetUid } : {}),
    ...(event.previousRole !== undefined ? { previousRole: event.previousRole } : {}),
    ...(event.newRole !== undefined ? { newRole: event.newRole } : {}),
    ...(event.previousStatus !== undefined ? { previousStatus: event.previousStatus } : {}),
    ...(event.newStatus !== undefined ? { newStatus: event.newStatus } : {}),
    result: event.result,
    ...(event.metadata ? { metadata: event.metadata } : {}),
    timestamp: FieldValue.serverTimestamp(),
  };
}

export function createAdministrativeAudit(
  writer: Transaction | WriteBatch,
  db: Firestore,
  event: AdministrativeAuditEvent,
): string {
  const auditRef = db.collection('auditLogs').doc();
  writer.create(auditRef, administrativeAuditData(event));
  return auditRef.id;
}

export async function writeAdministrativeAudit(db: Firestore, event: AdministrativeAuditEvent): Promise<string> {
  const auditRef = db.collection('auditLogs').doc();
  await auditRef.create(administrativeAuditData(event));
  return auditRef.id;
}
