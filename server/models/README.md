# E-GatePass Biometric Face Models Provenance & Contract

This directory stores the official ONNX models used by the server-side biometric identity verification pipeline (`server/lib/face-engine.ts`).

## Model Artifacts & Integrity

| Model File | Version | Upstream Source | License | SHA-256 Checksum |
|---|---|---|---|---|
| `face_detection_yunet_2023mar.onnx` | 2023mar | Shiqi Yu / `libfacedetection` & [OpenCV Zoo YuNet](https://github.com/opencv/opencv_zoo/tree/master/models/face_detection_yunet) | Apache-2.0 | `8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4` |
| `face_recognition_sface_2021dec.onnx` | 2021dec | [OpenCV Zoo SFace](https://github.com/opencv/opencv_zoo/tree/master/models/face_recognition_sface) | Apache-2.0 | `0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79` |

## Execution Runtime

- **Inference Engine**: `onnxruntime-node: 1.31.1` (exact pinned dependency).
- **Execution Target**: Node.js CPU execution provider.

## Technical Specifications & Inference Contracts

### 1. YuNet Face Detection (`face_detection_yunet_2023mar.onnx`)
- **Upstream Provenance**: Authored by Shiqi Yu (`libfacedetection`) and distributed via OpenCV Zoo under Apache-2.0 license.
- **Input Contract**: Fixed `[1, 3, 640, 640]` BGR letterboxed image tensor with zero-padded aspect preservation, as fed by the inference runtime preprocessor (`server/lib/face-engine.ts`).
- **Output Contract**: Bounding boxes `[x, y, w, h]`, detection confidence score `[0, 1]`, and 5 facial landmarks (right eye, left eye, nose tip, right mouth corner, left mouth corner).
- **Verification Usage**:
  - Live face capture preflight: Verifies exactly one face is present, checks face bounding box size relative to frame, verifies face centering and absence of severe edge cropping, and verifies landmark presence.
  - ID document processing: Detects face portraits in uploaded identity cards, verifies at least one prominent portrait exists, and extracts the primary face portrait for alignment.

### 2. SFace Face Recognition (`face_recognition_sface_2021dec.onnx`)
- **Input Contract**: Aligned and cropped face patch resized to `[1, 3, 112, 112]` using 5-point landmark similarity transformation.
- **Output Contract**: 128-dimensional unit-norm feature vector (`float32[128]`).
- **Metric**: Cosine similarity between the live face embedding and ID portrait embedding.
  - Matching Threshold: `0.363` (calibrated against OpenCV Zoo benchmark for false acceptance rate control).
  - Scores `>= 0.363` are classified as `matched`.
  - Scores `< 0.363` are classified as `mismatch`.

## Biometric Privacy & Security Boundaries

1. **Ephemeral Execution**: All model inference, tensor allocations, landmarks, and 128-d embeddings exist strictly in volatile Node.js process memory during the lifecycle of the HTTP request.
2. **Zero Biometric Persistence**: Neither the database (`portal_identity_verification_attempts`, `passes`, `visitor_evidence`) nor file storage ever stores facial embeddings, landmarks, bounding boxes, or intermediate feature representations. Only high-level verification outcomes (`matched`, `mismatch`, `no_face_in_id`, etc.) and timestamps are persisted.
3. **No Liveness Claims**: The system performs 1:1 facial visual match against the presented physical government or institutional ID document. It does not perform active liveness challenges (e.g., blink detection, 3D depth, texture anti-spoofing) and makes no claim of biometric liveness certification.
