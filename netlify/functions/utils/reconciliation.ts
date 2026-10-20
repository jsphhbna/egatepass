import { FieldValue, type Firestore } from 'firebase-admin/firestore';

interface ReconciliationTask {
  reference: string;
  operation: string;
  targetUid: string;
  actorUid: string;
  reason: string;
  requiredActions: string[];
}

export async function recordReconciliationTask(
  db: Firestore,
  task: ReconciliationTask,
): Promise<boolean> {
  try {
    await db.collection('reconciliationTasks').doc(task.reference).set({
      operation: task.operation,
      targetType: task.operation.includes('device') ? 'device' : task.operation.includes('user') ? 'user' : 'pass',
      targetId: task.targetUid,
      targetUid: task.targetUid,
      actorUid: task.actorUid,
      reason: task.reason,
      requiredActions: task.requiredActions,
      status: 'pending',
      createdAt: FieldValue.serverTimestamp(),
    });
    return true;
  } catch (error) {
    console.error('CRITICAL: Failed to persist reconciliation task', {
      reference: task.reference,
      operation: task.operation,
      targetUid: task.targetUid,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    return false;
  }
}
