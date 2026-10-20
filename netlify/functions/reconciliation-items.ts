import type { Handler } from '@netlify/functions';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { handleAuthError, requireSuperAdmin } from './utils/auth';

function jsonResponse(statusCode: number, body: object) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'GET') return jsonResponse(405, { error: 'Method not allowed' });

  try {
    await requireSuperAdmin(event.headers.authorization || event.headers.Authorization);
    const snapshot = await getFirestore()
      .collection('reconciliationTasks')
      .where('status', '==', 'pending')
      .limit(50)
      .get();

    const items = snapshot.docs
      .map((document) => {
        const data = document.data();
        const createdAt = data.createdAt instanceof Timestamp ? data.createdAt.toDate().toISOString() : null;
        return {
          id: document.id,
          type: typeof data.operation === 'string' ? data.operation : 'unknown',
          status: 'unresolved',
          targetType: typeof data.targetType === 'string' ? data.targetType : 'resource',
          targetId: typeof data.targetId === 'string'
            ? data.targetId
            : typeof data.targetUid === 'string' ? data.targetUid : 'unknown',
          createdAt,
          summary: typeof data.reason === 'string' ? data.reason : 'Manual investigation is required',
          requiredActions: Array.isArray(data.requiredActions)
            ? data.requiredActions.filter((action): action is string => typeof action === 'string').slice(0, 10)
            : [],
        };
      })
      .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));

    return jsonResponse(200, { items, count: items.length, limit: 50, readOnly: true });
  } catch (error) {
    console.error('Error listing reconciliation items', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    return handleAuthError(error);
  }
};
