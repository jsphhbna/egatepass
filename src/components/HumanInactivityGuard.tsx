import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Clock, LogOut, ShieldAlert } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/lib/supabase';
import type { AuthActor, AuthRole, AuthState } from '@/types';
import { Button, Modal } from '@/components/ui';

export const HUMAN_IDLE_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes
export const HUMAN_IDLE_WARNING_MS = 60 * 1000; // Final 60s countdown
export const HUMAN_ACTIVITY_TOUCH_INTERVAL_MS = 60 * 1000; // Sync activity to server at most once per minute
export const HUMAN_ACTIVITY_STORAGE_KEY = 'egatepass_human_last_activity_ms';
export const HUMAN_LOGOUT_STORAGE_KEY = 'egatepass_human_idle_expired_at';
export const HUMAN_ACTIVITY_CHANNEL = 'egatepass-human-inactivity';

export function isHumanStaffSession(
  status: AuthState['status'],
  role: AuthRole,
  userData: AuthActor | null,
): boolean {
  if (status !== 'authenticated' && status !== 'requires_password_change') {
    return false;
  }
  if (!userData || userData.kind !== 'staff') {
    return false;
  }
  return role === 'admin' || role === 'superadmin' || role === 'office_staff';
}

export interface IdleStatusSnapshot {
  elapsedMs: number;
  remainingMs: number;
  remainingSeconds: number;
  showWarning: boolean;
  expired: boolean;
}

export function computeIdleStatus(
  lastActivityMs: number,
  nowMs: number,
  timeoutMs: number = HUMAN_IDLE_TIMEOUT_MS,
  warningMs: number = HUMAN_IDLE_WARNING_MS,
): IdleStatusSnapshot {
  const safeLast = Number.isFinite(lastActivityMs) ? lastActivityMs : nowMs;
  const elapsedMs = Math.max(0, nowMs - safeLast);
  const remainingMs = Math.max(0, timeoutMs - elapsedMs);
  const remainingSeconds = Math.ceil(remainingMs / 1000);
  const expired = remainingMs <= 0;
  const showWarning = !expired && remainingMs <= warningMs;

  return {
    elapsedMs,
    remainingMs,
    remainingSeconds,
    showWarning,
    expired,
  };
}

async function getBearerAccessToken(): Promise<string | null> {
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

async function callSessionActivityApi(action: 'touch' | 'expire'): Promise<'ok' | 'expired' | 'unavailable'> {
  try {
    const token = await getBearerAccessToken();
    if (!token) return 'expired';
    const res = await fetch('/api/auth/session-activity', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ action }),
    });
    if (res.status === 401) {
      return 'expired';
    }
    return res.ok ? 'ok' : 'unavailable';
  } catch {
    return 'unavailable';
  }
}

