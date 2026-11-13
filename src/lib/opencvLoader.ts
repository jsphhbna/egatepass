/**
 * src/lib/opencvLoader.ts
 *
 * Asynchronously loads pre-compiled OpenCV.js on-demand.
 * In a browser environment, loads /vendor/opencv.js dynamically via script tag,
 * avoiding bundling 10.3 MB of pre-compiled Emscripten asm.js/WASM into Rollup chunks.
 * In Node.js / SSR / testing environments, resolves to the installed @techstark/opencv-js package.
 */

let cvPromise: Promise<any> | null = null;
const OPENCV_INIT_TIMEOUT_MS = 15000;

export async function loadOpenCv(): Promise<any> {
  if (cvPromise) {
    return cvPromise;
  }

  const promise = (async () => {
    // 1. If already initialized on window (e.g. previous load or preloaded)
    if (typeof window !== 'undefined' && (window as any).cv && (window as any).cv.Mat) {
      return (window as any).cv;
    }

    // 2. Browser dynamic script injection for genuine zero-bundle on-demand loading
    if (typeof window !== 'undefined' && typeof document !== 'undefined') {
      return new Promise((resolve, reject) => {
        const startTime = Date.now();
        let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
        let pollTimer: ReturnType<typeof setTimeout> | null = null;

        const cleanup = () => {
          if (timeoutTimer) clearTimeout(timeoutTimer);
          if (pollTimer) clearTimeout(pollTimer);
        };

        timeoutTimer = setTimeout(() => {
          cleanup();
          reject(new Error(`OpenCV initialization timed out after ${OPENCV_INIT_TIMEOUT_MS}ms`));
        }, OPENCV_INIT_TIMEOUT_MS);

        // If window.cv exists but is pending initialization
        if ((window as any).cv && typeof (window as any).cv.then === 'function') {
          (window as any).cv
            .then((cv: any) => {
              cleanup();
              resolve(cv);
            })
            .catch((err: any) => {
              cleanup();
              reject(err);
            });
          return;
        }

        const checkReady = () => {
          if (Date.now() - startTime > OPENCV_INIT_TIMEOUT_MS) {
            cleanup();
            reject(new Error(`OpenCV readiness polling timed out after ${OPENCV_INIT_TIMEOUT_MS}ms`));
            return;
          }
          const cv = (window as any).cv;
          if (cv && cv.Mat) {
            cleanup();
            resolve(cv);
          } else if (cv && typeof cv.then === 'function') {
            cv.then((c: any) => {
              cleanup();
              resolve(c);
            }).catch((e: any) => {
              cleanup();
              reject(e);
            });
          } else {
            pollTimer = setTimeout(checkReady, 50);
          }
        };

        const existingScript = document.querySelector('script[src="/vendor/opencv.js"]');
        if (existingScript) {
          checkReady();
          return;
        }

        const script = document.createElement('script');
        script.src = '/vendor/opencv.js';
        script.async = true;

        script.onload = () => {
          const cv = (window as any).cv;
          if (cv && typeof cv.onRuntimeInitialized !== 'undefined') {
            const originalOnRuntimeInit = cv.onRuntimeInitialized;
            cv.onRuntimeInitialized = () => {
              if (typeof originalOnRuntimeInit === 'function') originalOnRuntimeInit();
              cleanup();
              resolve(cv);
            };
          }
          checkReady();
        };

        script.onerror = (err) => {
          cleanup();
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

  cvPromise = promise.catch((err) => {
    cvPromise = null; // Clear cached promise on failure so retries can occur
    throw err;
  });

  return cvPromise;
}

const lazyOpenCv = {
  then<TResult1 = any, TResult2 = never>(
    onfulfilled?: ((value: any) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return loadOpenCv().then(onfulfilled, onrejected);
  },
  catch<TResult = never>(
    onrejected?: ((reason: any) => TResult | PromiseLike<TResult>) | null,
  ): Promise<any | TResult> {
    return loadOpenCv().catch(onrejected);
  },
};

export default lazyOpenCv;
