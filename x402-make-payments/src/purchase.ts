/*
 * Copyright (c) 2026 Atum Labs, Inc. All rights reserved.
 * Proprietary reference implementation; not open source.
 * Access and use are governed by the LICENSE file at the root of this repository.
 * Do not remove, alter, or obscure this notice.
 */

// Re-attempting a purchase until it reaches a terminal outcome.
//
// Cross-chain settlement can take longer than the Atum gateway holds a connection open
// (~30s). Rather than hanging on — which is what runs into proxy and load-balancer
// timeouts — the facilitator answers `settlement_pending` with the payment id, and the
// payer's re-attempt is what collects the result. The same purchase identifier derives
// the same `request_id`, so the gateway resolves the re-attempt onto the same payment and
// replays its receipt once it has one. Re-attempting costs nothing and cannot charge
// twice.
//
// What that means for timing:
//
//   attempt 1   creates the payment; the gateway holds the connection up to ~30s waiting
//               for settlement, then answers `settlement_pending`
//   attempt 2+  resolves onto the same payment and returns IMMEDIATELY with its current
//               state — so the interval below, not the request, paces the wait
//
// Each attempt is a full, independent purchase attempt: a fresh 402, a rebuilt and
// re-signed payment. Only the identifier survives between them, which is exactly what
// makes them one payment rather than several. Re-signing is cheap with a local key but a
// round trip to a remote signer (KMS, Turnkey), so keep the interval in that ballpark
// rather than treating this like a lightweight status poll.
//
// A pending response also carries a `statusUrl` for out-of-band reconciliation
// (dashboards, a ledger job). Nothing here polls it: the re-attempt is the mechanism.

/** The facilitator accepted the payment; it is still settling. Re-attempt. */
const SETTLEMENT_PENDING = "settlement_pending";
/** The payment reached a terminal failure. Re-attempting the same purchase cannot help. */
const SETTLEMENT_FAILED = "settlement_failed";

// ~30s for the first attempt, then 19 fast attempts 5s apart: a little over two minutes
// of patience, which covers the merchant's default 120s fulfillment deadline.
const DEFAULT_MAX_ATTEMPTS = 20;
const DEFAULT_INTERVAL_MS = 5000;

/** The settlement report an attempt carries on its `PAYMENT-RESPONSE` header. */
interface SettleResponse {
  success?: boolean;
  errorReason?: string;
  errorMessage?: string;
  transaction?: string;
  extensions?: { atum?: { paymentId?: string; state?: string; statusUrl?: string } };
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

/** Decode the settlement report, or `undefined` when the attempt presented no payment. */
function settleResponseOf(response: Response): SettleResponse | undefined {
  const header = response.headers.get("payment-response");
  if (!header) return undefined;
  return JSON.parse(Buffer.from(header, "base64").toString("utf8")) as SettleResponse;
}

/**
 * Drive one purchase to a terminal outcome, re-attempting while it is still settling.
 *
 * @param attempt - makes one attempt at the purchase, under a fixed purchase identifier
 * @returns the response that settled, or the response that presented no payment at all
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
    const settle = settleResponseOf(response);

    // No PAYMENT-RESPONSE means no payment was presented — the client declined to build
    // one, so nothing was charged. Retrying cannot change that; let the caller report it.
    if (!settle) return response;

    paymentId = settle.extensions?.atum?.paymentId ?? paymentId;

    if (settle.success) {
      console.log(`  settled after ${i} attempt(s) in ${elapsed()} — payment ${paymentId}`);
      return response;
    }

    if (settle.errorReason !== SETTLEMENT_PENDING) {
      throw new Error(
        settle.errorReason === SETTLEMENT_FAILED
          ? `payment ${paymentId} failed and nothing was delivered. That identifier now resolves ` +
            `to this failed payment for good, so re-attempting under it cannot recover — but the ` +
            `goods can still be bought: start another payment under a NEW identifier (re-running ` +
            `without PURCHASE_ID generates one)` +
            (settle.errorMessage ? `. Cause: ${settle.errorMessage}` : "")
          : `the payment was refused and nothing was charged, so this identifier is still usable ` +
            `once the cause is fixed: ${settle.errorReason ?? "(no reason given)"}` +
            (settle.errorMessage ? ` — ${settle.errorMessage}` : ""),
      );
    }

    if (i === maxAttempts) break;
    console.log(
      `  still settling (payment ${paymentId}) — ${elapsed()} elapsed, ` +
        `re-attempting in ${Math.round(intervalMs / 1000)}s`,
    );
    await sleep(intervalMs);
  }

  throw new Error(
    `payment ${paymentId} was still settling after ${maxAttempts} attempts (${elapsed()}). It is ` +
      `not lost: re-run this purchase under the same identifier to collect its outcome.`,
  );
}
