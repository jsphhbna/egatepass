import { z } from 'zod';

export const passIdSchema = z.string().uuid();

export const requestCodeSchema = z.object({
  action: z.literal('request_code'),
  passId: passIdSchema,
  qrToken: z.string().min(16).max(256),
  recipientEmail: z.string().trim().toLowerCase().email().max(320),
  consent: z.literal(true),
  requestId: z.string().uuid(),
});

export const verifyAndSendSchema = z.object({
  action: z.literal('verify_and_send'),
  passId: passIdSchema,
  qrToken: z.string().min(16).max(256),
  recipientEmail: z.string().trim().toLowerCase().email().max(320),
  verificationId: z.string().uuid(),
  code: z.string().trim().regex(/^\d{6}$/),
  requestId: z.string().uuid(),
});

export const passEmailRequestSchema = z.discriminatedUnion('action', [
  requestCodeSchema,
  verifyAndSendSchema,
]);

export type RequestCodePayload = z.infer<typeof requestCodeSchema>;
export type VerifyAndSendPayload = z.infer<typeof verifyAndSendSchema>;
export type PassEmailRequest = z.infer<typeof passEmailRequestSchema>;

export function normalizeRecipientEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function buildRequestCodePayload(params: {
  passId: string;
  qrToken: string;
  recipientEmail: string;
  consent: boolean;
  requestId: string;
}): RequestCodePayload {
  if (params.consent !== true) {
    throw new Error('Explicit visitor consent is required for email delivery.');
  }
  const payload = {
    action: 'request_code' as const,
    passId: params.passId,
    qrToken: params.qrToken,
    recipientEmail: normalizeRecipientEmail(params.recipientEmail),
    consent: true as const,
    requestId: params.requestId,
  } satisfies RequestCodePayload;

  return requestCodeSchema.parse(payload);
}

export function buildVerifyAndSendPayload(params: {
  passId: string;
  qrToken: string;
  recipientEmail: string;
  verificationId: string;
  code: string;
  requestId: string;
}): VerifyAndSendPayload {
  const payload = {
    action: 'verify_and_send' as const,
    passId: params.passId,
    qrToken: params.qrToken,
    recipientEmail: normalizeRecipientEmail(params.recipientEmail),
    verificationId: params.verificationId,
    code: params.code.trim(),
    requestId: params.requestId,
  } satisfies VerifyAndSendPayload;

  return verifyAndSendSchema.parse(payload);
}
