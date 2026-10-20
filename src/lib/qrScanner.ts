import {
  Html5Qrcode,
  Html5QrcodeSupportedFormats,
  type Html5QrcodeCameraScanConfig,
} from 'html5-qrcode';

type FocusCapabilities = MediaTrackCapabilities & {
  focusMode?: string[];
};

type FocusConstraint = MediaTrackConstraintSet & {
  focusMode: 'continuous';
};

export const QR_CAMERA_CONSTRAINTS: MediaTrackConstraints = {
  facingMode: { ideal: 'environment' },
  width: { ideal: 960 },
  height: { ideal: 720 },
  frameRate: { ideal: 30, max: 30 },
};

export const QR_SCAN_CONFIG: Html5QrcodeCameraScanConfig = {
  fps: 15,
  disableFlip: false,
  videoConstraints: QR_CAMERA_CONSTRAINTS,
};

export function createOptimizedQrScanner(elementId: string): Html5Qrcode {
  return new Html5Qrcode(elementId, {
    verbose: false,
    formatsToSupport: [Html5QrcodeSupportedFormats.QR_CODE],
    useBarCodeDetectorIfSupported: true,
  });
}

export async function enableContinuousFocus(scanner: Html5Qrcode): Promise<void> {
  try {
    const capabilities = scanner.getRunningTrackCapabilities() as FocusCapabilities;
    if (!capabilities.focusMode?.includes('continuous')) return;

    const continuousFocus = { focusMode: 'continuous' } as FocusConstraint;
    await scanner.applyVideoConstraints({ advanced: [continuousFocus] });
  } catch (error) {
    console.info('Continuous camera focus is unavailable:', error);
  }
}
