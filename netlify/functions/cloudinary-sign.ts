import { Handler } from '@netlify/functions';
import { v2 as cloudinary } from 'cloudinary';
import crypto from 'crypto';
import { FieldValue, Timestamp, getFirestore } from 'firebase-admin/firestore';
import { handleAuthError } from './utils/auth';
import { requireImageUploadActor } from './utils/image-security';
import { SECURE_IMAGE_DELIVERY_TYPE } from './utils/image-lifecycle';
import { clientAddressFromHeaders, enforceRateLimit, RateLimitError } from './utils/rate-limit';

// Configure Cloudinary using server-only env vars
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true,
});

// Server-controlled allowlist of Cloudinary folders.
// The generic root 'e-gatepass' folder is NOT included because all uploads
// go to either 'e-gatepass/photos' or 'e-gatepass/ids' in the current codebase.
const ALLOWED_FOLDERS = ['e-gatepass/ids', 'e-gatepass/photos'] as const;

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  if ((event.body?.length || 0) > 1024) {
    return { statusCode: 413, body: JSON.stringify({ error: 'Request body is too large' }) };
  }

  try {
    // Verify Firebase auth token (allows anonymous visitors and device accounts)
    const actor = await requireImageUploadActor(event.headers.authorization || event.headers.Authorization);

    // Parse and validate the requested folder
    let body: unknown;
    try {
      body = event.body ? JSON.parse(event.body) : {};
    } catch {
      return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) };
    }
    if (typeof body !== 'object' || body === null || Object.keys(body).some((key) => key !== 'folder')) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request body' }) };
    }
    const requestedFolder = 'folder' in body && typeof body.folder === 'string' ? body.folder : '';

    if (!ALLOWED_FOLDERS.includes(requestedFolder as typeof ALLOWED_FOLDERS[number])) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Invalid folder requested' }) };
    }

    await enforceRateLimit(getFirestore(), {
      operation: 'cloudinary_sign',
      actorType: actor.type,
      uid: actor.uid,
      clientAddress: clientAddressFromHeaders(event.headers),
    });

    if (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET) {
      console.error('Cloudinary signing is missing required configuration');
      return { statusCode: 500, body: JSON.stringify({ error: 'Image upload is not configured' }) };
    }

    // Generate a signature over a fixed, server-controlled parameter set. The
    // client cannot replace the folder, public ID, ownership context, or add
    // arbitrary signed transformations/tags.
    const timestamp = Math.round(new Date().getTime() / 1000);
    const uploadId = crypto.randomUUID().replace(/-/g, '');
    const expectedPublicId = `${requestedFolder}/${uploadId}`;
    const context = `egatepass_owner=${actor.uid}|egatepass_upload=${uploadId}`;
    const paramsToSign = {
      timestamp,
      folder: requestedFolder,
      public_id: uploadId,
      context,
    };

    const signature = cloudinary.utils.api_sign_request(
      paramsToSign,
      process.env.CLOUDINARY_API_SECRET
    );

    await getFirestore().collection('imageUploads').doc(uploadId).create({
      ownerUid: actor.uid,
      actorType: actor.type,
      folder: requestedFolder,
      publicId: expectedPublicId,
      deliveryType: SECURE_IMAGE_DELIVERY_TYPE,
      status: 'pending',
      createdAt: FieldValue.serverTimestamp(),
      expiresAt: Timestamp.fromMillis(Date.now() + 24 * 60 * 60 * 1000),
    });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        timestamp,
        signature,
        apiKey: process.env.CLOUDINARY_API_KEY,
        cloudName: process.env.CLOUDINARY_CLOUD_NAME,
        uploadId,
        uploadPublicId: uploadId,
        expectedPublicId,
        context,
        deliveryType: SECURE_IMAGE_DELIVERY_TYPE,
      }),
    };
  } catch (error: unknown) {
    if (error instanceof RateLimitError) {
      return {
        statusCode: 429,
        headers: { 'Content-Type': 'application/json', 'Retry-After': String(error.retryAfterSeconds) },
        body: JSON.stringify({ error: error.message, retryAfterSeconds: error.retryAfterSeconds }),
      };
    }
    console.error('Cloudinary Sign Error:', error);
    return handleAuthError(error);
  }
};
