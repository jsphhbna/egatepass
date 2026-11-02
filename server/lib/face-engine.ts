import * as ort from 'onnxruntime-node';
import sharp, { type Metadata } from 'sharp';
import path from 'node:path';
import crypto from 'node:crypto';

export type QualityResultCode =
  | 'ok'
  | 'decode_failed'
  | 'unsupported_format'
  | 'too_small'
  | 'blurry'
  | 'too_dark'
  | 'overexposed'
  | 'no_face'
  | 'multiple_faces'
  | 'face_too_small'
  | 'face_cropped'
  | 'pose_unsuitable'
  | 'portrait_missing'
  | 'ambiguous_portrait';

export interface QualityEvaluation {
  passed: boolean;
  code: QualityResultCode;
  message: string;
}

export type FaceVerificationOutcome =
  | 'matched'
  | 'mismatch'
  | 'no_face_in_id'
  | 'no_face_in_selfie'
  | 'multiple_selfie_faces'
  | 'ambiguous_id_faces'
  | 'low_quality_id'
  | 'low_quality_selfie'
  | 'engine_error';

export interface VerificationResult {
  outcome: FaceVerificationOutcome;
  matched: boolean;
  score?: number; // Internal server usage only, never exposed to visitors
  modelName: string;
  modelVersion: string;
  error?: string;
}

export interface DetectedFace {
  x: number;
  y: number;
  w: number;
  h: number;
  score: number;
  landmarks: Array<[number, number]>;
}

export interface AnalyzedFaceImage {
  quality: QualityEvaluation;
  faces: DetectedFace[];
  dominantFace: DetectedFace | null;
  descriptor: Float32Array | null;
  modelName: string;
  modelVersion: string;
}

// SFace baseline threshold documented in OpenCV Zoo
export const SFACE_COSINE_THRESHOLD = 0.363;

// Canonical 5-point destination landmarks for SFace 112x112 aligned face chip
export const SFACE_REFERENCE_LANDMARKS: Array<[number, number]> = [
  [38.2946, 51.6963], // right eye
  [73.5318, 51.5014], // left eye
  [56.0252, 71.7366], // nose tip
  [41.5493, 92.3655], // right mouth corner
  [70.7299, 92.2041], // left mouth corner
];

let sessionsPromise: Promise<{ yunet: ort.InferenceSession; sface: ort.InferenceSession }> | null = null;

/**
 * Concurrency-safe inference session loader.
 * Uses a shared promise so concurrent cold starts create exactly one pair of sessions.
 * Resets the promise on failure so subsequent requests have a clean retry path.
 */
export async function getInferenceSessions() {
  if (!sessionsPromise) {
    sessionsPromise = (async () => {
      try {
        const yunetPath = path.resolve('server/models/face_detection_yunet_2023mar.onnx');
        const sfacePath = path.resolve('server/models/face_recognition_sface_2021dec.onnx');
        const options: ort.InferenceSession.SessionOptions = {
          logSeverityLevel: 3, // Suppress verbose initializer warnings
        };
        const [yunet, sface] = await Promise.all([
          ort.InferenceSession.create(yunetPath, options),
          ort.InferenceSession.create(sfacePath, options),
        ]);
        return { yunet, sface };
      } catch (err) {
        sessionsPromise = null;
        throw err;
      }
    })();
  }
  return sessionsPromise;
}

/**
 * Reset sessions for testing or re-initialization.
 */
export function resetInferenceSessions() {
  sessionsPromise = null;
}

// Compute Laplacian variance on grayscale buffer for blur detection
export function computeLaplacianVariance(grayscale: Uint8Array, width: number, height: number): number {
  if (width < 3 || height < 3) return 0;
  let sum = 0;
  let sumSq = 0;
  let count = 0;

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const idx = y * width + x;
      // 3x3 Laplacian kernel [0, 1, 0; 1, -4, 1; 0, 1, 0]
      const val =
        (grayscale[idx - width] ?? 0) +
        (grayscale[idx + width] ?? 0) +
        (grayscale[idx - 1] ?? 0) +
        (grayscale[idx + 1] ?? 0) -
        4 * (grayscale[idx] ?? 0);

      sum += val;
      sumSq += val * val;
      count++;
    }
  }

  const mean = sum / count;
  return sumSq / count - mean * mean;
}

