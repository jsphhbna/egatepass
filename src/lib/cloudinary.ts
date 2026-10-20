import { auth } from '@/lib/firebase';

interface SignatureResponse {
  timestamp: number;
  signature: string;
  apiKey: string;
  cloudName: string;
  uploadPublicId: string;
  expectedPublicId: string;
  context: string;
  deliveryType: 'authenticated';
}

type UploadFolder = 'e-gatepass/photos' | 'e-gatepass/ids';

/**
 * Compresses an image to WebP format using an off-screen canvas.
 * Max dimension: 1024px. Quality: 0.8
 */
export async function compressImageToWebP(file: File): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        // Calculate new dimensions (max 1024)
        const MAX_SIZE = 1024;
        let width = img.width;
        let height = img.height;

        if (width > height) {
          if (width > MAX_SIZE) {
            height = Math.round((height *= MAX_SIZE / width));
            width = MAX_SIZE;
          }
        } else {
          if (height > MAX_SIZE) {
            width = Math.round((width *= MAX_SIZE / height));
            height = MAX_SIZE;
          }
        }

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;

        const ctx = canvas.getContext('2d');
        if (!ctx) {
          reject(new Error('Failed to get canvas context'));
          return;
        }

        ctx.drawImage(img, 0, 0, width, height);
        
        canvas.toBlob(
          (blob) => {
            if (blob) {
              resolve(blob);
            } else {
              reject(new Error('Canvas to Blob failed'));
            }
          },
          'image/webp',
          0.8
        );
      };
      img.onerror = () => reject(new Error('Image load error'));
      img.src = e.target?.result as string;
    };
    reader.onerror = () => reject(new Error('File read error'));
    reader.readAsDataURL(file);
  });
}

/**
 * Uploads a file directly to Cloudinary using a signed request from our Netlify Function.
 */
export async function uploadToCloudinary(fileOrBlob: File | Blob, folder: UploadFolder): Promise<string> {
  const user = auth.currentUser;
  if (!user) {
    throw new Error('Must be authenticated to upload images');
  }

  const token = await user.getIdToken();

  // 1. Get signature from our secure backend
  const signRes = await fetch('/api/cloudinary-sign', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ folder }),
  });

  if (!signRes.ok) {
    console.error('Cloudinary sign failed. Status:', signRes.status);
    throw new Error('Image upload could not be authorized');
  }

  const { timestamp, signature, apiKey, cloudName, uploadPublicId, expectedPublicId, context, deliveryType }: SignatureResponse = await signRes.json();

  // 2. Upload directly to Cloudinary
  const formData = new FormData();
  formData.append('file', fileOrBlob);
  formData.append('api_key', apiKey);
  formData.append('timestamp', timestamp.toString());
  formData.append('signature', signature);
  formData.append('folder', folder);
  formData.append('public_id', uploadPublicId);
  formData.append('context', context);

  if (deliveryType !== 'authenticated') throw new Error('Image upload did not receive a secure delivery policy');
  const uploadRes = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/image/${deliveryType}`, {
    method: 'POST',
    body: formData,
  });

  if (!uploadRes.ok) {
    const errorData = await uploadRes.json().catch(() => null);
    console.error('Cloudinary upload error:', errorData);
    throw new Error('Failed to upload image to Cloudinary');
  }

  const data = await uploadRes.json() as { public_id?: unknown };
  if (data.public_id !== expectedPublicId) throw new Error('Image upload returned an unexpected identifier');
  return expectedPublicId;
}

export async function cleanupUploadedImages(publicIds: string[]): Promise<void> {
  if (publicIds.length === 0) return;
  const user = auth.currentUser;
  if (!user) return;
  try {
    const token = await user.getIdToken();
    const response = await fetch('/api/cleanup-upload', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ publicIds: [...new Set(publicIds)].slice(0, 2) }),
    });
    if (!response.ok && response.status !== 409) {
      console.error('Pending image cleanup was not accepted. Status:', response.status);
    }
  } catch (error) {
    console.error('Pending image cleanup request failed', error);
  }
}
