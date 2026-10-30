/** Compresses a browser-selected image or camera blob to WebP without loading a storage SDK. */
export async function compressImageToWebP(file: Blob | File): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (event) => {
      const image = new Image();
      image.onload = () => {
        const maxSize = 1024;
        const scale = Math.min(1, maxSize / Math.max(image.width, image.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(image.width * scale);
        canvas.height = Math.round(image.height * scale);
        const context = canvas.getContext('2d');
        if (!context) return reject(new Error('Failed to prepare the image.'));
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        canvas.toBlob(
          (blob) => blob ? resolve(blob) : reject(new Error('Failed to encode the image.')),
          'image/webp',
          0.8,
        );
      };
      image.onerror = () => reject(new Error('The selected file is not a readable image.'));
      image.src = event.target?.result as string;
    };
    reader.onerror = () => reject(new Error('Failed to read the selected file.'));
    reader.readAsDataURL(file);
  });
}

/**
 * Normalizes an identity document image for biometric face processing and evidence retention.
 * Preserves high resolution (long edge up to 2000px, max 2400px, quality 0.92) without upscaling.
 */
export async function normalizeIdentityDocumentImage(file: Blob | File): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (event) => {
      const image = new Image();
      image.onload = () => {
        const targetLongEdge = 2000;
        const maxDimension = Math.max(image.width, image.height);
        const scale = maxDimension > targetLongEdge ? targetLongEdge / maxDimension : 1;
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(image.width * scale);
        canvas.height = Math.round(image.height * scale);
        const context = canvas.getContext('2d');
        if (!context) return reject(new Error('Failed to prepare document image.'));
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        canvas.toBlob(
          (blob) => blob ? resolve(blob) : reject(new Error('Failed to encode document image.')),
          'image/webp',
          0.92,
        );
      };
      image.onerror = () => reject(new Error('The selected file is not a readable image.'));
      image.src = event.target?.result as string;
    };
    reader.onerror = () => reject(new Error('Failed to read the selected file.'));
    reader.readAsDataURL(file);
  });
}

/**
 * Normalizes a declared vehicle photo for guard station visual inspection.
 * Preserves clear resolution (long edge up to 1800px, quality 0.88 WebP) without upscaling.
 */
export async function normalizeVehicleImage(file: Blob | File): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (event) => {
      const image = new Image();
      image.onload = () => {
        const targetLongEdge = 1800;
        const maxDimension = Math.max(image.width, image.height);
        const scale = maxDimension > targetLongEdge ? targetLongEdge / maxDimension : 1;
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(image.width * scale);
        canvas.height = Math.round(image.height * scale);
        const context = canvas.getContext('2d');
        if (!context) return reject(new Error('Failed to prepare vehicle image.'));
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        canvas.toBlob(
          (blob) => (blob ? resolve(blob) : reject(new Error('Failed to encode vehicle image.'))),
          'image/webp',
          0.88,
        );
      };
      image.onerror = () => reject(new Error('The selected vehicle file is not a readable image.'));
      image.src = event.target?.result as string;
    };
    reader.onerror = () => reject(new Error('Failed to read the selected vehicle file.'));
    reader.readAsDataURL(file);
  });
}


