/*
 * Copyright (c) 2026 Atum Labs, Inc.
 * SPDX-License-Identifier: MIT
 */

// Re-attempting a purchase until it reaches a terminal outcome.
//
// Cross-chain settlement can take longer than the Atum gateway holds a connection open
// (~30s). Rather than the merchant hanging on — which is what runs into proxy and load
// balancer timeouts — verify() reports the payment as still settling, and the payer's
// re-attempt is what collects the result. The same purchase identifier derives the same
// `request_id`, so the gateway resolves the re-attempt onto the same payment and replays
// its receipt once it has one. Re-attempting costs nothing and cannot charge twice.
//
// What that means for timing:
//
//   attempt 1   creates the payment; the gateway holds the connection up to ~30s waiting
//               for settlement, then reports it as still settling
//   attempt 2+  resolves onto the same payment and returns IMMEDIATELY with its current
//               state — so the interval below, not the request, paces the wait
//
// Each attempt fetches a fresh 402 and signs a new credential. That is required, not
// wasteful: `quote_deadline` and `fulfillment_deadline` are absolute timestamps fixed when
// the challenge was built, so a credential goes stale within seconds and verify() refuses
// it (on Solana its on-chain replay window expires too). Re-signing is cheap with a local
// key but a round trip to a remote signer (KMS, Turnkey), so keep the interval in that
// ballpark rather than treating this like a lightweight status poll.

/**
 * The problem-details type mppx uses for a payment that needs another attempt. It covers
 * two causes: the payment is still settling (`paymentId` present — it reached the
 * gateway), or this attempt's authorization went stale before it could be submitted
 * (`paymentId` absent — nothing reached the gateway). Both are resolved by re-attempting.
 */
const PAYMENT_ACTION_REQUIRED = "https://paymentauth.org/problems/payment-action-required";

// ~30s for the first attempt, then 19 fast attempts 5s apart: a little over two minutes of
// patience, which covers the merchant's default 120s fulfillment deadline.
const DEFAULT_MAX_ATTEMPTS = 20;
const DEFAULT_INTERVAL_MS = 5000;

/** RFC 9457 problem details, plus the payment id mppx-atum-escrow adds to settlement errors. */
interface PaymentProblem {
  type?: string;
  detail?: string;
  paymentId?: string;
}

export interface PurchaseOptions {
  /** Total attempts, including the first. Default: 20. */
  maxAttempts?: number;
  /** Delay between attempts, in milliseconds. Default: 5000. */
  intervalMs?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Drive one purchase to a terminal outcome, re-attempting while it is still settling.
 *
 * @param attempt - makes one attempt at the purchase: fetch the 402, sign a credential for
 *   it, and resubmit. The purchase identifier comes from the URL, so every attempt names
 *   the same payment.
 * @returns the response that settled, or a non-402 response the merchant answered with
 * @throws if the payment failed terminally, was refused, or never settled in time
 */
export async function payPurchase(
  attempt: () => Promise<Response>,
  options: PurchaseOptions = {},
): Promise<Response> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const startedAt = Date.now();
  const elapsed = () => `${Math.round((Date.now() - startedAt) / 1000)}s`;
  let paymentId: string | undefined;

  for (let i = 1; i <= maxAttempts; i++) {
    console.log(`  attempt ${i}/${maxAttempts} …`);
    const response = await attempt();

    if (response.ok) {
      console.log(`  settled after ${i} attempt(s) in ${elapsed()}`);
      return response;
    }

    // Anything that is not a 402 is not a payment outcome — an unpaid resource, a bad
    // request, a merchant error. Hand it back rather than retrying blindly.
    if (response.status !== 402) return response;

    const problem = (await response.json().catch(() => ({}))) as PaymentProblem;
    if (problem.type !== PAYMENT_ACTION_REQUIRED) {
      throw new Error(
        `payment ${problem.paymentId ?? "(unidentified)"} did not settle, and re-attempting ` +
          `cannot recover it. A terminal failure keeps its identifier, so that purchase id now ` +
          `resolves to the failed payment for good — the goods can still be bought, but under a ` +
          `NEW purchase id. Cause: ${problem.detail ?? "the merchant answered 402 with no problem details"}`,
      );
    }

    paymentId = problem.paymentId ?? paymentId;
    if (i === maxAttempts) break;
    console.log(
      `  ${paymentId ? `still settling (payment ${paymentId})` : "authorization went stale before submission"}` +
        ` — ${elapsed()} elapsed, re-attempting in ${Math.round(intervalMs / 1000)}s`,
    );
    await sleep(intervalMs);
  }

  throw new Error(
    `payment ${paymentId ?? "(unidentified)"} was still settling after ${maxAttempts} attempts ` +
      `(${elapsed()}). It is not lost: re-run this purchase under the same identifier to collect ` +
      `its outcome.`,
  );
}
