/*
 * Copyright (c) 2026 Atum Labs, Inc.
 * SPDX-License-Identifier: MIT
 */

import {
  isTerminalStatus,
  waitForStatus,
  type PaymentStatus,
  type StatusSnapshot,
} from "@atumlabs/payment-gateway-client";

// Collecting a submitted payment until it reaches a terminal outcome.
//
// x402 and MPP collect by re-attempting the purchase: there is a 402 to fetch
// again, and the merchant must not hold the payer's HTTP request open. PGC has
// no 402 and no merchant — the client talks to the gateway directly — so the
// collection mechanism is the one the SDK ships: waitForStatus (the same helper
// behind `send-payment --wait`). This example waits for `completed`, the payout final,
// because it reports a finished payment. `waitFor: "finalizing"` stops once the payout is on
// chain, seconds to minutes sooner on some chains, accepting that it can still be dropped.
//
// Re-submitting the same request_id also returns the current state, but it
// rebuilds and re-sends the payment to do so. Status lookup is the cheaper
// follow-up; this module uses that. A timed-out wait is not a failure — the
// payment continues — and the printed request_id is what you re-run under.

export interface CollectOptions {
  /** How long to keep checking, in milliseconds. Default: 120_000. */
  budgetMs?: number;
  /** Gap between checks, in milliseconds. Default: SDK's 2s. */
  intervalMs?: number;
}

const DEFAULT_BUDGET_MS = 120_000;

/** What the gateway answers about a payment: its status, and the payment it names. */
export type PaymentSnapshot = StatusSnapshot & { payment_id?: string };

export interface PaymentOutcome<T extends PaymentSnapshot> {
  status: string;
  snapshot: T;
}

/**
 * Drive one submitted payment to a terminal outcome.
 *
 * @param fetchStatus - reads the payment's current status
 * @returns the terminal snapshot
 * @throws if the payment failed terminally, is waiting on its refund, or was still settling
 *   when the budget ran out
 */
export async function collectPayment<T extends PaymentSnapshot>(
  fetchStatus: () => Promise<T>,
  options: CollectOptions = {},
): Promise<PaymentOutcome<T>> {
  const first = await fetchStatus();
  if (isTerminalStatus(first.status) || first.status === "refund_available") {
    return settleOrThrow(first);
  }

  console.log(`  ⏳  still settling — waiting`);
  const outcome = await waitForStatus({
    fetchStatus,
    waitFor: "completed",
    budgetMs: options.budgetMs ?? DEFAULT_BUDGET_MS,
    intervalMs: options.intervalMs,
    onError: (error) =>
      console.warn(`  ⏳  status check failed, still waiting: ${(error as Error).message}`),
  });

  if (outcome.timedOut || !outcome.snapshot) {
    throw new Error(
      `payment was still settling when the wait budget ran out. It is not lost: ` +
        `re-run this payment under the same request id to collect its outcome.`,
    );
  }

  return settleOrThrow(outcome.snapshot);
}

function settleOrThrow<T extends PaymentSnapshot>(snapshot: T): PaymentOutcome<T> {
  const payment = snapshot.payment_id ?? "(unidentified)";
  // Typed as the SDK's status union, so a status a later SDK adds fails to compile here
  // until it is handled. A value the gateway sends that this SDK does not know still lands
  // in the default branch at runtime.
  const status = snapshot.status as PaymentStatus | undefined;
  switch (status) {
    case "completed":
      return { status, snapshot };
    // Not delivered, and the deposit is still in escrow: the refund waits on the payer, and a
    // late delivery can still complete the payment, so paying again risks paying twice.
    case "refund_available":
      throw new Error(
        `payment ${payment} is refund_available: nothing was delivered and the deposit is still ` +
          `in escrow. Do not pay again while it is refund_available — a late delivery can still ` +
          `complete it. To return the funds, read its refund_signature with ` +
          `\`npx payment-status ${payment}\` and submit it to the source chain's escrow`,
      );
    case "failed":
    case "refunded":
      throw new Error(
        `payment ${payment} ${status} and nothing was delivered. That request id now resolves ` +
          `to this payment for good, so re-attempting under it cannot recover — ` +
          `but the same corridor can still be paid: start another payment under a NEW ` +
          `request id (re-running without REQUEST_ID generates one)`,
      );
    case "pending":
    case "finalizing":
    case "refunding":
    case undefined:
      throw new Error(
        `payment ${payment} is not final yet (${status ?? "no status"}). It is not lost: ` +
          `re-run this payment under the same request id to collect its outcome.`,
      );
    default: {
      const unknown: never = status;
      throw new Error(`payment ${payment} ended in an unexpected status: ${String(unknown)}`);
    }
  }
}