// Compute luminance statistics
export function computeLuminanceStats(rgb: Uint8Array, totalPixels: number) {
  let sum = 0;
  let clippedHigh = 0;

  for (let i = 0; i < totalPixels; i++) {
    const r = rgb[i * 3] ?? 0;
    const g = rgb[i * 3 + 1] ?? 0;
    const b = rgb[i * 3 + 2] ?? 0;
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    sum += lum;
    if (lum > 250) clippedHigh++;
  }

  const mean = sum / totalPixels;
  const clippedRatio = clippedHigh / totalPixels;
  return { mean, clippedRatio };
}

// Non-maximum suppression
export function nms(boxes: DetectedFace[], iouThreshold = 0.4): DetectedFace[] {
  const sorted = [...boxes].sort((a, b) => b.score - a.score);
  const selected: DetectedFace[] = [];

  while (sorted.length > 0) {
    const current = sorted.shift()!;
    selected.push(current);

    for (let i = sorted.length - 1; i >= 0; i--) {
      const candidate = sorted[i];
      if (!candidate) continue;
      const xx1 = Math.max(current.x, candidate.x);
      const yy1 = Math.max(current.y, candidate.y);
      const xx2 = Math.min(current.x + current.w, candidate.x + candidate.w);
      const yy2 = Math.min(current.y + current.h, candidate.y + candidate.h);

      const w = Math.max(0, xx2 - xx1);
      const h = Math.max(0, yy2 - yy1);
      const interArea = w * h;
      const unionArea = current.w * current.h + candidate.w * candidate.h - interArea;
      const iou = unionArea > 0 ? interArea / unionArea : 0;

      if (iou > iouThreshold) {
        sorted.splice(i, 1);
      }
    }
  }

  return selected;
}

// Detect faces in an image buffer using YuNet
export async function detectFaces(imageBuffer: Buffer): Promise<DetectedFace[]> {
  const { yunet } = await getInferenceSessions();
  const targetW = 640;
  const targetH = 640;

  const resizedBuffer = await sharp(imageBuffer)
    .resize(targetW, targetH, { fit: 'contain', background: { r: 0, g: 0, b: 0 } })
    .removeAlpha()
    .raw()
    .toBuffer();

  const tensorData = new Float32Array(3 * targetW * targetH);
  const planeSize = targetW * targetH;

  for (let r = 0; r < targetH; r++) {
    for (let c = 0; c < targetW; c++) {
      const srcIdx = (r * targetW + c) * 3;
      const dstIdx = r * targetW + c;
      const R = resizedBuffer[srcIdx] ?? 0;
      const G = resizedBuffer[srcIdx + 1] ?? 0;
      const B = resizedBuffer[srcIdx + 2] ?? 0;
      // OpenCV BGR channel layout
      tensorData[dstIdx] = B;
      tensorData[planeSize + dstIdx] = G;
      tensorData[2 * planeSize + dstIdx] = R;
    }
  }

  const inputTensor = new ort.Tensor('float32', tensorData, [1, 3, targetH, targetW]);
  const results = await yunet.run({ input: inputTensor });

  const strides = [8, 16, 32];
  const candidates: DetectedFace[] = [];
  const scoreThreshold = 0.6;

  for (const stride of strides) {
    const cols = Math.floor(targetW / stride);
    const rows = Math.floor(targetH / stride);

    const cls = results[`cls_${stride}`]?.data as Float32Array | undefined;
    const obj = results[`obj_${stride}`]?.data as Float32Array | undefined;
    const bbox = results[`bbox_${stride}`]?.data as Float32Array | undefined;
    const kps = results[`kps_${stride}`]?.data as Float32Array | undefined;

    if (!cls || !obj || !bbox || !kps) {
      throw new Error(`yunet_missing_output:cls_${stride}`);
    }

    const expectedLength = rows * cols;
    if (cls.length < expectedLength || obj.length < expectedLength || bbox.length < expectedLength * 4 || kps.length < expectedLength * 10) {
      throw new Error(`yunet_malformed_output:stride_${stride}`);
    }

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const idx = r * cols + c;
        let cls_score = cls[idx] ?? 0;
        let obj_score = obj[idx] ?? 0;

        cls_score = Math.min(Math.max(cls_score, 0), 1);
        obj_score = Math.min(Math.max(obj_score, 0), 1);
        const score = Math.sqrt(cls_score * obj_score);

        if (!Number.isFinite(score) || score < scoreThreshold) continue;

        const bx0 = bbox[idx * 4 + 0] ?? 0;
        const bx1 = bbox[idx * 4 + 1] ?? 0;
        const bx2 = bbox[idx * 4 + 2] ?? 0;
        const bx3 = bbox[idx * 4 + 3] ?? 0;

        const cx = (c + bx0) * stride;
        const cy = (r + bx1) * stride;
        const w = Math.exp(bx2) * stride;
        const h = Math.exp(bx3) * stride;

        const x1 = cx - w / 2;
        const y1 = cy - h / 2;

        const landmarks: Array<[number, number]> = [];
        for (let n = 0; n < 5; n++) {
          const kxVal = kps[idx * 10 + 2 * n] ?? 0;
          const kyVal = kps[idx * 10 + 2 * n + 1] ?? 0;
          const kx = (kxVal + c) * stride;
          const ky = (kyVal + r) * stride;
          landmarks.push([kx, ky]);
        }

        candidates.push({ x: x1, y: y1, w, h, score, landmarks });
      }
    }
  }

  return nms(candidates);
}

