import { describe, it, expect } from 'vitest';
import {
  createPassPresentation,
  formatPassReference,
  renderPassCardToDataUrl,
} from '@/lib/passPresentation';
import { BUNDLED_DEFAULT_THERMAL_TEMPLATE } from '@/printer/templates/bundledDefaultTemplate';
import { renderThermalPass } from '@/printer/renderer/thermalRenderer';
import { searchCachedVisitors, type CachedVisitorPass } from '@/lib/offline/guardIndexedDb';
import { setupMockIndexedDb } from './helpers/mockIndexedDb';

describe('Section H: Pass Reference Parity Across All Surfaces', () => {
  const canonicalPublicRef = 'e4a8b2c1-9012-3456-7890-abcdef123456';
  const canonicalPassId = '11111111-2222-3333-4444-555555555555';
  const expectedDisplayRef = 'EG-E4A8B2C1';

  it('H.1: derives the exact same EG-XXXXXXXX reference from public_reference across online, kiosk, thermal, email, and guard recovery', async () => {
    // 1. Online presentation derivation
    const onlinePresentation = createPassPresentation({
      id: canonicalPassId,
      publicReference: canonicalPublicRef,
      passReference: canonicalPublicRef,
      visitorName: 'Juan Dela Cruz',
      visitDate: '2026-10-27',
      qrToken: 'raw_opaque_hmac_bearer_token_12345',
    });
    expect(onlinePresentation.passReference).toBe(expectedDisplayRef);
    expect(onlinePresentation.passReference).not.toContain(canonicalPassId.slice(0, 8));

    // 2. Kiosk presentation derivation
    const kioskPresentation = createPassPresentation({
      id: canonicalPassId,
      publicReference: canonicalPublicRef,
      passReference: formatPassReference(canonicalPublicRef),
      visitorName: 'Juan Dela Cruz',
      visitDate: '2026-10-27',
      qrToken: 'raw_opaque_hmac_bearer_token_12345',
    });
    expect(kioskPresentation.passReference).toBe(expectedDisplayRef);

    // 3. Thermal print template layout rendering
    const thermalRefElement = BUNDLED_DEFAULT_THERMAL_TEMPLATE.elements.find(
      (el) => el.field === 'pass_reference'
    );
    expect(thermalRefElement).toBeDefined();
    // In DOM environment, renderThermalPass formats presentation.passReference
    if (typeof document !== 'undefined') {
      const { canvas } = await renderThermalPass(kioskPresentation, BUNDLED_DEFAULT_THERMAL_TEMPLATE);
      expect(canvas.width).toBe(384);
    }

    // 4. Downloadable PNG card generation
    if (typeof document !== 'undefined') {
      const dataUrl = await renderPassCardToDataUrl(onlinePresentation);
      expect(dataUrl).toMatch(/^data:image\/png;base64,/);
    }

    // 5. Email template parity: formatPassReference output
    const emailRef = formatPassReference(canonicalPublicRef);
    expect(emailRef).toBe(expectedDisplayRef);
  });

  it('H.2: Guard recovery tab displays and searches the exact EG-XXXXXXXX public reference', async () => {
    setupMockIndexedDb();
    const testActorId = 'test-guard-actor-id';

    const cachedPass: CachedVisitorPass = {
      actorId: testActorId,
      id: canonicalPassId,
      publicReference: canonicalPublicRef,
      visitorId: 'vis-123',
      visitorName: 'Juan Dela Cruz',
      contactNumber: '09171234567',
      purpose: 'Registrar',
      visitDate: '2026-10-27',
      status: 'inside',
      passReference: expectedDisplayRef,
      validFrom: '2026-10-27T08:00:00+08:00',
      validUntil: '2026-10-27T17:00:00+08:00',
      cachedAt: new Date().toISOString(),
    };

    const { saveCachedVisitors } = await import('@/lib/offline/guardIndexedDb');
    await saveCachedVisitors(testActorId, [cachedPass]);

    // Search by full EG-XXXXXXXX reference
    const fullMatch = await searchCachedVisitors(testActorId, expectedDisplayRef);
    expect(fullMatch.length).toBe(1);
    expect(fullMatch[0]?.passReference).toBe(expectedDisplayRef);

    // Search by short 8-char reference
    const shortMatch = await searchCachedVisitors(testActorId, 'E4A8B2C1');
    expect(shortMatch.length).toBe(1);
    expect(shortMatch[0]?.passReference).toBe(expectedDisplayRef);

    // Search by lowercase input
    const lowerMatch = await searchCachedVisitors(testActorId, 'eg-e4a8b2c1');
    expect(lowerMatch.length).toBe(1);
    expect(lowerMatch[0]?.passReference).toBe(expectedDisplayRef);
  });
});
