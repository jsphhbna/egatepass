import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

describe('Returning Visitor Workflow Separation & Locality Review Contract', () => {
  const getPassSrc = readFileSync('src/pages/GetPassPage.tsx', 'utf8');

  describe('1. Stepper Separation & Elimination of Step 0 of 6', () => {
    it('defines NEW_VISITOR_STEPPER_STEPS containing exclusively the 6 new visitor steps', () => {
      expect(getPassSrc).toContain("const NEW_VISITOR_STEPPER_STEPS = ['form', 'visit', 'photo', 'id', 'verify', 'review'] as const;");
    });

    it('guards stepper visibility strictly by registrationMode === "new" and NEW_VISITOR_STEPPER_STEPS', () => {
      expect(getPassSrc).toContain(
        "const isNewVisitorStepper = registrationMode === 'new' && (NEW_VISITOR_STEPPER_STEPS as readonly string[]).includes(step);"
      );
      expect(getPassSrc).toContain('{isNewVisitorStepper && (');
    });

    it('does not render stepper on any returning visitor step', () => {
      const returningSteps = [
        'returning_lookup',
        'returning_results',
        'returning_capture',
        'returning_confirm',
        'returning_review',
      ];
      for (const retStep of returningSteps) {
        expect(getPassSrc).not.toMatch(new RegExp(`step === '${retStep}'.*<Stepper`, 's'));
      }
    });

    it('prevents Step 0 of 6 glitch by ensuring stepper is not shown on frontdoor or arrival_setup', () => {
      // isNewVisitorStepper requires step to be in NEW_VISITOR_STEPPER_STEPS
      // Neither 'frontdoor' nor 'arrival_setup' is in NEW_VISITOR_STEPPER_STEPS
      expect(getPassSrc).not.toContain("step === 'frontdoor' && isNewVisitorStepper");
      expect(getPassSrc).not.toContain("step === 'arrival_setup' && isNewVisitorStepper");
    });
  });

  describe('2. Dedicated Profile Search Results View (returning_results)', () => {
    it('declares returning_results and returning_review in Step type union', () => {
      expect(getPassSrc).toContain("'returning_results'");
      expect(getPassSrc).toContain("'returning_review'");
    });

    it('transitions to returning_results upon completing lookup', () => {
      expect(getPassSrc).toContain("setStep('returning_results');");
    });

    it('renders a dedicated scrollable results container with max-h-[360px] overflow-y-auto', () => {
      expect(getPassSrc).toContain("step === 'returning_results'");
      expect(getPassSrc).toContain('max-h-[360px] overflow-y-auto');
    });

    it('displays privacy-masked profile name, masked contact, partial locality, and candidate count', () => {
      const resultsSection = getPassSrc.slice(
        getPassSrc.indexOf("{step === 'returning_results' && ("),
        getPassSrc.indexOf("{step === 'returning_capture' && (")
      );
      expect(resultsSection).toContain('cand.maskedName');
      expect(resultsSection).toContain('cand.maskedContact');
      expect(resultsSection).toContain('cand.partialLocality');
      expect(resultsSection).toContain('returningCandidates.length');
      expect(resultsSection).toContain('Privacy-masked for safety');
    });

    it('provides a Proceed to Live Face Verification button disabled without selection', () => {
      const resultsSection = getPassSrc.slice(
        getPassSrc.indexOf("{step === 'returning_results' && ("),
        getPassSrc.indexOf("{step === 'returning_capture' && (")
      );
      expect(resultsSection).toContain('Proceed to Live Face Verification');
      expect(resultsSection).toContain('disabled={!selectedReturningCandidate}');
    });

    it('provides a Back to Search button that returns to returning_lookup preserving input fields', () => {
      const resultsSection = getPassSrc.slice(
        getPassSrc.indexOf("{step === 'returning_results' && ("),
        getPassSrc.indexOf("{step === 'returning_capture' && (")
      );
      expect(resultsSection).toContain('Back to Search');
      expect(resultsSection).toContain("setSelectedReturningCandidate(null)");
      expect(resultsSection).toContain("setStep('returning_lookup')");
      // Must not wipe returningLookupFirst or returningLookupLast
      expect(resultsSection).not.toContain("setReturningLookupFirst('')");
      expect(resultsSection).not.toContain("setReturningLookupLast('')");
    });
  });

  describe('3. Dedicated Zero Results View', () => {
    it('renders dedicated no-match card when returningCandidates is empty', () => {
      const resultsSection = getPassSrc.slice(
        getPassSrc.indexOf("{step === 'returning_results' && ("),
        getPassSrc.indexOf("{step === 'returning_capture' && (")
      );
      expect(resultsSection).toContain('returningCandidates.length === 0');
      expect(resultsSection).toContain('No Enrolled Profile Matched');
      expect(resultsSection).toContain('Register as New Visitor');
      expect(resultsSection).toContain('Back to Search');
    });

    it('routes Register as New Visitor to beginNewVisitorSetup()', () => {
      const resultsSection = getPassSrc.slice(
        getPassSrc.indexOf("{step === 'returning_results' && ("),
        getPassSrc.indexOf("{step === 'returning_capture' && (")
      );
      expect(resultsSection).toContain('beginNewVisitorSetup()');
    });
  });

  describe('4. Purpose of Visit Label Cleanliness', () => {
    it('does not wrap VisitPurposeField in redundant outer FormField in visit step', () => {
      const visitStep = getPassSrc.slice(
        getPassSrc.indexOf("{step === 'visit' && ("),
        getPassSrc.indexOf("{step === 'photo' && (")
      );
      expect(visitStep).not.toContain('<FormField label="Purpose of Visit"');
      expect(visitStep).toContain('<VisitPurposeField');
    });

    it('does not wrap VisitPurposeField in redundant outer FormField in returning_confirm step', () => {
      const confirmStep = getPassSrc.slice(
        getPassSrc.indexOf("{step === 'returning_confirm' && returningProfile && ("),
        getPassSrc.indexOf("{step === 'returning_review' && returningProfile && (")
      );
      expect(confirmStep).not.toContain('<FormField label="Purpose of Visit"');
      expect(confirmStep).toContain('<VisitPurposeField');
    });
  });

  describe('5. Provisional Mode Notice Cleanliness', () => {
    it('does not display repeated provisional mode notice in returning_capture', () => {
      const captureStep = getPassSrc.slice(
        getPassSrc.indexOf("{step === 'returning_capture' && ("),
        getPassSrc.indexOf("{step === 'returning_confirm' && returningProfile && (")
      );
      expect(captureStep).not.toContain('Operating with OpenCV SFace reference threshold (0.363)');
      expect(captureStep).not.toContain('Provisional Mode (0.363)');
    });

    it('removes the user-facing provisional mode badge from frontdoor returning card', () => {
      const frontdoorStep = getPassSrc.slice(
        getPassSrc.indexOf("{step === 'frontdoor' && ("),
        getPassSrc.indexOf("{step === 'arrival_setup' && (")
      );
      expect(frontdoorStep).not.toContain('Provisional Mode (0.363)');
      expect(frontdoorStep).toContain('Ready');
    });
  });

  describe('6. Returning Confirm to Review Transition & Historical ID Preview', () => {
    it('defines onReturningConfirmNext transitioning to returning_review', () => {
      expect(getPassSrc).toContain('function onReturningConfirmNext()');
      expect(getPassSrc).toContain("setStep('returning_review');");
    });

    it('fetches historical ID preview securely using fetchHistoricalIdPreview() with generation fencing', () => {
      expect(getPassSrc).toContain('fetchHistoricalIdPreview(');
      expect(getPassSrc).toContain('historicalIdRequestGeneration');
      expect(getPassSrc).toContain('setLoadingHistoricalId(');
    });

    it('cleans up historical ID object URL on unmount or reset', () => {
      expect(getPassSrc).toMatch(/historicalIdUrl\.(?:clear|setUrl)/);
    });
  });

  describe('7. Dedicated Returning Visitor Review View (returning_review)', () => {
    it('renders returning_review step separate from new visitor review step', () => {
      expect(getPassSrc).toContain("{step === 'returning_review' && returningProfile && (");
      expect(getPassSrc).toContain("{step === 'review' && (");
    });

    it('displays verified identity badge, original registration portrait, and historical ID preview', () => {
      const returningReviewSection = getPassSrc.slice(
        getPassSrc.indexOf("{step === 'returning_review' && returningProfile && ("),
        getPassSrc.indexOf("{step === 'generating' && (")
      );
      expect(returningReviewSection).toContain('Biometric Identity Verified');
      expect(returningReviewSection).toContain('Portrait and ID History');
      expect(returningReviewSection).toContain('Original Registration Portrait');
      expect(returningReviewSection).toContain('Previously Submitted ID');
      expect(returningReviewSection).not.toContain('Live Verified Selfie');
      expect(returningReviewSection).toMatch(/historicalId(?:Url|Preview)/);
    });

    it('displays previous ID fallback when image is expired or unavailable under retention policy', () => {
      const returningReviewSection = getPassSrc.slice(
        getPassSrc.indexOf("{step === 'returning_review' && returningProfile && ("),
        getPassSrc.indexOf("{step === 'generating' && (")
      );
      expect(returningReviewSection).toContain('Previous ID document is on file with campus records.');
    });

    it('does NOT contain the Remember Me institutional enrollment card in returning_review', () => {
      const returningReviewSection = getPassSrc.slice(
        getPassSrc.indexOf("{step === 'returning_review' && returningProfile && ("),
        getPassSrc.indexOf("{step === 'generating' && (")
      );
      expect(returningReviewSection).not.toContain('Institutional Biometric Enrollment Card');
      expect(returningReviewSection).not.toContain('Remember me for faster future visits');
    });

    it('renders profile update checkbox and visit details in returning_review', () => {
      const returningReviewSection = getPassSrc.slice(
        getPassSrc.indexOf("{step === 'returning_review' && returningProfile && ("),
        getPassSrc.indexOf("{step === 'generating' && (")
      );
      expect(returningReviewSection).toContain('Profile Update for Future Visits:');
      expect(returningReviewSection).toContain('Purpose of Visit:');
      expect(returningReviewSection).toContain('Arrival Method:');
    });
  });

  describe('8. Returning Pass Issuance Payload & Enrollment Guard', () => {
    it('forces rememberVisitor to false in pass issuance payload', () => {
      expect(getPassSrc).toContain(
        'rememberVisitor: false,'
      );
    });

    it('includes returning profileId and matchToken when registrationMode === "returning"', () => {
      expect(getPassSrc).toContain("registrationMode === 'returning' && returningProfile");
      expect(getPassSrc).toContain('profileId: returningProfile.profileId,');
      expect(getPassSrc).toContain('matchToken: returningProfile.matchToken,');
      expect(getPassSrc).toContain('saveUpdates: saveReturningUpdates,');
    });
  });
});
