const DEVICE_ALIAS_PATTERN = /^[a-z0-9][a-z0-9-]{2,62}$/;
const DEVICE_EMAIL_DOMAIN = 'devices.egatepass.invalid';

export type LoginIdentity =
  | { ok: true; email: string }
  | { ok: false; message: string };

export function normalizeLoginIdentity(value: string): LoginIdentity {
  const normalized = value.trim().toLowerCase();
  if (normalized.includes('@')) {
    if (!/^\S+@\S+\.\S+$/.test(normalized)) {
      return { ok: false, message: 'Enter a valid staff email or device username.' };
    }
    return { ok: true, email: normalized };
  }

  if (!DEVICE_ALIAS_PATTERN.test(normalized)) {
    return { ok: false, message: 'Enter a valid staff email or device username.' };
  }

  return { ok: true, email: `${normalized}@${DEVICE_EMAIL_DOMAIN}` };
}
