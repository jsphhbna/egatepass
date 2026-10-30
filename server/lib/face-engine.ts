import * as ort from 'onnxruntime-node';
import sharp, { type Metadata } from 'sharp';
import path from 'node:path';

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

// SFace baseline threshold documented in OpenCV Zoo
export const SFACE_COSINE_THRESHOLD = 0.363;

let yunetSession: ort.InferenceSession | null = null;
let sfaceSession: ort.InferenceSession | null = null;

async function getInferenceSessions() {
  if (!yunetSession) {
    const yunetPath = path.resolve('server/models/face_detection_yunet_2023mar.onnx');
    const options: ort.InferenceSession.SessionOptions = {
      logSeverityLevel: 3, // Suppress verbose initializer warnings
    };
    yunetSession = await ort.InferenceSession.create(yunetPath, options);
  }
  if (!sfaceSession) {
    const sfacePath = path.resolve('server/models/face_recognition_sface_2021dec.onnx');
    const options: ort.InferenceSession.SessionOptions = {
      logSeverityLevel: 3,
    };
    sfaceSession = await ort.InferenceSession.create(sfacePath, options);
  }
  return { yunet: yunetSession, sface: sfaceSession };
}

// Compute Laplacian variance on grayscale buffer for blur detection
function computeLaplacianVariance(grayscale: Uint8Array, width: number, height: number): number {
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
function computeLuminanceStats(rgb: Uint8Array, totalPixels: number) {
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
function nms(boxes: DetectedFace[], iouThreshold = 0.4): DetectedFace[] {
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
    if (!cls || !obj || !bbox || !kps) continue;

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const idx = r * cols + c;
        let cls_score = cls[idx] ?? 0;
        let obj_score = obj[idx] ?? 0;

        cls_score = Math.min(Math.max(cls_score, 0), 1);
        obj_score = Math.min(Math.max(obj_score, 0), 1);
        const score = Math.sqrt(cls_score * obj_score);

        if (score < scoreThreshold) continue;

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

// Evaluate Live Face technical image quality
export async function evaluateLiveFaceQuality(imageBuffer: Buffer): Promise<QualityEvaluation> {
  let meta: Metadata;
  let raw: Buffer;
  try {
    const image = sharp(imageBuffer);
    meta = await image.metadata();
    raw = await image.removeAlpha().raw().toBuffer();
  } catch {
    return { passed: false, code: 'decode_failed', message: 'The captured image could not be decoded.' };
  }

  const format = meta.format?.toLowerCase();
  if (!format || !['jpeg', 'jpg', 'png', 'webp'].includes(format)) {
    return { passed: false, code: 'unsupported_format', message: 'Unsupported image format.' };
  }

  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (width < 200 || height < 200) {
    return { passed: false, code: 'too_small', message: 'Photo resolution is too small. Please retake the photo.' };
  }

  // Exposure evaluation
  const { mean: luminanceMean, clippedRatio } = computeLuminanceStats(new Uint8Array(raw), width * height);
  if (luminanceMean < 35) {
    return { passed: false, code: 'too_dark', message: 'Your face is too dark. Please move to better lighting and retake the photo.' };
  }
  if (luminanceMean > 225 && clippedRatio > 0.3) {
    return { passed: false, code: 'overexposed', message: 'Your photo is overexposed. Please adjust lighting and retake the photo.' };
  }

  // Blur evaluation via grayscale Laplacian
  const grayscale = await sharp(imageBuffer).grayscale().raw().toBuffer();
  const blurScore = computeLaplacianVariance(new Uint8Array(grayscale), width, height);
  if (blurScore < 40) {
    return { passed: false, code: 'blurry', message: 'Your photo is too blurry. Please hold the device steady and try again.' };
  }

  // Detect faces
  let faces: DetectedFace[];
  try {
    faces = await detectFaces(imageBuffer);
  } catch {
    return { passed: false, code: 'decode_failed', message: 'Face detection engine error.' };
  }

  if (faces.length === 0) {
    return { passed: false, code: 'no_face', message: 'No face was detected. Please position your face inside the guide and try again.' };
  }
  if (faces.length > 1) {
    return { passed: false, code: 'multiple_faces', message: 'More than one face was detected. Only the visitor should be visible.' };
  }

  const face = faces[0];
  if (!face) {
    return { passed: false, code: 'no_face', message: 'No face was detected. Please position your face inside the guide and try again.' };
  }
  // Face size check (in 640x640 space)
  if (face.w < 70 || face.h < 70) {
    return { passed: false, code: 'face_too_small', message: 'Move slightly closer to the camera.' };
  }

  // Face boundary framing
  if (face.x < 10 || face.y < 10 || face.x + face.w > 630 || face.y + face.h > 630) {
    return { passed: false, code: 'face_cropped', message: 'Position your full face inside the guide and try again.' };
  }

  // Landmark pose check
  if (!face.landmarks || face.landmarks.length < 5) {
    return { passed: false, code: 'pose_unsuitable', message: 'Look directly at the camera with a neutral expression.' };
  }

  const re = face.landmarks[0]!;
  const le = face.landmarks[1]!;
  const eyeDist = Math.hypot((le[0] ?? 0) - (re[0] ?? 0), (le[1] ?? 0) - (re[1] ?? 0));
  if (eyeDist < 25) {
    return { passed: false, code: 'pose_unsuitable', message: 'Look directly at the camera with your face clearly visible.' };
  }

  return { passed: true, code: 'ok', message: 'Live face quality passed.' };
}

// Evaluate Valid ID image technical quality
export async function evaluateIdImageQuality(imageBuffer: Buffer): Promise<QualityEvaluation> {
  let meta: Metadata;
  let raw: Buffer;
  try {
    const image = sharp(imageBuffer);
    meta = await image.metadata();
    raw = await image.removeAlpha().raw().toBuffer();
  } catch {
    return { passed: false, code: 'decode_failed', message: 'The ID image could not be decoded.' };
  }

  const format = meta.format?.toLowerCase();
  if (!format || !['jpeg', 'jpg', 'png', 'webp'].includes(format)) {
    return { passed: false, code: 'unsupported_format', message: 'Unsupported ID image format.' };
  }

  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  const longEdge = Math.max(width, height);
  if (longEdge < 400) {
    return { passed: false, code: 'too_small', message: 'The ID image resolution is too low. Please use a clearer image.' };
  }

  // Exposure evaluation
  const { mean: luminanceMean, clippedRatio } = computeLuminanceStats(new Uint8Array(raw), width * height);
  if (luminanceMean < 30) {
    return { passed: false, code: 'too_dark', message: 'The ID image is too dark. Please use a brighter image.' };
  }
  if (luminanceMean > 235 && clippedRatio > 0.4) {
    return { passed: false, code: 'overexposed', message: 'The ID image has severe glare or overexposure. Please use a clearer image.' };
  }

  // Blur evaluation
  const grayscale = await sharp(imageBuffer).grayscale().raw().toBuffer();
  const blurScore = computeLaplacianVariance(new Uint8Array(grayscale), width, height);
  if (blurScore < 30) {
    return { passed: false, code: 'blurry', message: 'The ID image is too blurry. Please use a clearer image of the front of your valid ID.' };
  }

  // Plausible portrait face detection on ID
  let faces: DetectedFace[];
  try {
    faces = await detectFaces(imageBuffer);
  } catch {
    return { passed: false, code: 'decode_failed', message: 'ID face detection error.' };
  }

  if (faces.length === 0) {
    return { passed: false, code: 'portrait_missing', message: "We couldn't clearly locate the portrait on this ID. Please use a clearer image of the front of your valid ID." };
  }

  if (faces.length > 1) {
    // Check if one dominant portrait exists (e.g. area >= 2x any second face or confidence much higher)
    const sorted = [...faces].sort((a, b) => b.w * b.h - a.w * a.h);
    const dominant = sorted[0];
    const second = sorted[1];
    if (dominant && second) {
      const areaRatio = (dominant.w * dominant.h) / (second.w * second.h || 1);
      if (areaRatio < 1.8 && Math.abs(dominant.score - second.score) < 0.15) {
        return { passed: false, code: 'ambiguous_portrait', message: 'Multiple competing portraits were detected on the ID. Please frame the front of your ID clearly.' };
      }
    }
  }

  return { passed: true, code: 'ok', message: 'ID image quality passed.' };
}

// Compute Umeyama similarity transform matrix (standard ArcFace/SFace 5-point alignment)
function getSimilarityTransformMatrix(src: Array<[number, number]>): [[number, number, number], [number, number, number]] {
  const dst = [
    [38.2946, 51.6963],
    [73.5318, 51.5014],
    [56.0252, 71.7366],
    [41.5493, 92.3655],
    [70.7299, 92.2041],
  ];

  let srcMeanX = 0, srcMeanY = 0;
  const dstMeanX = 56.0262, dstMeanY = 71.9008;
  for (let i = 0; i < 5; i++) {
    const pt = src[i];
    if (pt) {
      srcMeanX += pt[0];
      srcMeanY += pt[1];
    }
  }
  srcMeanX /= 5;
  srcMeanY /= 5;

  const srcDemean = src.map((pt) => [(pt[0] ?? 0) - srcMeanX, (pt[1] ?? 0) - srcMeanY]);
  const dstDemean = dst.map((pt) => [(pt[0] ?? 0) - dstMeanX, (pt[1] ?? 0) - dstMeanY]);

  let A00 = 0, A01 = 0, A10 = 0, A11 = 0;
  for (let i = 0; i < 5; i++) {
    const dPt = dstDemean[i];
    const sPt = srcDemean[i];
    if (dPt && sPt) {
      A00 += (dPt[0] ?? 0) * (sPt[0] ?? 0);
      A01 += (dPt[0] ?? 0) * (sPt[1] ?? 0);
      A10 += (dPt[1] ?? 0) * (sPt[0] ?? 0);
      A11 += (dPt[1] ?? 0) * (sPt[1] ?? 0);
    }
  }
  A00 /= 5; A01 /= 5; A10 /= 5; A11 /= 5;

  const detA = A00 * A11 - A01 * A10;
  const d0 = 1.0;
  const d1 = detA < 0 ? -1.0 : 1.0;

  const ata00 = A00 * A00 + A10 * A10;
  const ata01 = A00 * A01 + A10 * A11;
  const ata11 = A01 * A01 + A11 * A11;

  const tr = ata00 + ata11;
  const diff = ata00 - ata11;
  const disc = Math.sqrt(diff * diff + 4 * ata01 * ata01);
  const l1 = (tr + disc) / 2;
  const l2 = Math.max((tr - disc) / 2, 0);

  const s0 = Math.sqrt(Math.max(l1, 0));
  const s1 = Math.sqrt(Math.max(l2, 0));

  let v00 = 1, v01 = 0, v10 = 0, v11 = 1;
  if (Math.abs(ata01) > 1e-7) {
    const v1_x = ata01;
    const v1_y = l1 - ata00;
    const norm1 = Math.hypot(v1_x, v1_y);
    v00 = v1_x / (norm1 || 1);
    v10 = v1_y / (norm1 || 1);

    const v2_x = ata01;
    const v2_y = l2 - ata00;
    const norm2 = Math.hypot(v2_x, v2_y);
    v01 = v2_x / (norm2 || 1);
    v11 = v2_y / (norm2 || 1);
  }

  let u00 = 0, u01 = 0, u10 = 0, u11 = 0;
  if (s0 > 1e-7) {
    u00 = (A00 * v00 + A01 * v10) / s0;
    u10 = (A10 * v00 + A11 * v10) / s0;
  }
  if (s1 > 1e-7) {
    u01 = (A00 * v01 + A01 * v11) / s1;
    u11 = (A10 * v01 + A11 * v11) / s1;
  }

  const dvt00 = v00;
  const dvt01 = v10;
  const dvt10 = d1 * v01;
  const dvt11 = d1 * v11;

  const R00 = u00 * dvt00 + u01 * dvt10;
  const R01 = u00 * dvt01 + u01 * dvt11;
  const R10 = u10 * dvt00 + u11 * dvt10;
  const R11 = u10 * dvt01 + u11 * dvt11;

  let var1 = 0, var2 = 0;
  for (let i = 0; i < 5; i++) {
    const sPt = srcDemean[i];
    if (sPt) {
      var1 += (sPt[0] ?? 0) * (sPt[0] ?? 0);
      var2 += (sPt[1] ?? 0) * (sPt[1] ?? 0);
    }
  }
  var1 /= 5;
  var2 /= 5;

  const scale = (s0 * d0 + s1 * d1) / (var1 + var2 || 1);

  const T00 = R00 * scale;
  const T01 = R01 * scale;
  const T10 = R10 * scale;
  const T11 = R11 * scale;

  const T02 = dstMeanX - scale * (R00 * srcMeanX + R01 * srcMeanY);
  const T12 = dstMeanY - scale * (R10 * srcMeanX + R11 * srcMeanY);

  return [
    [T00, T01, T02],
    [T10, T11, T12],
  ];
}

// Warp affine image to 112x112 using bilinear interpolation
function warpAffine112(srcBuffer: Uint8Array, srcW: number, srcH: number, matrix: [[number, number, number], [number, number, number]]): Uint8Array {
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
async function extractSFaceDescriptor(alignedBuffer: Uint8Array): Promise<Float32Array> {
  const { sface } = await getInferenceSessions();
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
  if (!rawFeat) throw new Error('SFace model failed to return feature embedding');

  // L2-normalize
  let norm = 0;
  for (let i = 0; i < rawFeat.length; i++) {
    const val = rawFeat[i] ?? 0;
    norm += val * val;
  }
  norm = Math.sqrt(norm);
  const normalized = new Float32Array(rawFeat.length);
  for (let i = 0; i < rawFeat.length; i++) {
    normalized[i] = (rawFeat[i] ?? 0) / (norm || 1);
  }

  return normalized;
}

// Align face and extract descriptor
async function getAlignedFaceDescriptor(imageBuffer: Buffer, face: DetectedFace): Promise<Float32Array> {
  const resized640 = await sharp(imageBuffer)
    .resize(640, 640, { fit: 'contain', background: { r: 0, g: 0, b: 0 } })
    .removeAlpha()
    .raw()
    .toBuffer();

  const M = getSimilarityTransformMatrix(face.landmarks);
  const alignedBuffer = warpAffine112(new Uint8Array(resized640), 640, 640, M);
  return extractSFaceDescriptor(alignedBuffer);
}

// Compare live selfie face vs ID portrait
export async function compareFaces(
  liveFaceBuffer: Buffer,
  idImageBuffer: Buffer
): Promise<VerificationResult> {
  const modelName = 'opencv_zoo_yunet_sface';
  const modelVersion = 'yunet_2023mar_sface_2021dec';

  try {
    // 1. Revalidate live face quality on server
    const liveQuality = await evaluateLiveFaceQuality(liveFaceBuffer);
    if (!liveQuality.passed) {
      if (liveQuality.code === 'no_face') return { outcome: 'no_face_in_selfie', matched: false, modelName, modelVersion };
      if (liveQuality.code === 'multiple_faces') return { outcome: 'multiple_selfie_faces', matched: false, modelName, modelVersion };
      return { outcome: 'low_quality_selfie', matched: false, modelName, modelVersion, error: liveQuality.message };
    }

    // 2. Revalidate ID quality on server
    const idQuality = await evaluateIdImageQuality(idImageBuffer);
    if (!idQuality.passed) {
      if (idQuality.code === 'portrait_missing') return { outcome: 'no_face_in_id', matched: false, modelName, modelVersion };
      if (idQuality.code === 'ambiguous_portrait') return { outcome: 'ambiguous_id_faces', matched: false, modelName, modelVersion };
      return { outcome: 'low_quality_id', matched: false, modelName, modelVersion, error: idQuality.message };
    }

    // 3. Detect faces on both
    const liveFaces = await detectFaces(liveFaceBuffer);
    if (liveFaces.length !== 1) {
      return {
        outcome: liveFaces.length === 0 ? 'no_face_in_selfie' : 'multiple_selfie_faces',
        matched: false,
        modelName,
        modelVersion,
      };
    }

    const idFaces = await detectFaces(idImageBuffer);
    if (idFaces.length === 0) {
      return { outcome: 'no_face_in_id', matched: false, modelName, modelVersion };
    }

    // Select dominant portrait on ID
    const sortedIdFaces = [...idFaces].sort((a, b) => b.w * b.h - a.w * a.h);
    const chosenIdFace = sortedIdFaces[0];
    const liveFace = liveFaces[0];

    if (!chosenIdFace || !liveFace) {
      return {
        outcome: !liveFace ? 'no_face_in_selfie' : 'no_face_in_id',
        matched: false,
        modelName,
        modelVersion,
      };
    }

    // 4. Align both faces & extract descriptors
    const liveDescriptor = await getAlignedFaceDescriptor(liveFaceBuffer, liveFace);
    const idDescriptor = await getAlignedFaceDescriptor(idImageBuffer, chosenIdFace);

    // 5. Cosine similarity
    let cosineSim = 0;
    for (let i = 0; i < liveDescriptor.length; i++) {
      cosineSim += (liveDescriptor[i] ?? 0) * (idDescriptor[i] ?? 0);
    }

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
