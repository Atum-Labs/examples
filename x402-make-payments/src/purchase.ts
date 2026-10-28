/*
 * Copyright (c) 2026 Atum Labs, Inc.
 * SPDX-License-Identifier: MIT
 */

import { logArrival, settledAfter } from "./display.js";

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
  fulfillmentConfirmation?: {
    stub?: boolean;
    source_chain_id?: string;
    destination_chain_id?: string;
    source_tx_hash?: string;
    destination_tx_hash?: string;
  };
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
    const settle = settleResponseOf(response);

    // No PAYMENT-RESPONSE means no payment was presented — the client declined to build
    // one, so nothing was charged. Retrying cannot change that; let the caller report it.
    if (!settle) return response;

    paymentId = settle.extensions?.atum?.paymentId ?? paymentId;

    if (settle.success) {
      const confirm = settle.fulfillmentConfirmation;
      console.log(settledAfter(i, paymentId ? `— payment ${paymentId}` : undefined));
      if (confirm?.destination_chain_id || confirm?.destination_tx_hash) {
        logArrival({
          destNetwork: confirm.destination_chain_id,
          destHash: confirm.destination_tx_hash,
          sourceNetwork: confirm.source_chain_id,
          sourceHash: confirm.source_tx_hash,
          stub: Boolean(confirm.stub),
        });
      } else {
        console.log("   Destination  settlement details unavailable (no fulfillment confirmation)");
      }
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
      `  ⏳  still settling (payment ${paymentId}) — ${elapsed()} elapsed, ` +
        `re-attempting in ${Math.round(intervalMs / 1000)}s`,
    );
    await sleep(intervalMs);
  }

  throw new Error(
    `payment ${paymentId} was still settling after ${maxAttempts} attempts (${elapsed()}). It is ` +
      `not lost: re-run this purchase under the same identifier to collect its outcome.`,
  );
}
