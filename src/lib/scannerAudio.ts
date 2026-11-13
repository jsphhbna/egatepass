/**
 * Scanner Audio Feedback System for EARIST E-GatePass
 * Synthesizes short, distinct audible alerts using the Web Audio API.
 * Pure in-browser synthesis: zero external audio files, works completely offline.
 */

let audioCtx: AudioContext | null = null;
let isMuted = false;
let lastSoundTime = 0;
const MIN_SOUND_INTERVAL_MS = 250;

function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (!audioCtx) {
    const AudioContextClass = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (AudioContextClass) {
      audioCtx = new AudioContextClass();
    }
  }
  return audioCtx;
}

/**
 * Initializes or resumes the AudioContext after a legitimate user gesture (click/tap)
 * to comply with browser autoplay restrictions.
 */
export async function initScannerAudio(): Promise<boolean> {
  const ctx = getAudioContext();
  if (!ctx) return false;
  if (ctx.state === 'suspended') {
    try {
      await ctx.resume();
    } catch {
      return false;
    }
  }
  return ctx.state === 'running';
}

export function getScannerAudioState(): 'running' | 'suspended' | 'unavailable' {
  if (typeof window === 'undefined') return 'unavailable';
  if (!audioCtx) return 'suspended';
  if (audioCtx.state === 'running') return 'running';
  if (audioCtx.state === 'suspended') return 'suspended';
  return 'unavailable';
}

export function isScannerAudioMuted(): boolean {
  if (typeof window !== 'undefined') {
    const saved = localStorage.getItem('egatepass_scanner_audio_muted');
    if (saved !== null) {
      isMuted = saved === 'true';
    }
  }
  return isMuted;
}

export function setScannerAudioMuted(muted: boolean): void {
  isMuted = muted;
  if (typeof window !== 'undefined') {
    localStorage.setItem('egatepass_scanner_audio_muted', String(muted));
  }
}

function shouldThrottleSound(now: number): boolean {
  if (now < lastSoundTime) {
    // Clock skew / backwards jump: reset throttle
    lastSoundTime = 0;
  }
  if (now - lastSoundTime < MIN_SOUND_INTERVAL_MS) {
    return true;
  }
  lastSoundTime = now;
  return false;
}

export function _resetScannerAudioForTest(): void {
  lastSoundTime = 0;
  audioCtx = null;
  isMuted = false;
}

/**
 * Plays a single synthesized tone with smooth attack and decay envelopes.
 */
function playTone(frequency: number, durationSec: number, type: OscillatorType = 'sine', gainLevel = 0.15, startTimeOffset = 0): void {
  if (isMuted) return;
  const ctx = getAudioContext();
  if (!ctx || ctx.state !== 'running') return;

  const now = ctx.currentTime + startTimeOffset;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();

  osc.type = type;
  osc.frequency.setValueAtTime(frequency, now);

  // Smooth attack and exponential decay to prevent speaker clicks
  gain.gain.setValueAtTime(0.001, now);
  gain.gain.linearRampToValueAtTime(gainLevel, now + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + durationSec);

  osc.connect(gain);
  gain.connect(ctx.destination);

  osc.start(now);
  osc.stop(now + durationSec);
}

/**
 * Successful Scan Feedback (Entry scan or Office-Confirmed Exit)
 * High pleasant rising two-tone chime (880Hz -> 1175Hz).
 */
export function playSuccessBeep(): void {
  const now = Date.now();
  if (shouldThrottleSound(now)) return;

  playTone(880, 0.08, 'sine', 0.2, 0);       // A5
  playTone(1174.66, 0.14, 'sine', 0.2, 0.08); // D6
}

/**
 * Distinct Warning Feedback (Exit Without Office Attendance Confirmation)
 * Alternating two-tone pulse (587Hz -> 440Hz) to clearly notify guard of unconfirmed visit.
 */
export function playWarningBeep(): void {
  const now = Date.now();
  if (shouldThrottleSound(now)) return;

  playTone(587.33, 0.12, 'triangle', 0.25, 0);     // D5
  playTone(440, 0.16, 'triangle', 0.25, 0.14);    // A4
}

/**
 * Error Feedback (Invalid, expired, already-used, wrong gate, or unauthorized scan)
 * Low buzzer tone (220Hz / 180Hz) with slight sawtooth warmth.
 */
export function playErrorBeep(): void {
  const now = Date.now();
  if (shouldThrottleSound(now)) return;

  playTone(220, 0.22, 'sawtooth', 0.18, 0); // A3
}
