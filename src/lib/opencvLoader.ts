/**
 * src/lib/opencvLoader.ts
 *
 * Asynchronously loads pre-compiled OpenCV.js on-demand.
 * In a browser environment, loads /vendor/opencv.js dynamically via script tag,
 * avoiding bundling 10.3 MB of pre-compiled Emscripten asm.js/WASM into Rollup chunks.
 * In Node.js / SSR / testing environments, resolves to the installed @techstark/opencv-js package.
 */

let cvPromise: Promise<any> | null = null;

export async function loadOpenCv(): Promise<any> {
  if (cvPromise) {
    return cvPromise;
  }

  cvPromise = (async () => {
    // 1. If already initialized on window (e.g. previous load or preloaded)
    if (typeof window !== 'undefined' && (window as any).cv && (window as any).cv.Mat) {
      return (window as any).cv;
    }

    // 2. Browser dynamic script injection for genuine zero-bundle on-demand loading
    if (typeof window !== 'undefined' && typeof document !== 'undefined') {
      return new Promise((resolve, reject) => {
        // If window.cv exists but is pending initialization
        if ((window as any).cv && typeof (window as any).cv.then === 'function') {
          (window as any).cv.then(resolve).catch(reject);
          return;
        }

        const existingScript = document.querySelector('script[src="/vendor/opencv.js"]');
        if (existingScript) {
          const checkReady = () => {
            const cv = (window as any).cv;
            if (cv && cv.Mat) {
              resolve(cv);
            } else if (cv && typeof cv.then === 'function') {
              cv.then(resolve).catch(reject);
            } else {
              setTimeout(checkReady, 50);
            }
          };
          checkReady();
          return;
        }

        const script = document.createElement('script');
        script.src = '/vendor/opencv.js';
        script.async = true;

        script.onload = () => {
          const checkReady = () => {
            const cv = (window as any).cv;
            if (cv && cv.Mat) {
              resolve(cv);
            } else if (cv && typeof cv.then === 'function') {
              cv.then(resolve).catch(reject);
            } else if (cv && typeof cv.onRuntimeInitialized !== 'undefined') {
              cv.onRuntimeInitialized = () => resolve(cv);
            } else {
              setTimeout(checkReady, 50);
            }
          };
          checkReady();
        };

        script.onerror = (err) => {
          reject(new Error(`Failed to load OpenCV from /vendor/opencv.js: ${err}`));
        };

        document.head.appendChild(script);
      });
    }

    // 3. Node / Vitest testing environment: dynamically require from node_modules
    try {
      if (typeof window === 'undefined') {
        const cvPath = '@techstark/opencv-js/dist/opencv.js';
        const cvModule = await import(/* @vite-ignore */ cvPath);
        const resolved = (cvModule as any).default || cvModule;
        if (resolved && typeof resolved.then === 'function') {
          return await resolved;
        }
        return resolved;
      }
      return {};
    } catch {
      return {};
    }
  })();

  return cvPromise;
}

export default loadOpenCv();