/**
 * Mathematically exact 2D similarity transformation matrix (Umeyama / OpenCV parity).
 * Finds the optimal 2x3 matrix [a -b tx; b a ty] minimizing least-squares error between src and dst.
 * Completely immune to diagonal/axis-aligned singular branches.
 */
export function getSimilarityTransformMatrix(
  src: Array<[number, number]>,
  dst: Array<[number, number]> = SFACE_REFERENCE_LANDMARKS
): [[number, number, number], [number, number, number]] {
  if (!src || src.length < 5 || !dst || dst.length < 5) {
    throw new Error('Similarity transform requires at least 5 landmark points');
  }

  let srcMeanX = 0, srcMeanY = 0;
  let dstMeanX = 0, dstMeanY = 0;
  for (let i = 0; i < 5; i++) {
    const s = src[i]!;
    const d = dst[i]!;
    srcMeanX += s[0];
    srcMeanY += s[1];
    dstMeanX += d[0];
    dstMeanY += d[1];
  }
  srcMeanX /= 5;
  srcMeanY /= 5;
  dstMeanX /= 5;
  dstMeanY /= 5;

  let sum_ux_vy = 0;
  let sum_vx_uy = 0;
  let S_xx = 0;

  for (let i = 0; i < 5; i++) {
    const xi = src[i]![0] - srcMeanX;
    const yi = src[i]![1] - srcMeanY;
    const ui = dst[i]![0] - dstMeanX;
    const vi = dst[i]![1] - dstMeanY;

    sum_ux_vy += ui * xi + vi * yi;
    sum_vx_uy += vi * xi - ui * yi;
    S_xx += xi * xi + yi * yi;
  }

  if (S_xx < 1e-7) {
    throw new Error('Degenerate landmark configuration: points are collocated');
  }

  const a = sum_ux_vy / S_xx;
  const b = sum_vx_uy / S_xx;
  const tx = dstMeanX - (a * srcMeanX - b * srcMeanY);
  const ty = dstMeanY - (b * srcMeanX + a * srcMeanY);

  return [
    [a, -b, tx],
    [b, a, ty],
  ];
}

// Warp affine image to 112x112 using bilinear interpolation
export function warpAffine112(
  srcBuffer: Uint8Array,
  srcW: number,
  srcH: number,
  matrix: [[number, number, number], [number, number, number]]
): Uint8Array {
  const a = matrix[0][0], b = matrix[0][1], tx = matrix[0][2];
  const c = matrix[1][0], d = matrix[1][1], ty = matrix[1][2];

  const det = a * d - b * c;
  if (Math.abs(det) < 1e-9) throw new Error('Singular affine transform matrix');

  const invA = d / det;
  const invB = -b / det;
  const invC = -c / det;
  const invD = a / det;
  const invTx = (b * ty - d * tx) / det;
  const invTy = (c * tx - a * ty) / det;

  const dstW = 112;
  const dstH = 112;
  const dstBuffer = new Uint8Array(dstW * dstH * 3);

  for (let dy = 0; dy < dstH; dy++) {
    for (let dx = 0; dx < dstW; dx++) {
      const sx = invA * dx + invB * dy + invTx;
      const sy = invC * dx + invD * dy + invTy;

      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const x1 = x0 + 1;
      const y1 = y0 + 1;

      const wx1 = sx - x0;
      const wx0 = 1 - wx1;
      const wy1 = sy - y0;
      const wy0 = 1 - wy1;

      const dstIdx = (dy * dstW + dx) * 3;

      for (let ch = 0; ch < 3; ch++) {
        let val = 0;
        if (x0 >= 0 && x0 < srcW && y0 >= 0 && y0 < srcH) {
          val += wx0 * wy0 * (srcBuffer[(y0 * srcW + x0) * 3 + ch] ?? 0);
        }
        if (x1 >= 0 && x1 < srcW && y0 >= 0 && y0 < srcH) {
          val += wx1 * wy0 * (srcBuffer[(y0 * srcW + x1) * 3 + ch] ?? 0);
        }
        if (x0 >= 0 && x0 < srcW && y1 >= 0 && y1 < srcH) {
          val += wx0 * wy1 * (srcBuffer[(y1 * srcW + x0) * 3 + ch] ?? 0);
        }
        if (x1 >= 0 && x1 < srcW && y1 >= 0 && y1 < srcH) {
          val += wx1 * wy1 * (srcBuffer[(y1 * srcW + x1) * 3 + ch] ?? 0);
        }
        dstBuffer[dstIdx + ch] = Math.round(val);
      }
    }
  }

  return dstBuffer;
}

