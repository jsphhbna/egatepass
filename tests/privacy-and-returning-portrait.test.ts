import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';

describe('Phase B: Privacy Notice and Returning Visitor Portrait Invariants', () => {
  const getPassSource = readFileSync('src/pages/GetPassPage.tsx', 'utf8');
  const authImageSource = readFileSync('src/components/AuthenticatedImage.tsx', 'utf8');

  it('consolidates privacy notice link directly inside the consent card', () => {
    // Both consent checkbox and privacy notice trigger must be inside the single consolidated card
    expect(getPassSource).toContain('Consolidated Data Privacy & Consent Card');
    expect(getPassSource).toContain('Read our Data Privacy Notice');
    expect(getPassSource).toContain("id=\"consent\"");
    expect(getPassSource).toContain("register('consent')");

    // Clicking privacy notice link must stopPropagation and preventDefault so it cannot accidentally toggle consent
    expect(getPassSource).toContain('e.stopPropagation()');
    expect(getPassSource).toContain('e.preventDefault()');
    expect(getPassSource).toContain('setShowPrivacyModal(true)');
  });

  it('provides reactive portalToken for returning visitor portrait retrieval', () => {
    expect(getPassSource).toContain('const [portalToken, setPortalToken] = useState<string | null>(null);');
    expect(getPassSource).toContain('authToken={portalToken || portalTransactionRef.current?.token}');
  });

  it('AuthenticatedImage provides retry button on temporary loading failure', () => {
    expect(authImageSource).toContain('setRetryCount');
    expect(authImageSource).toContain('Unable to load photo');
    expect(authImageSource).toContain('<RefreshCw');
    expect(authImageSource).toContain('Retry');
  });

  it('AuthenticatedImage distinguishes expired (410) and missing (404) from temporary failure', () => {
    expect(authImageSource).toContain("response.status === 410");
    expect(authImageSource).toContain("setState('expired')");
    expect(authImageSource).toContain("response.status === 404");
    expect(authImageSource).toContain("setState('missing')");
    expect(authImageSource).toContain("setState('temporary')");
  });

  it('AuthenticatedImage strictly prevents bearer token leakage to external origins', () => {
    expect(authImageSource).toContain('isSameOriginUrl');
    expect(authImageSource).toContain('isSafeFetchUrl');
    expect(authImageSource).toContain('token && isSameOriginUrl(targetUrl)');
  });

  it('Feature A: renders privacy-safe avatar placeholder without premature portrait preview for all manual returning candidates', () => {
    // Each returning visitor candidate profile card must protect portraits until verified
    expect(getPassSource).toContain('Privacy-Safe Candidate Avatar Placeholder (portrait protected until verified)');
    expect(getPassSource).not.toContain('srcUrl={cand.previewUrl}');
    expect(getPassSource).toContain('h-14 w-14 sm:h-15 sm:w-15 rounded-xl');
  });

  it('Feature B: renders privacy-safe placeholder without premature portrait in automatic candidate match modal', () => {
    // The automatic existing profile detection modal protects portrait until verification
    expect(getPassSource).not.toContain('srcUrl={candidateMatch.previewUrl}');
    expect(getPassSource).toContain('h-16 w-16 sm:h-18 sm:w-18 rounded-xl');
  });

  it('AuthenticatedImage supports compact thumbnail mode without layout overflow', () => {
    expect(authImageSource).toContain('compact?: boolean;');
    expect(authImageSource).toContain('compact = false');
    expect(authImageSource).toContain('if (compact)');
  });
});
