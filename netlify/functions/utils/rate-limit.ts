import crypto from 'crypto';
import { Timestamp, type Firestore } from 'firebase-admin/firestore';

export type RateLimitedOperation = 'cloudinary_sign' | 'create_pass';
export type RateLimitActorType = 'visitor' | 'kiosk';

interface WindowLimit {
  name: 'burst' | 'sustained';
  windowMs: number;
  uidLimit: number;
  ipLimit: number;
}

const POLICIES: Record<RateLimitedOperation, Record<RateLimitActorType, WindowLimit[]>> = {
  cloudinary_sign: {
    visitor: [
      { name: 'burst', windowMs: 60_000, uidLimit: 8, ipLimit: 120 },
      { name: 'sustained', windowMs: 3_600_000, uidLimit: 40, ipLimit: 1_000 },
    ],
    kiosk: [
      { name: 'burst', windowMs: 60_000, uidLimit: 200, ipLimit: 240 },
      { name: 'sustained', windowMs: 3_600_000, uidLimit: 2_000, ipLimit: 2_400 },
    ],
  },
  create_pass: {
    visitor: [
      { name: 'burst', windowMs: 600_000, uidLimit: 3, ipLimit: 60 },
      { name: 'sustained', windowMs: 86_400_000, uidLimit: 10, ipLimit: 500 },
    ],
    kiosk: [
      { name: 'burst', windowMs: 600_000, uidLimit: 100, ipLimit: 120 },
      { name: 'sustained', windowMs: 86_400_000, uidLimit: 1_000, ipLimit: 1_200 },
    ],
  },
};

export class RateLimitError extends Error {
  readonly statusCode = 429;

  constructor(public readonly retryAfterSeconds: number) {
    super('Too many requests. Please wait before trying again.');
  }
}

export function clientAddressFromHeaders(headers: Record<string, string | undefined>): string | null {
  const address = headers['x-nf-client-connection-ip'] || headers['X-Nf-Client-Connection-Ip'];
  if (typeof address !== 'string' || address.length === 0 || address.length > 64) return null;
  return address;
}

function subjectHash(kind: 'uid' | 'ip', value: string): string | null {
  const projectContext = process.env.FIREBASE_PROJECT_ID || process.env.GCLOUD_PROJECT || 'e-gatepass';
  if (kind === 'ip') {
    const secret = process.env.CRON_SECRET;
    if (!secret) return null;
    return crypto.createHmac('sha256', secret).update(`${projectContext}:rate-limit:ip:${value}`).digest('hex');
  }
  return crypto.createHash('sha256').update(`${projectContext}:rate-limit:uid:${value}`).digest('hex');
}

export async function enforceRateLimit(
  db: Firestore,
  input: {
    operation: RateLimitedOperation;
    actorType: RateLimitActorType;
    uid: string;
    clientAddress: string | null;
    nowMillis?: number;
  },
): Promise<void> {
  const nowMillis = input.nowMillis ?? Date.now();
  const uidHash = subjectHash('uid', input.uid)!;
  const ipHash = input.clientAddress ? subjectHash('ip', input.clientAddress) : null;
  const subjects = [
    { kind: 'uid' as const, hash: uidHash },
    ...(ipHash ? [{ kind: 'ip' as const, hash: ipHash }] : []),
  ];
  const counters = POLICIES[input.operation][input.actorType].flatMap((window) => subjects.map((subject) => {
    const bucketStart = Math.floor(nowMillis / window.windowMs) * window.windowMs;
    const limit = subject.kind === 'uid' ? window.uidLimit : window.ipLimit;
    const id = `${input.operation}_${input.actorType}_${window.name}_${subject.kind}_${bucketStart}_${subject.hash}`;
    return {
      reference: db.collection('rateLimits').doc(id),
      window,
      subject,
      bucketStart,
      limit,
    };
  }));

  await db.runTransaction(async (transaction) => {
    const snapshots = await Promise.all(counters.map((counter) => transaction.get(counter.reference)));
    let retryAfterSeconds = 0;
    snapshots.forEach((snapshot, index) => {
      const counter = counters[index];
      if (!counter) return;
      const count = typeof snapshot.data()?.count === 'number' ? snapshot.data()!.count : 0;
      if (count >= counter.limit) {
        retryAfterSeconds = Math.max(
          retryAfterSeconds,
          Math.max(1, Math.ceil((counter.bucketStart + counter.window.windowMs - nowMillis) / 1000)),
        );
      }
    });
    if (retryAfterSeconds > 0) throw new RateLimitError(retryAfterSeconds);

    snapshots.forEach((snapshot, index) => {
      const counter = counters[index];
      if (!counter) return;
      const count = typeof snapshot.data()?.count === 'number' ? snapshot.data()!.count : 0;
      transaction.set(counter.reference, {
        operation: input.operation,
        actorType: input.actorType,
        subjectType: counter.subject.kind,
        count: count + 1,
        windowStartedAt: Timestamp.fromMillis(counter.bucketStart),
        expiresAt: Timestamp.fromMillis(counter.bucketStart + counter.window.windowMs + 86_400_000),
        updatedAt: Timestamp.fromMillis(nowMillis),
      });
    });
  });
}

export function rateLimitPolicyFor(
  operation: RateLimitedOperation,
  actorType: RateLimitActorType,
): ReadonlyArray<Readonly<WindowLimit>> {
  return POLICIES[operation][actorType];
}
