/*
 * Copyright (c) 2026 Atum Labs, Inc. All rights reserved.
 * Proprietary reference implementation; not open source.
 * Access and use are governed by the LICENSE file at the root of this repository.
 * Do not remove, alter, or obscure this notice.
 */

// Retry policy for a signed payment request. The Atum Payment Gateway is idempotent
// on identical bytes: if a request fails or times out *after* the deposit already
// settled (e.g. the merchant restarted mid-settlement), resending the exact same
// signed credential returns the original result instead of charging a second time.
// The caller's `send` must therefore resend the identical request every time — never
// build a new one for a retry, or a "retry" becomes a second, distinct payment. See
// the mppx-atum-escrow SDK's "Retries and idempotency" docs.

export interface RetryOptions {
  /** Total attempts, including the first (not just retries). Default: 3. */
  maxAttempts?: number;
  /** Fixed delay between attempts, in milliseconds. Default: 2000. */
  retryDelayMs?: number;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 2000;

function isRetryable(res: Response): boolean {
  return res.status >= 500;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Calls `send()` up to `maxAttempts` times, retrying only on a 5xx response or a
 * thrown network error, with a fixed delay between attempts. Returns the first
 * non-retryable response, or the final response/error once attempts are exhausted.
 */
export async function sendWithRetries(
  send: () => Promise<Response>,
  options: RetryOptions = {},
): Promise<Response> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  if (maxAttempts < 1) {
    throw new Error(`maxAttempts must be at least 1, got ${maxAttempts}`);
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const isLastAttempt = attempt === maxAttempts;
    try {
      const res = await send();
      if (!isRetryable(res) || isLastAttempt) return res;
      console.log(
        `Settlement attempt ${attempt}/${maxAttempts} returned ${res.status}; retrying with the identical credential …`,
      );
    } catch (err) {
      if (isLastAttempt) throw err;
      console.log(
        `Settlement attempt ${attempt}/${maxAttempts} failed (${(err as Error).message}); retrying with the identical credential …`,
      );
    }
    await sleep(retryDelayMs);
  }
  throw new Error("unreachable");
}