// Extract normalized SFace feature descriptor from an aligned 112x112 chip
export async function extractSFaceDescriptor(alignedBuffer: Uint8Array): Promise<Float32Array> {
  const { sface } = await getInferenceSessions();
  if (alignedBuffer.length !== 112 * 112 * 3) {
    throw new Error('invalid_aligned_face_dimensions');
  }

  const sfaceData = new Float32Array(3 * 112 * 112);
  const plane = 112 * 112;
  for (let i = 0; i < plane; i++) {
    sfaceData[i] = alignedBuffer[i * 3] ?? 0; // R
    sfaceData[plane + i] = alignedBuffer[i * 3 + 1] ?? 0; // G
    sfaceData[2 * plane + i] = alignedBuffer[i * 3 + 2] ?? 0; // B
  }

  const sfaceTensor = new ort.Tensor('float32', sfaceData, [1, 3, 112, 112]);
  const sfaceOut = await sface.run({ data: sfaceTensor });
  const rawFeat = sfaceOut.fc1?.data as Float32Array | undefined;
  if (!rawFeat || !(rawFeat instanceof Float32Array) || rawFeat.length !== 128) {
    throw new Error('sface_output_contract_violation');
  }

  // Validate finite values
  for (let i = 0; i < rawFeat.length; i++) {
    if (!Number.isFinite(rawFeat[i])) {
      throw new Error('sface_non_finite_descriptor');
    }
  }

  // L2-normalize
  let norm = 0;
  for (let i = 0; i < rawFeat.length; i++) {
    const val = rawFeat[i] ?? 0;
    norm += val * val;
  }
  norm = Math.sqrt(norm);
  if (norm < 1e-6) {
    throw new Error('sface_zero_norm_descriptor');
  }

  const normalized = new Float32Array(rawFeat.length);
  for (let i = 0; i < rawFeat.length; i++) {
    normalized[i] = (rawFeat[i] ?? 0) / norm;
  }

  return normalized;
}

// Align face and extract descriptor
export async function getAlignedFaceDescriptor(imageBuffer: Buffer, face: DetectedFace): Promise<Float32Array> {
  const resized640 = await sharp(imageBuffer)
    .resize(640, 640, { fit: 'contain', background: { r: 0, g: 0, b: 0 } })
    .removeAlpha()
    .raw()
    .toBuffer();

  const M = getSimilarityTransformMatrix(face.landmarks);
  const alignedBuffer = warpAffine112(new Uint8Array(resized640), 640, 640, M);
  return extractSFaceDescriptor(alignedBuffer);
}

