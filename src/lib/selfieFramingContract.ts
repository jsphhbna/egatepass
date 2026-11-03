/**
 * Authoritative framing geometry contract for live visitor selfies.
 * Shared between browser webcam preview / canvas crop and server face-engine evaluation.
 */

// Target camera aspect ratio for selfie capture (3:4 portrait)
export const SELFIE_TARGET_ASPECT_RATIO = 3 / 4; // 0.75 (width / height)
export const SELFIE_VIEWPORT_ASPECT_RATIO_CLASS = 'aspect-[3/4]';

// Authoritative normalized oval geometry in [0, 1] x [0, 1] portrait coordinates
export const SELFIE_OVAL_CENTER_X = 0.5;
export const SELFIE_OVAL_CENTER_Y = 0.5;
export const SELFIE_OVAL_RADIUS_X = 0.31; // Horizontal radius (62% of viewport width)
export const SELFIE_OVAL_RADIUS_Y = 0.35; // Vertical radius (70% of viewport height)

// Responsive CSS percentage dimensions for on-screen guide overlay
export const SELFIE_OVAL_WIDTH_PERCENT = 62;
export const SELFIE_OVAL_HEIGHT_PERCENT = 70;

// Sizing boundaries relative to oval vertical diameter (2 * ry = 0.70)
export const MIN_FACE_OVAL_HEIGHT_RATIO = 0.35; // Below this, face is too far / small
export const MAX_FACE_OVAL_HEIGHT_RATIO = 0.88; // Above this, face is genuinely too large

// Maximum allowed center offset in normalized oval radii
export const MAX_CENTER_OFFSET_X = 0.40;
export const MAX_CENTER_OFFSET_Y = 0.40;

// Head envelope expansion ratios relative to face bounding box height (vH) and width (uW)
// YuNet bounding box top vY already captures brow/forehead region.
// An anatomically sound forehead/hairline envelope is 14% of face box height above vY.
// Chin envelope is 3% below vY + vH.
export const HEAD_TOP_EXPANSION_RATIO = 0.14;
export const HEAD_BOTTOM_EXPANSION_RATIO = 0.03;
export const HEAD_SIDE_EXPANSION_RATIO = 0.08;

// Permitted tolerance factor for oval boundary inclusion of estimated head envelope
export const OVAL_ENVELOPE_TOLERANCE = 1.06;

export interface OvalFramingGeometry {
  cx: number;
  cy: number;
  rx: number;
  ry: number;
}

/**
 * Computes the normalized [0, 1] oval geometry corresponding to the 3:4 portrait guide.
 * When the input image is already 3:4 (standard portrait selfie capture), returns exact oval constants.
 * When an image with a different aspect ratio is supplied (e.g. legacy landscape 4:3 or 16:9),
 * maps the 3:4 portrait guide onto that frame using centered object-fit: cover semantics.
 */
export function computeNormalizedOvalGeometry(origW: number, origH: number): OvalFramingGeometry {
  const rOrig = origW / Math.max(1, origH);
  const rTarget = SELFIE_TARGET_ASPECT_RATIO;

  let rxNorm: number;
  let ryNorm: number;

  if (Math.abs(rOrig - rTarget) < 0.02) {
    // Exact or near-exact 3:4 portrait image
    rxNorm = SELFIE_OVAL_RADIUS_X;
    ryNorm = SELFIE_OVAL_RADIUS_Y;
  } else if (rOrig > rTarget) {
    // Image is wider than 3:4 (e.g. 4:3 or 16:9)
    // CSS cover scales height to 100%, cropping left and right.
    // Normalized X in image is compressed by (rTarget / rOrig).
    rxNorm = SELFIE_OVAL_RADIUS_X * (rTarget / rOrig);
    ryNorm = SELFIE_OVAL_RADIUS_Y;
  } else {
    // Image is taller than 3:4 (e.g. 9:16)
    // CSS cover scales width to 100%, cropping top and bottom.
    // Normalized Y in image is compressed by (rOrig / rTarget).
    rxNorm = SELFIE_OVAL_RADIUS_X;
    ryNorm = SELFIE_OVAL_RADIUS_Y * (rOrig / rTarget);
  }

  return {
    cx: SELFIE_OVAL_CENTER_X,
    cy: SELFIE_OVAL_CENTER_Y,
    rx: rxNorm,
    ry: ryNorm,
  };
}
