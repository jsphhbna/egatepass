import type { Handler } from '@netlify/functions';
import { getFirestore } from 'firebase-admin/firestore';
import { v2 as cloudinary } from 'cloudinary';
import { handleAuthError, requireGuardOrAdmin } from './utils/auth';
import { authorizeReferencedImage, ImageAccessError } from './utils/image-security';

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true,
});

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

function jsonResponse(statusCode: number, body: object) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'GET') return jsonResponse(405, { error: 'Method not allowed' });

  try {
    const actor = await requireGuardOrAdmin(event.headers.authorization || event.headers.Authorization);
    const publicId = event.queryStringParameters?.publicId;
    const reference = await authorizeReferencedImage(getFirestore(), actor, publicId);
    if (reference.visitorReferences.some((item) => item.data().imagesPurgedAt != null)) {
      return jsonResponse(410, { error: 'Image expired', code: 'image_expired' });
    }

    if (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_SECRET) {
      console.error('Image proxy is missing required Cloudinary configuration');
      return jsonResponse(500, { error: 'Image access is not configured' });
    }

    const imageUrl = cloudinary.url(publicId as string, {
      secure: true,
      sign_url: true,
      type: reference.deliveryType,
    });
    let imageResponse = await fetch(imageUrl);
    // A legacy asset may already have been converted before its Firestore
    // delivery metadata was finalized. Try the protected namespace only; never
    // fall back from authenticated metadata to public delivery.
    if (!imageResponse.ok && reference.deliveryType === 'upload') {
      const migratedUrl = cloudinary.url(publicId as string, {
        secure: true,
        sign_url: true,
        type: 'authenticated',
      });
      imageResponse = await fetch(migratedUrl);
    }
    if (!imageResponse.ok) return jsonResponse(404, { error: 'Image not found' });

    const contentType = imageResponse.headers.get('Content-Type') || '';
    const contentLength = Number(imageResponse.headers.get('Content-Length') || 0);
    if (!contentType.toLocaleLowerCase().startsWith('image/')) {
      console.error('Image proxy rejected a non-image upstream response', { actorUid: actor.uid });
      return jsonResponse(404, { error: 'Image not found' });
    }
    if (contentLength > MAX_IMAGE_BYTES) return jsonResponse(413, { error: 'Image is too large' });

    const imageBuffer = await imageResponse.arrayBuffer();
    if (imageBuffer.byteLength > MAX_IMAGE_BYTES) return jsonResponse(413, { error: 'Image is too large' });
    return {
      statusCode: 200,
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'private, max-age=300',
        'X-Content-Type-Options': 'nosniff',
      },
      body: Buffer.from(imageBuffer).toString('base64'),
      isBase64Encoded: true,
    };
  } catch (error) {
    if (error instanceof ImageAccessError) return jsonResponse(error.statusCode, { error: error.message });
    console.error('Image proxy request failed', { error: error instanceof Error ? error.message : 'Unknown error' });
    return handleAuthError(error);
  }
};