// Evaluate face crop region for sharpness, exposure, and dimension
async function evaluateFaceCropQuality(
  originalBuffer: Buffer,
  meta: Metadata,
  face: DetectedFace,
  kind: 'selfie' | 'id'
): Promise<{ passed: boolean; code: QualityResultCode; message: string }> {
  const origW = meta.width ?? 0;
  const origH = meta.height ?? 0;
  if (origW < 1 || origH < 1) {
    return { passed: false, code: 'decode_failed', message: 'Invalid image dimensions.' };
  }

  const scale = Math.min(640 / origW, 640 / origH);
  const padX = (640 - origW * scale) / 2;
  const padY = (640 - origH * scale) / 2;

  const realFaceX = Math.max(0, Math.floor((face.x - padX) / scale));
  const realFaceY = Math.max(0, Math.floor((face.y - padY) / scale));
  const realFaceW = Math.min(origW - realFaceX, Math.ceil(face.w / scale));
  const realFaceH = Math.min(origH - realFaceY, Math.ceil(face.h / scale));

  if (realFaceW < 30 || realFaceH < 30) {
    return {
      passed: false,
      code: kind === 'selfie' ? 'face_too_small' : 'portrait_missing',
      message: kind === 'selfie'
        ? 'Move closer to the camera so your face is clearly visible.'
        : 'The portrait on your ID is too small. Please use a clearer, higher-resolution photo.',
    };
  }

  try {
    const faceCropBuffer = await sharp(originalBuffer)
      .extract({ left: realFaceX, top: realFaceY, width: realFaceW, height: realFaceH })
      .toBuffer();

    const faceMeta = await sharp(faceCropBuffer).metadata();
    const faceRaw = await sharp(faceCropBuffer).removeAlpha().raw().toBuffer();
    const faceW = faceMeta.width ?? realFaceW;
    const faceH = faceMeta.height ?? realFaceH;

    // 1. Exposure of face crop
    const { mean: faceLum, clippedRatio: faceClipped } = computeLuminanceStats(new Uint8Array(faceRaw), faceW * faceH);
    if (faceLum < 25) {
      return {
        passed: false,
        code: 'too_dark',
        message: kind === 'selfie'
          ? 'Your face is too dark. Please face a light source.'
          : 'The ID portrait is too dark. Please take the photo in good lighting.',
      };
    }
    if (faceLum > 240 && faceClipped > 0.4) {
      return {
        passed: false,
        code: 'overexposed',
        message: kind === 'selfie'
          ? 'Too much glare on your face. Please move away from harsh lighting.'
          : 'Glare or overexposure detected on the ID portrait.',
      };
    }

    // 2. Sharpness of face crop
    const faceGrayscale = await sharp(faceCropBuffer).grayscale().raw().toBuffer();
    const faceBlur = computeLaplacianVariance(new Uint8Array(faceGrayscale), faceW, faceH);

    const minBlur = kind === 'selfie' ? 25 : 20;
    if (faceBlur < minBlur) {
      return {
        passed: false,
        code: 'blurry',
        message: kind === 'selfie'
          ? 'Your face is blurry. Please hold steady and try again.'
          : 'The portrait on your ID is blurry. Please upload a clear, focused photo.',
      };
    }
  } catch (err) {
    console.warn('Face crop quality evaluation fallback:', err);
  }

  return { passed: true, code: 'ok', message: 'Face crop quality passed.' };
}

