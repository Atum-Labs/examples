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
 * three kinds of answer: the payment is still settling (`paymentId` present — it reached
 * the gateway), the gateway could not take it this time (`code` present — nothing was
 * charged), or neither — this attempt's authorization went stale before it could be
 * submitted, or the merchant could not learn the submission's outcome. All are resolved by
 * re-attempting the same purchase, which never charges twice.
 */
const PAYMENT_ACTION_REQUIRED = "https://paymentauth.org/problems/payment-action-required";

// ~30s for the first attempt, then 19 fast attempts 5s apart: a little over two minutes of
// patience, which covers the merchant's default 120s fulfillment deadline.
const DEFAULT_MAX_ATTEMPTS = 20;
const DEFAULT_INTERVAL_MS = 5000;

/**
 * RFC 9457 problem details, plus what mppx-atum-escrow adds: the payment id and the gateway's
 * state on a payment still settling, and the gateway's code on a refusal worth re-attempting.
 */
interface PaymentProblem {
  type?: string;
  detail?: string;
  paymentId?: string;
  state?: string;
  code?: string;
}

/** Why this attempt is re-attempted, read from the answer the attempt got. */
function reattemptReason(problem: PaymentProblem, paymentId: string | undefined): string {
  if (typeof problem.code === "string") {
    return `the gateway could not take the payment (${problem.code}); nothing was charged`;
  }
  if (problem.state === "refund_available" || problem.state === "refunding") {
    // Not final: a late delivery can still complete it, so this payer must not pay for the
    // same goods under a new purchase id while it waits.
    return `payment ${paymentId} ${problem.state} — not delivered; its deposit is still in escrow`;
  }
  return paymentId ? `still settling (payment ${paymentId})` : "not settled yet, and no payment is named yet";
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

// A connection can drop mid-purchase: a server or proxy closes an idle keep-alive
// connection just as the payer reuses it, or a proxy along the way cuts an attempt held
// open for a slow settlement. The purchase identifier makes re-attempting safe either way,
// and a fresh connection usually succeeds, so the payer re-attempts at once. A merchant that
// stays unreachable (a wrong MERCHANT_URL, a server that is down) fails after this many
// network errors in a row rather than consuming the whole re-attempt budget.
const MAX_CONSECUTIVE_NETWORK_ERRORS = 3;

/**
 * Node's fetch rejects every network failure with `TypeError("fetch failed")` and keeps the
 * socket error on `cause`. Its other TypeErrors, such as a URL it cannot parse, are
 * configuration errors that re-attempting cannot fix.
 */
function isNetworkError(err: unknown): err is TypeError {
  return err instanceof TypeError && err.message === "fetch failed";
}

/** The cause as `message (code)`, without repeating a code the message already names. */
function describeCause(cause: unknown): string {
  const { code, message } = (cause ?? {}) as { code?: unknown; message?: unknown };
  const text = typeof message === "string" ? message : "";
  if (typeof code !== "string" || text.includes(code)) return text || String(cause);
  return text ? `${text} (${code})` : code;
}

/**
 * An error's message with its cause appended. fetch reports every network failure as a
 * bare "fetch failed"; the cause says which one (`read ECONNRESET`, `connect ECONNREFUSED …`).
 */
export function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  return err.cause === undefined ? err.message : `${err.message}: ${describeCause(err.cause)}`;
}

/**
 * Drive one purchase to a terminal outcome, re-attempting while it is still settling.
 *
 * @param attempt - makes one attempt at the purchase: fetch the 402, sign a credential for
 *   it, and resubmit. The purchase identifier comes from the URL, so every attempt names
 *   the same payment.
 * @returns the response that settled, or a non-402 response the merchant answered with
 * @throws if the payment failed terminally, was refused, or never settled in time, or the
 *   network failed MAX_CONSECUTIVE_NETWORK_ERRORS times in a row
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
  let networkErrors = 0;

  for (let i = 1; i <= maxAttempts; i++) {
    if (i > 1) console.log(`  ⏳  attempt ${i}/${maxAttempts} …`);
    let response: Response;
    try {
      response = await attempt();
    } catch (err) {
      if (!isNetworkError(err) || ++networkErrors >= MAX_CONSECUTIVE_NETWORK_ERRORS || i === maxAttempts) {
        throw err;
      }
      console.log(`  ⏳  network error: ${describeCause(err.cause)} — re-attempting now`);
      continue;
    }
    networkErrors = 0;

    if (response.ok) {
      // Do not print "Payment settled." here: a 200 can still have no receipt.
      // client.ts prints that line after it reads a usable confirmation.
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
      `  ⏳  ${reattemptReason(problem, paymentId)} — ${elapsed()} elapsed, ` +
        `re-attempting in ${Math.round(intervalMs / 1000)}s`,
    );
    await sleep(intervalMs);
  }

  throw new Error(
    `payment ${paymentId ?? "(unidentified)"} was still settling after ${maxAttempts} attempts ` +
      `(${elapsed()}). It is not lost: re-run this purchase under the same identifier to collect ` +
      `its outcome.`,
  );
}