export function HumanInactivityGuard() {
  const { status, uid, role, userData } = useAuth();
  const navigate = useNavigate();
  const isHuman = isHumanStaffSession(status, role, userData);

  const [showWarning, setShowWarning] = useState(false);
  const [remainingSeconds, setRemainingSeconds] = useState(Math.ceil(HUMAN_IDLE_WARNING_MS / 1000));
  const [stayingSignedIn, setStayingSignedIn] = useState(false);

  const lastActivityRef = useRef<number>(Date.now());
  const lastServerTouchRef = useRef<number>(0);
  const warningOpenRef = useRef<boolean>(false);
  const expiringRef = useRef<boolean>(false);
  const channelRef = useRef<BroadcastChannel | null>(null);

  useEffect(() => {
    warningOpenRef.current = showWarning;
  }, [showWarning]);

  const broadcastMessage = useCallback((payload: { type: 'activity'; ts: number } | { type: 'expire'; ts: number }) => {
    try {
      if (payload.type === 'activity') {
        window.localStorage.setItem(HUMAN_ACTIVITY_STORAGE_KEY, String(payload.ts));
      } else {
        window.localStorage.setItem(HUMAN_LOGOUT_STORAGE_KEY, String(payload.ts));
      }
    } catch {
      // Ignore storage quota / private mode issues
    }
    try {
      channelRef.current?.postMessage(payload);
    } catch {
      // Ignore channel failures
    }
  }, []);

  const performIdleSignOut = useCallback(async (fromRemoteTab: boolean = false) => {
    if (expiringRef.current) return;
    expiringRef.current = true;
    setShowWarning(false);
    warningOpenRef.current = false;

    const nowMs = Date.now();
    if (!fromRemoteTab) {
      broadcastMessage({ type: 'expire', ts: nowMs });
      await callSessionActivityApi('expire');
    }

    try {
      window.localStorage.removeItem(HUMAN_ACTIVITY_STORAGE_KEY);
    } catch {
      // Ignore cleanup errors
    }

    try {
      await supabase?.auth.signOut();
    } catch {
      // Ignore signOut failures when token is already invalidated
    }

    toast.info('Session signed out after 15 minutes of inactivity.', { id: 'idle-timeout-toast' });
    navigate('/login?reason=idle_timeout', { replace: true });
  }, [broadcastMessage, navigate]);

  const recordHumanActivity = useCallback(async (forceServerTouch: boolean = false) => {
    const nowMs = Date.now();
    lastActivityRef.current = nowMs;
    broadcastMessage({ type: 'activity', ts: nowMs });

    if (forceServerTouch || nowMs - lastServerTouchRef.current >= HUMAN_ACTIVITY_TOUCH_INTERVAL_MS) {
      lastServerTouchRef.current = nowMs;
      const outcome = await callSessionActivityApi('touch');
      if (outcome === 'expired') {
        await performIdleSignOut(false);
      }
    }
  }, [broadcastMessage, performIdleSignOut]);

  const handleStaySignedIn = useCallback(async () => {
    if (stayingSignedIn || expiringRef.current) return;
    setStayingSignedIn(true);
    try {
      const nowMs = Date.now();
      lastActivityRef.current = nowMs;
      lastServerTouchRef.current = nowMs;
      broadcastMessage({ type: 'activity', ts: nowMs });
      const outcome = await callSessionActivityApi('touch');
      if (outcome === 'expired') {
        await performIdleSignOut(false);
        return;
      }
      setShowWarning(false);
      warningOpenRef.current = false;
      setRemainingSeconds(Math.ceil(HUMAN_IDLE_TIMEOUT_MS / 1000));
    } finally {
      setStayingSignedIn(false);
    }
  }, [broadcastMessage, performIdleSignOut, stayingSignedIn]);

  useEffect(() => {
    if (!isHuman) {
      expiringRef.current = false;
      setShowWarning(false);
      warningOpenRef.current = false;
      return;
    }

    expiringRef.current = false;
    const nowMs = Date.now();
    lastActivityRef.current = nowMs;
    lastServerTouchRef.current = 0;
    broadcastMessage({ type: 'activity', ts: nowMs });

    // Validate/touch server session immediately on mount or session restore
    void recordHumanActivity(true);

    let channel: BroadcastChannel | null = null;
    if (typeof window !== 'undefined' && typeof window.BroadcastChannel === 'function') {
      try {
        channel = new window.BroadcastChannel(HUMAN_ACTIVITY_CHANNEL);
        channelRef.current = channel;
        channel.onmessage = (event) => {
          const msg = event.data as { type?: string; ts?: number } | null;
          if (!msg) return;
          if (msg.type === 'activity' && typeof msg.ts === 'number' && msg.ts > lastActivityRef.current) {
            lastActivityRef.current = msg.ts;
            if (warningOpenRef.current) {
              setShowWarning(false);
              warningOpenRef.current = false;
            }
          } else if (msg.type === 'expire') {
            void performIdleSignOut(true);
          }
        };
      } catch {
        channelRef.current = null;
      }
    }

    const onStorage = (event: StorageEvent) => {
      if (event.key === HUMAN_ACTIVITY_STORAGE_KEY && event.newValue) {
        const remoteTs = Number(event.newValue);
        if (Number.isFinite(remoteTs) && remoteTs > lastActivityRef.current) {
          lastActivityRef.current = remoteTs;
          if (warningOpenRef.current) {
            setShowWarning(false);
            warningOpenRef.current = false;
          }
        }
      } else if (event.key === HUMAN_LOGOUT_STORAGE_KEY && event.newValue) {
        void performIdleSignOut(true);
      }
    };

    const onUserInteraction = () => {
      // Once the 60s final warning modal is open, require explicit button confirmation
      if (warningOpenRef.current || expiringRef.current) return;
      const eventNow = Date.now();
      if (eventNow - lastActivityRef.current < 1000) return;
      void recordHumanActivity(false);
    };

    const events: Array<keyof WindowEventMap> = [
      'pointerdown',
      'keydown',
      'mousemove',
      'scroll',
      'touchstart',
    ];
    for (const ev of events) {
      window.addEventListener(ev, onUserInteraction, { passive: true });
    }
    window.addEventListener('storage', onStorage);

    const intervalId = window.setInterval(() => {
      if (expiringRef.current) return;
      const snap = computeIdleStatus(lastActivityRef.current, Date.now());
      if (snap.expired) {
        void performIdleSignOut(false);
        return;
      }
      setRemainingSeconds(snap.remainingSeconds);
      if (snap.showWarning !== warningOpenRef.current) {
        setShowWarning(snap.showWarning);
        warningOpenRef.current = snap.showWarning;
      }
    }, 1000);

    return () => {
      window.clearInterval(intervalId);
      for (const ev of events) {
        window.removeEventListener(ev, onUserInteraction);
      }
      window.removeEventListener('storage', onStorage);
      if (channel) {
        channel.close();
        channelRef.current = null;
      }
    };
  }, [broadcastMessage, isHuman, performIdleSignOut, recordHumanActivity, uid]);

  if (!isHuman || !showWarning) {
    return null;
  }

  return (
    <Modal
      isOpen={true}
      onClose={() => {}}
      preventClose={true}
      title="Session Inactivity Timeout"
      description="Your staff session is about to sign out after 15 minutes of inactivity."
      size="sm"
    >
      <div className="space-y-5">
        <div className="flex items-start gap-3 rounded-xl border border-[var(--color-warning)] bg-[var(--color-warning-light)] p-4">
          <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-[var(--color-warning-dark)]" />
          <div className="space-y-1 text-sm text-[var(--color-text-primary)]">
            <p className="font-semibold">Are you still working?</p>
            <p className="text-[var(--color-text-secondary)]">
              For campus workstation security, your human staff session will automatically sign out in{' '}
              <span className="inline-flex items-center gap-1 font-bold text-[var(--color-brand)]">
                <Clock className="h-3.5 w-3.5" aria-hidden="true" />
                {remainingSeconds}s
              </span>
              .
            </p>
          </div>
        </div>

        <div className="flex flex-col gap-2 sm:flex-row-reverse">
          <Button
            type="button"
            onClick={() => void handleStaySignedIn()}
            loading={stayingSignedIn}
            className="w-full sm:flex-1"
          >
            {stayingSignedIn ? 'Extending...' : 'Stay Signed In'}
          </Button>
          <Button
            type="button"
            variant="secondary"
            disabled={stayingSignedIn}
            onClick={() => void performIdleSignOut(false)}
            className="w-full sm:flex-1"
          >
            <LogOut className="mr-1.5 h-4 w-4" aria-hidden="true" />
            Sign Out Now
          </Button>
        </div>
      </div>
    </Modal>
  );
}