// Single-pass Image Analysis: decodes, detects faces, validates quality, and extracts descriptor
export async function analyzeFaceImage(
  imageBuffer: Buffer,
  kind: 'selfie' | 'id'
): Promise<AnalyzedFaceImage> {
  const modelName = 'opencv_zoo_yunet_sface';
  const modelVersion = 'yunet_2023mar_sface_2021dec';

  let meta: Metadata;
  let raw: Buffer;
  try {
    const image = sharp(imageBuffer);
    meta = await image.metadata();
    raw = await image.removeAlpha().raw().toBuffer();
  } catch {
    return {
      quality: { passed: false, code: 'decode_failed', message: 'The image could not be decoded.' },
      faces: [],
      dominantFace: null,
      descriptor: null,
      modelName,
      modelVersion,
    };
  }

  const format = meta.format?.toLowerCase();
  if (!format || !['jpeg', 'jpg', 'png', 'webp'].includes(format)) {
    return {
      quality: { passed: false, code: 'unsupported_format', message: 'Unsupported image format.' },
      faces: [],
      dominantFace: null,
      descriptor: null,
      modelName,
      modelVersion,
    };
  }

  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  const minDim = kind === 'selfie' ? 200 : 400;
  const longEdge = Math.max(width, height);
  if ((kind === 'selfie' && (width < minDim || height < minDim)) || (kind === 'id' && longEdge < minDim)) {
    return {
      quality: {
        passed: false,
        code: 'too_small',
        message: kind === 'selfie'
          ? 'Photo resolution is too small. Please retake the photo.'
          : 'The ID image resolution is too low. Please use a clearer image.',
      },
      faces: [],
      dominantFace: null,
      descriptor: null,
      modelName,
      modelVersion,
    };
  }

  // Exposure
  const { mean: lumMean, clippedRatio } = computeLuminanceStats(new Uint8Array(raw), width * height);
  const minLum = kind === 'selfie' ? 35 : 30;
  if (lumMean < minLum) {
    return {
      quality: {
        passed: false,
        code: 'too_dark',
        message: kind === 'selfie'
          ? 'Your face is too dark. Please move to better lighting and retake the photo.'
          : 'The ID image is too dark. Please use a brighter image.',
      },
      faces: [],
      dominantFace: null,
      descriptor: null,
      modelName,
      modelVersion,
    };
  }

  const maxLum = kind === 'selfie' ? 225 : 235;
  const maxClipped = kind === 'selfie' ? 0.3 : 0.4;
  if (lumMean > maxLum && clippedRatio > maxClipped) {
    return {
      quality: {
        passed: false,
        code: 'overexposed',
        message: kind === 'selfie'
          ? 'Your photo is overexposed. Please adjust lighting and retake the photo.'
          : 'The ID image has severe glare or overexposure. Please use a clearer image.',
      },
      faces: [],
      dominantFace: null,
      descriptor: null,
      modelName,
      modelVersion,
    };
  }

  // Blur
  const grayscale = await sharp(imageBuffer).grayscale().raw().toBuffer();
  const blurScore = computeLaplacianVariance(new Uint8Array(grayscale), width, height);
  const minBlur = kind === 'selfie' ? 35 : 25;
  if (blurScore < minBlur) {
    return {
      quality: {
        passed: false,
        code: 'blurry',
        message: kind === 'selfie'
          ? 'Your photo is too blurry. Please hold the device steady and try again.'
          : 'The ID image is too blurry. Please use a clearer image of the front of your valid ID.',
      },
      faces: [],
      dominantFace: null,
      descriptor: null,
      modelName,
      modelVersion,
    };
  }

  // Face Detection via YuNet
  let faces: DetectedFace[];
  try {
    faces = await detectFaces(imageBuffer);
  } catch (err: any) {
    return {
      quality: { passed: false, code: 'decode_failed', message: `Face detection engine error: ${err?.message || 'unknown'}` },
      faces: [],
      dominantFace: null,
      descriptor: null,
      modelName,
      modelVersion,
    };
  }

  if (faces.length === 0) {
    return {
      quality: {
        passed: false,
        code: kind === 'selfie' ? 'no_face' : 'portrait_missing',
        message: kind === 'selfie'
          ? 'No face was detected. Please position your face inside the guide and try again.'
          : "We couldn't clearly locate the portrait on this ID. Please use a clearer image of the front of your valid ID.",
      },
      faces: [],
      dominantFace: null,
      descriptor: null,
      modelName,
      modelVersion,
    };
  }

  let dominantFace: DetectedFace | null = null;
  if (kind === 'selfie') {
    if (faces.length > 1) {
      return {
        quality: {
          passed: false,
          code: 'multiple_faces',
          message: 'More than one face was detected. Only the visitor should be visible.',
        },
        faces,
        dominantFace: null,
        descriptor: null,
        modelName,
        modelVersion,
      };
    }
    dominantFace = faces[0]!;

    if (dominantFace.w < 70 || dominantFace.h < 70) {
      return {
        quality: { passed: false, code: 'face_too_small', message: 'Move slightly closer to the camera.' },
        faces,
        dominantFace,
        descriptor: null,
        modelName,
        modelVersion,
      };
    }

    if (dominantFace.x < 10 || dominantFace.y < 10 || dominantFace.x + dominantFace.w > 630 || dominantFace.y + dominantFace.h > 630) {
      return {
        quality: { passed: false, code: 'face_cropped', message: 'Position your full face inside the guide and try again.' },
        faces,
        dominantFace,
        descriptor: null,
        modelName,
        modelVersion,
      };
    }

    if (!dominantFace.landmarks || dominantFace.landmarks.length < 5) {
      return {
        quality: { passed: false, code: 'pose_unsuitable', message: 'Look directly at the camera with a neutral expression.' },
        faces,
        dominantFace,
        descriptor: null,
        modelName,
        modelVersion,
      };
    }

    const re = dominantFace.landmarks[0]!;
    const le = dominantFace.landmarks[1]!;
    const eyeDist = Math.hypot((le[0] ?? 0) - (re[0] ?? 0), (le[1] ?? 0) - (re[1] ?? 0));
    if (eyeDist < 25) {
      return {
        quality: { passed: false, code: 'pose_unsuitable', message: 'Look directly at the camera with your face clearly visible.' },
        faces,
        dominantFace,
        descriptor: null,
        modelName,
        modelVersion,
      };
    }
  } else {
    // ID document portrait selection
    if (faces.length > 1) {
      const sorted = [...faces].sort((a, b) => b.w * b.h - a.w * a.h);
      const top1 = sorted[0]!;
      const top2 = sorted[1]!;
      const areaRatio = (top1.w * top1.h) / (top2.w * top2.h || 1);
      if (areaRatio < 1.8 && Math.abs(top1.score - top2.score) < 0.15) {
        return {
          quality: {
            passed: false,
            code: 'ambiguous_portrait',
            message: 'Multiple competing portraits were detected on the ID. Please frame the front of your ID clearly.',
          },
          faces,
          dominantFace: null,
          descriptor: null,
          modelName,
          modelVersion,
        };
      }
      dominantFace = top1;
    } else {
      dominantFace = faces[0]!;
    }
  }

  // Face crop quality evaluation
  const cropQuality = await evaluateFaceCropQuality(imageBuffer, meta, dominantFace, kind);
  if (!cropQuality.passed) {
    return {
      quality: cropQuality,
      faces,
      dominantFace,
      descriptor: null,
      modelName,
      modelVersion,
    };
  }

  // Extract SFace descriptor once
  let descriptor: Float32Array;
  try {
    descriptor = await getAlignedFaceDescriptor(imageBuffer, dominantFace);
  } catch (err: any) {
    return {
      quality: { passed: false, code: 'decode_failed', message: `Descriptor extraction failed: ${err?.message || 'unknown'}` },
      faces,
      dominantFace,
      descriptor: null,
      modelName,
      modelVersion,
    };
  }

  return {
    quality: { passed: true, code: 'ok', message: kind === 'selfie' ? 'Live face quality passed.' : 'ID image quality passed.' },
    faces,
    dominantFace,
    descriptor,
    modelName,
    modelVersion,
  };
}

