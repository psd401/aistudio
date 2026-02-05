// Error capture utility for debugging
// This captures console errors and stores them for bug reports

interface WindowWithErrors extends Window {
  __capturedErrors?: string[];
  __errorCaptureInitialized?: boolean;
}

let originalConsoleError: typeof console.error | null = null;
let errorListener: ((event: ErrorEvent) => void) | null = null;
let rejectionListener: ((event: PromiseRejectionEvent) => void) | null = null;

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

  // Store original console.error ONCE
  // eslint-disable-next-line no-console
  originalConsoleError = console.error;

  // Override console.error to capture errors
  // eslint-disable-next-line no-console
  console.error = function(...args) {
    // Call original console.error
    originalConsoleError?.apply(console, args);
    
    // Store error with timestamp
    const errorString = args.map(arg => {
      if (arg instanceof Error) {
        return `${arg.message} (${arg.stack?.split('\n')[1]?.trim() || 'no stack'})`
      }
      if (typeof arg === 'object') {
        try {
          return JSON.stringify(arg)
        } catch {
          return String(arg)
        }
      }
      return String(arg)
    }).join(' ')
    
    const timestamp = new Date().toISOString()
    const errorEntry = `[${timestamp}] ${errorString}`
    
    // Add to captured errors
    const win = window as unknown as WindowWithErrors
    const errors = win.__capturedErrors || []
    errors.push(errorEntry)
    win.__capturedErrors = errors
    
    // Keep only last N errors
    if (errors.length > maxErrors) {
      errors.shift()
    }
  }

  // Capture unhandled promise rejections
  rejectionListener = (event: PromiseRejectionEvent) => {
    const timestamp = new Date().toISOString();
    const errorEntry = `[${timestamp}] Unhandled Promise Rejection: ${event.reason}`;

    const win = window as unknown as WindowWithErrors;
    const errors = win.__capturedErrors || [];
    errors.push(errorEntry);
    win.__capturedErrors = errors;

    if (errors.length > maxErrors) {
      errors.shift();
    }
  };

  // Capture window errors
  errorListener = (event: ErrorEvent) => {
    const timestamp = new Date().toISOString();
    const errorEntry = `[${timestamp}] ${event.message} at ${event.filename}:${event.lineno}:${event.colno}`;

    const win = window as unknown as WindowWithErrors;
    const errors = win.__capturedErrors || [];
    errors.push(errorEntry);
    win.__capturedErrors = errors;

    if (errors.length > maxErrors) {
      errors.shift();
    }
  };

  window.addEventListener('unhandledrejection', rejectionListener);
  window.addEventListener('error', errorListener);

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
  if (originalConsoleError) {
    // eslint-disable-next-line no-console
    console.error = originalConsoleError;
    originalConsoleError = null;
  }

  // Remove event listeners
  if (errorListener) {
    window.removeEventListener('error', errorListener);
    errorListener = null;
  }

  if (rejectionListener) {
    window.removeEventListener('unhandledrejection', rejectionListener);
    rejectionListener = null;
  }

  // Mark as uninitialized
  win.__errorCaptureInitialized = false;
}