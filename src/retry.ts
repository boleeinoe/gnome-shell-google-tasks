// Retry policy for Google Tasks requests. No GNOME imports, so it runs under
// `bun test`; the GLib-specific error classification lives in tasksManager.ts
// and is passed in as `shouldRetry`.

// A non-2xx HTTP response. Carries the status so the retry policy and the
// callers can tell "gone" (404) from "try later" (503) from "bad request".
export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

// Statuses worth another attempt for an idempotent request (GET, PATCH,
// DELETE): timeouts, rate limiting and server-side hiccups. Anything else
// (400, 403, 404...) fails the same way every time.
export const RETRYABLE_HTTP_STATUSES: ReadonlySet<number> = new Set([408, 429, 500, 502, 503, 504]);

// Statuses that mean the server did not act on the request, so even a
// non-idempotent one (POST) can be sent again without creating a duplicate.
export const NOT_PROCESSED_HTTP_STATUSES: ReadonlySet<number> = new Set([429, 503]);

export interface RetryOptions {
  // Extra attempts after the first one.
  retries?: number;
  // Backoff: attempt n waits baseDelayMs * n before running.
  baseDelayMs?: number;
  // Whether this error is worth another attempt.
  shouldRetry: (error: unknown) => boolean;
  // Stops retrying once the owner is going away (extension disabled).
  isCancelled?: () => boolean;
  delay?: (ms: number) => Promise<void>;
}

function defaultDelay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Runs fn, retrying with linear backoff while the error is retryable and the
// owner hasn't been cancelled. Rethrows the last error.
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions): Promise<T> {
  const retries = options.retries ?? 2;
  const baseDelayMs = options.baseDelayMs ?? 200;
  const delay = options.delay ?? defaultDelay;

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    }
    catch (e) {
      lastError = e;
      if (attempt >= retries || !options.shouldRetry(e) || options.isCancelled?.())
        break;
      await delay(baseDelayMs * (attempt + 1));
      if (options.isCancelled?.())
        break;
    }
  }
  throw lastError;
}
