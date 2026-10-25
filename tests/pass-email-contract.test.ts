import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
  passEmailRequestSchema,
  requestCodeSchema,
  verifyAndSendSchema,
  buildRequestCodePayload,
  buildVerifyAndSendPayload,
  normalizeRecipientEmail,
  type RequestCodePayload,
  type VerifyAndSendPayload,
} from '../src/lib/passEmailContract';

describe('CROSS-LAYER PASS EMAIL CONTRACT & DELIVERY CLOSURE', () => {
  const samplePassId = randomUUID();
  const sampleQrToken = 'earist-secure-bearer-token-random-bytes-1234567890';
  const sampleRequestId = randomUUID();
  const sampleVerificationId = randomUUID();

  describe('1. Authoritative Schema & Payload Contract', () => {
    it('successfully parses a valid request_code payload', () => {
      const payload = {
        action: 'request_code' as const,
        passId: samplePassId,
        qrToken: sampleQrToken,
        recipientEmail: 'visitor@example.com',
        consent: true as const,
        requestId: sampleRequestId,
      };

      const result = passEmailRequestSchema.safeParse(payload);
      expect(result.success).toBe(true);
      if (result.success && result.data.action === 'request_code') {
        expect(result.data.passId).toBe(samplePassId);
        expect(result.data.qrToken).toBe(sampleQrToken);
        expect(result.data.recipientEmail).toBe('visitor@example.com');
        expect(result.data.consent).toBe(true);
        expect(result.data.requestId).toBe(sampleRequestId);
      }
    });

    it('FAILS request_code when qrToken is missing (the regression that escaped previous tests)', () => {
      const buggyPayload = {
        action: 'request_code',
        passId: samplePassId,
        recipientEmail: 'visitor@example.com',
        consent: true,
        requestId: sampleRequestId,
      };

      const result = passEmailRequestSchema.safeParse(buggyPayload);
      expect(result.success).toBe(false);
      if (!result.success) {
        const issues = result.error.issues;
        expect(issues.some((i) => i.path.includes('qrToken'))).toBe(true);
      }
    });

    it('FAILS request_code when consent is missing', () => {
      const buggyPayload = {
        action: 'request_code',
        passId: samplePassId,
        qrToken: sampleQrToken,
        recipientEmail: 'visitor@example.com',
        requestId: sampleRequestId,
      };

      const result = passEmailRequestSchema.safeParse(buggyPayload);
      expect(result.success).toBe(false);
      if (!result.success) {
        const issues = result.error.issues;
        expect(issues.some((i) => i.path.includes('consent'))).toBe(true);
      }
    });

    it('FAILS request_code when consent is false', () => {
      const buggyPayload = {
        action: 'request_code',
        passId: samplePassId,
        qrToken: sampleQrToken,
        recipientEmail: 'visitor@example.com',
        consent: false,
        requestId: sampleRequestId,
      };

      const result = passEmailRequestSchema.safeParse(buggyPayload);
      expect(result.success).toBe(false);
      if (!result.success) {
        const issues = result.error.issues;
        expect(issues.some((i) => i.path.includes('consent'))).toBe(true);
      }
    });

    it('buildRequestCodePayload refuses to fabricate consent when consent is false', () => {
      expect(() =>
        buildRequestCodePayload({
          passId: samplePassId,
          qrToken: sampleQrToken,
          recipientEmail: 'visitor@example.com',
          consent: false,
          requestId: sampleRequestId,
        })
      ).toThrow(/consent is required/i);
    });

    it('successfully parses a valid verify_and_send payload', () => {
      const payload = {
        action: 'verify_and_send' as const,
        passId: samplePassId,
        qrToken: sampleQrToken,
        recipientEmail: 'visitor@example.com',
        verificationId: sampleVerificationId,
        code: '123456',
        requestId: sampleRequestId,
      };

      const result = passEmailRequestSchema.safeParse(payload);
      expect(result.success).toBe(true);
      if (result.success && result.data.action === 'verify_and_send') {
        expect(result.data.code).toBe('123456');
        expect(result.data.verificationId).toBe(sampleVerificationId);
      }
    });

    it('FAILS verify_and_send when code is malformed', () => {
      const malformedCodes = ['12345', '1234567', 'abcdef', '12 456', ''];
      for (const badCode of malformedCodes) {
        const payload = {
          action: 'verify_and_send',
          passId: samplePassId,
          qrToken: sampleQrToken,
          recipientEmail: 'visitor@example.com',
          verificationId: sampleVerificationId,
          code: badCode,
          requestId: sampleRequestId,
        };
        const result = passEmailRequestSchema.safeParse(payload);
        expect(result.success).toBe(false);
      }
    });

    it('FAILS verify_and_send when qrToken is missing', () => {
      const payload = {
        action: 'verify_and_send',
        passId: samplePassId,
        recipientEmail: 'visitor@example.com',
        verificationId: sampleVerificationId,
        code: '123456',
        requestId: sampleRequestId,
      };
      const result = passEmailRequestSchema.safeParse(payload);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((i) => i.path.includes('qrToken'))).toBe(true);
      }
    });

    it('normalizes recipient emails consistently (trim and lowercase)', () => {
      const raw = '   Visitor.Santos@EARIST.Edu.PH   ';
      const expected = 'visitor.santos@earist.edu.ph';

      expect(normalizeRecipientEmail(raw)).toBe(expected);

      const payload = buildRequestCodePayload({
        passId: samplePassId,
        qrToken: sampleQrToken,
        recipientEmail: raw,
        consent: true,
        requestId: sampleRequestId,
      });

      expect(payload.recipientEmail).toBe(expected);

      const parsed = passEmailRequestSchema.parse(payload);
      expect(parsed.recipientEmail).toBe(expected);
    });
  });

  describe('2. Component-Level Production Construction Verification', () => {
    const modalSrc = readFileSync('src/components/EmailPassModal.tsx', 'utf8');
    const serverEmailSrc = readFileSync('server/routes/passes/email.ts', 'utf8');

    it('verifies EmailPassModal imports and uses the shared contract builders', () => {
      expect(modalSrc).toContain("from '@/lib/passEmailContract'");
      expect(modalSrc).toContain('buildRequestCodePayload');
      expect(modalSrc).toContain('buildVerifyAndSendPayload');
      expect(modalSrc).toContain('const payload: RequestCodePayload = buildRequestCodePayload(');
      expect(modalSrc).toContain('const payload: VerifyAndSendPayload = buildVerifyAndSendPayload(');
      expect(modalSrc).toContain('body: JSON.stringify(payload)');
    });

    it('verifies EmailPassModal does not include obsolete properties such as source in request payloads', () => {
      // payload construction must not contain source in the object literal passed to payload builders
      expect(modalSrc).not.toMatch(/buildRequestCodePayload\(\{[^}]*source/);
      expect(modalSrc).not.toMatch(/buildVerifyAndSendPayload\(\{[^}]*source/);
    });

    it('verifies server/routes/passes/email.ts validates requests with shared passEmailRequestSchema', () => {
      expect(serverEmailSrc).toContain("from '../../../src/lib/passEmailContract.js'");
      expect(serverEmailSrc).toContain('passEmailRequestSchema');
      expect(serverEmailSrc).toContain('passEmailRequestSchema.safeParse(await request.json().catch(() => null))');
      expect(serverEmailSrc).toContain('normalizeRecipientEmail(parsed.data.recipientEmail)');
    });

    it('verifies EmailPassModal handles 202 and outcome_unknown / email_outcome_unknown gracefully', () => {
      expect(modalSrc).toContain("data?.status === 'outcome_unknown'");
      expect(modalSrc).toContain("data?.error === 'email_outcome_unknown'");
      expect(modalSrc).toContain("res.status === 202");
      expect(modalSrc).toContain("setStep('unknown')");
    });
  });

  describe('3. True Flow Simulation (Frontend Construction -> Shared Schema Validation)', () => {
    it('simulates complete request_code -> verificationId -> verify_and_send true flow', () => {
      // 1. Frontend constructs request_code payload
      const requestCodePayload = buildRequestCodePayload({
        passId: samplePassId,
        qrToken: sampleQrToken,
        recipientEmail: '  Student.Juan@EARIST.edu.ph  ',
        consent: true,
        requestId: sampleRequestId,
      });

      // 2. Transmitted across network as JSON
      const wireJson1 = JSON.stringify(requestCodePayload);
      const parsedBody1 = JSON.parse(wireJson1);

      // 3. Server route validates wire payload against authoritative shared schema
      const serverValidation1 = passEmailRequestSchema.safeParse(parsedBody1);
      expect(serverValidation1.success).toBe(true);
      if (!serverValidation1.success) throw new Error('Validation 1 failed');

      expect(serverValidation1.data.action).toBe('request_code');
      expect(serverValidation1.data.recipientEmail).toBe('student.juan@earist.edu.ph');
      expect(serverValidation1.data.qrToken).toBe(sampleQrToken);
      expect(serverValidation1.data.consent).toBe(true);

      // 4. Server responds with verificationId
      const serverResponse = {
        success: true,
        verificationId: sampleVerificationId,
        status: 'code_sent_to_provider',
      };

      // 5. Frontend constructs verify_and_send payload
      const verifyAndSendPayload = buildVerifyAndSendPayload({
        passId: samplePassId,
        qrToken: sampleQrToken,
        recipientEmail: 'student.juan@earist.edu.ph',
        verificationId: serverResponse.verificationId,
        code: '654321',
        requestId: randomUUID(),
      });

      // 6. Transmitted across network as JSON
      const wireJson2 = JSON.stringify(verifyAndSendPayload);
      const parsedBody2 = JSON.parse(wireJson2);

      // 7. Server route validates wire payload against authoritative shared schema
      const serverValidation2 = passEmailRequestSchema.safeParse(parsedBody2);
      expect(serverValidation2.success).toBe(true);
      if (!serverValidation2.success) throw new Error('Validation 2 failed');

      expect(serverValidation2.data.action).toBe('verify_and_send');
      expect(serverValidation2.data.code).toBe('654321');
      expect(serverValidation2.data.verificationId).toBe(sampleVerificationId);
      expect(serverValidation2.data.qrToken).toBe(sampleQrToken);
    });
  });

  describe('4. Idempotency Invariant: Exactly One Visitor Pass Issued', () => {
    const getPassSrc = readFileSync('src/pages/GetPassPage.tsx', 'utf8');

    it('ensures issueVisitorPass is only called during initial form submission', () => {
      // Find all occurrences of issueVisitorPass in GetPassPage
      const matches = getPassSrc.match(/issueVisitorPass\(/g);
      expect(matches).not.toBeNull();
      // Exactly 1 invocation in onSubmit
      expect(matches!.length).toBe(1);

      // Confirm onConfirmSkip sets step to done without calling issueVisitorPass
      const skipBlock = getPassSrc.match(/onConfirmSkip=\{[\s\S]*?setStep\('done'\);[\s\S]*?\}\}/);
      expect(skipBlock).toBeTruthy();
      expect(skipBlock![0]).not.toContain('issueVisitorPass');
      expect(skipBlock![0]).toContain("setStep('done')");

      // Confirm handleDownload initiates download without calling issueVisitorPass
      const downloadHandler = getPassSrc.match(/function handleDownload[\s\S]*?}/);
      expect(downloadHandler).toBeTruthy();
      expect(downloadHandler![0]).not.toContain('issueVisitorPass');
    });

    it('maintains the same passId, rawQrToken, and qrDataUrl through the entire delivery flow', () => {
      // In GetPassPage, setPassId and setRawQrToken are only set from result of issueVisitorPass
      expect(getPassSrc).toContain('setPassId(result.passId);');
      expect(getPassSrc).toContain('setRawQrToken(result.qrToken);');
      expect(getPassSrc).toContain('generateBrandedQrDataUrl(result.qrToken');
      expect(getPassSrc).toContain('setQrDataUrl(qrUrl);');

      // EmailPassModal receives the exact same passId and rawQrToken
      expect(getPassSrc).toContain('passId={passId || \'\'}');
      expect(getPassSrc).toContain('qrToken={rawQrToken || \'\'}');
    });
  });
});