// Evaluate Live Face technical image quality
export async function evaluateLiveFaceQuality(imageBuffer: Buffer): Promise<QualityEvaluation> {
  const analysis = await analyzeFaceImage(imageBuffer, 'selfie');
  return analysis.quality;
}

// Evaluate Valid ID image technical quality
export async function evaluateIdImageQuality(imageBuffer: Buffer): Promise<QualityEvaluation> {
  const analysis = await analyzeFaceImage(imageBuffer, 'id');
  return analysis.quality;
}

// Compare live selfie face vs ID portrait using single-pass analysis
export async function compareFaces(
  liveFaceBuffer: Buffer,
  idImageBuffer: Buffer
): Promise<VerificationResult> {
  const modelName = 'opencv_zoo_yunet_sface';
  const modelVersion = 'yunet_2023mar_sface_2021dec';

  try {
    const [liveAnalysis, idAnalysis] = await Promise.all([
      analyzeFaceImage(liveFaceBuffer, 'selfie'),
      analyzeFaceImage(idImageBuffer, 'id'),
    ]);

    if (!liveAnalysis.quality.passed) {
      if (liveAnalysis.quality.code === 'no_face') return { outcome: 'no_face_in_selfie', matched: false, modelName, modelVersion };
      if (liveAnalysis.quality.code === 'multiple_faces') return { outcome: 'multiple_selfie_faces', matched: false, modelName, modelVersion };
      return { outcome: 'low_quality_selfie', matched: false, modelName, modelVersion, error: liveAnalysis.quality.message };
    }

    if (!idAnalysis.quality.passed) {
      if (idAnalysis.quality.code === 'portrait_missing') return { outcome: 'no_face_in_id', matched: false, modelName, modelVersion };
      if (idAnalysis.quality.code === 'ambiguous_portrait') return { outcome: 'ambiguous_id_faces', matched: false, modelName, modelVersion };
      return { outcome: 'low_quality_id', matched: false, modelName, modelVersion, error: idAnalysis.quality.message };
    }

    if (!liveAnalysis.descriptor || !idAnalysis.descriptor) {
      return {
        outcome: 'engine_error',
        matched: false,
        modelName,
        modelVersion,
        error: 'Descriptor extraction failed',
      };
    }

    const cosineSim = computeCosineSimilarity(liveAnalysis.descriptor, idAnalysis.descriptor);
    const matched = cosineSim >= SFACE_COSINE_THRESHOLD;

    return {
      outcome: matched ? 'matched' : 'mismatch',
      matched,
      score: cosineSim,
      modelName,
      modelVersion,
    };
  } catch (err) {
    console.error('Face comparison pipeline error:', err);
    return {
      outcome: 'engine_error',
      matched: false,
      modelName,
      modelVersion,
      error: err instanceof Error ? err.message : 'engine_error',
    };
  }
}

