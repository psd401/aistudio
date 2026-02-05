// Error capture utility for debugging
// This captures console errors and stores them for bug reports

interface WindowWithErrors extends Window {
  __capturedErrors?: string[];
  __errorCaptureInitialized?: boolean;
  __originalConsoleError?: typeof console.error;
  __errorListener?: (event: ErrorEvent) => void;
  __rejectionListener?: (event: PromiseRejectionEvent) => void;
}

export function initializeErrorCapture() {
  if (typeof window === 'undefined') return;

  const win = window as unknown as WindowWithErrors;

  // Check if already initialized (idempotency for React Strict Mode)
  if (win.__errorCaptureInitialized) {
    return;
  }

  // Initialize error storage
  win.__capturedErrors = [];
  const maxErrors = 50; // Keep last 50 errors

  // Store original console.error ONCE on window to avoid module-level state
  // eslint-disable-next-line no-console
  win.__originalConsoleError = console.error;

  // Override console.error to capture errors
  // eslint-disable-next-line no-console
  console.error = function(...args) {
    const self = window as unknown as WindowWithErrors;

    // Call original console.error
    self.__originalConsoleError?.apply(console, args);

    // Store error with timestamp
    const errorString = args.map(arg => {
      if (arg instanceof Error) {
        return `${arg.message} (${arg.stack?.split('\n')[1]?.trim() || 'no stack'})`;
      }
      if (typeof arg === 'object') {
        try {
          return JSON.stringify(arg);
        } catch {
          return String(arg);
        }
      }
      return String(arg);
    }).join(' ');

    const timestamp = new Date().toISOString();
    const errorEntry = `[${timestamp}] ${errorString}`;

    // Add to captured errors
    const errors = self.__capturedErrors || [];
    errors.push(errorEntry);
    self.__capturedErrors = errors;

    // Keep only last N errors
    if (errors.length > maxErrors) {
      errors.shift();
    }
  };

  // Capture unhandled promise rejections
  win.__rejectionListener = (event: PromiseRejectionEvent) => {
    const timestamp = new Date().toISOString();
    const errorEntry = `[${timestamp}] Unhandled Promise Rejection: ${event.reason}`;

    const w = window as unknown as WindowWithErrors;
    const errors = w.__capturedErrors || [];
    errors.push(errorEntry);
    w.__capturedErrors = errors;

    if (errors.length > maxErrors) {
      errors.shift();
    }
  };

  // Capture window errors
  win.__errorListener = (event: ErrorEvent) => {
    const timestamp = new Date().toISOString();
    const errorEntry = `[${timestamp}] ${event.message} at ${event.filename}:${event.lineno}:${event.colno}`;

    const w = window as unknown as WindowWithErrors;
    const errors = w.__capturedErrors || [];
    errors.push(errorEntry);
    w.__capturedErrors = errors;

    if (errors.length > maxErrors) {
      errors.shift();
    }
  };

  window.addEventListener('unhandledrejection', win.__rejectionListener);
  window.addEventListener('error', win.__errorListener);

  // Mark as initialized
  win.__errorCaptureInitialized = true;
}

export function cleanupErrorCapture() {
  if (typeof window === 'undefined') return;

  const win = window as unknown as WindowWithErrors;

  if (!win.__errorCaptureInitialized) {
    return;
  }

  // Restore original console.error
  if (win.__originalConsoleError) {
    // eslint-disable-next-line no-console
    console.error = win.__originalConsoleError;
    delete win.__originalConsoleError;
  }

  // Remove event listeners
  if (win.__errorListener) {
    window.removeEventListener('error', win.__errorListener);
    delete win.__errorListener;
  }

  if (win.__rejectionListener) {
    window.removeEventListener('unhandledrejection', win.__rejectionListener);
    delete win.__rejectionListener;
  }

  // Mark as uninitialized
  win.__errorCaptureInitialized = false;
}