// ----------------------------------------------------------------------------
// Returning Visitor Biometric Extensions (1:N Gallery & Encrypted Persistence)
// ----------------------------------------------------------------------------

export function computeCosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const valA = a[i] ?? 0;
    const valB = b[i] ?? 0;
    dot += valA * valB;
    normA += valA * valA;
    normB += valB * valB;
  }
  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator > 0 ? dot / denominator : 0;
}

export async function extractFaceDescriptorFromBuffer(
  imageBuffer: Buffer
): Promise<{ descriptor: Float32Array; modelName: string; modelVersion: string }> {
  const analysis = await analyzeFaceImage(imageBuffer, 'selfie');
  if (!analysis.quality.passed) {
    throw new Error(analysis.quality.code);
  }
  if (!analysis.descriptor) {
    throw new Error('descriptor_unavailable');
  }
  return {
    descriptor: analysis.descriptor,
    modelName: analysis.modelName,
    modelVersion: analysis.modelVersion,
  };
}

export function parseTemplateKey(keyInput: string): Buffer {
  if (!keyInput || typeof keyInput !== 'string') {
    throw new Error('template_key_missing');
  }
  const trimmed = keyInput.trim();
  if (trimmed.length === 64 && /^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return Buffer.from(trimmed, 'hex');
  }
  if (Buffer.byteLength(trimmed, 'utf8') === 32) {
    return Buffer.from(trimmed, 'utf8');
  }
  const buf = Buffer.from(trimmed, 'base64');
  if (buf.length === 32) return buf;
  return crypto.createHash('sha256').update(trimmed).digest();
}

/**
 * Resolves an active or version-specific template key from a keyring or secret.
 */
export function getVersionedTemplateKey(
  keyVersion = 'v1',
  keyringOrSecret?: string | Record<string, string>
): string {
  if (keyringOrSecret && typeof keyringOrSecret === 'object') {
    const key = keyringOrSecret[keyVersion];
    if (!key) throw new Error(`unsupported_template_key_version:${keyVersion}`);
    return key;
  }

  if (process.env.RETURNING_VISITOR_KEYRING) {
    try {
      const parsedRing = JSON.parse(process.env.RETURNING_VISITOR_KEYRING);
      if (parsedRing && typeof parsedRing === 'object' && parsedRing[keyVersion]) {
        return parsedRing[keyVersion];
      }
    } catch {
      // Fall through on JSON parse error
    }
  }

  const primaryKey = (typeof keyringOrSecret === 'string' && keyringOrSecret) || process.env.RETURNING_VISITOR_TEMPLATE_KEY;
  if (!primaryKey) {
    throw new Error('template_key_missing');
  }

  const activeVersion = process.env.RETURNING_VISITOR_ACTIVE_KEY_VERSION || 'v1';
  if (keyVersion === activeVersion || keyVersion === 'v1') {
    return primaryKey;
  }

  throw new Error(`unsupported_template_key_version:${keyVersion}`);
}

export function encryptFaceTemplate(
  descriptor: Float32Array,
  keyHexOrSecret: string,
  keyVersion = 'v1'
): { encryptedEmbedding: string; iv: string; authTag: string; keyVersion: string } {
  const resolvedKey = getVersionedTemplateKey(keyVersion, keyHexOrSecret);
  const key = parseTemplateKey(resolvedKey);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const rawBytes = Buffer.from(descriptor.buffer, descriptor.byteOffset, descriptor.byteLength);
  const encrypted = Buffer.concat([cipher.update(rawBytes), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    encryptedEmbedding: encrypted.toString('hex'),
    iv: iv.toString('hex'),
    authTag: authTag.toString('hex'),
    keyVersion,
  };
}

export function decryptFaceTemplate(
  encryptedHex: string,
  ivHex: string,
  authTagHex: string,
  keyHexOrSecret: string,
  keyVersion = 'v1'
): Float32Array {
  const resolvedKey = getVersionedTemplateKey(keyVersion, keyHexOrSecret);
  const key = parseTemplateKey(resolvedKey);
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encryptedHex, 'hex')),
    decipher.final(),
  ]);
  const floatCount = decrypted.byteLength / 4;
  const floatArr = new Float32Array(floatCount);
  for (let i = 0; i < floatCount; i++) {
    floatArr[i] = decrypted.readFloatLE(i * 4);
  }
  return floatArr;
}
