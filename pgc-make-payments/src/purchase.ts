/*
 * Copyright (c) 2026 Atum Labs, Inc.
 * SPDX-License-Identifier: MIT
 */

import {
  isTerminalStatus,
  waitForTerminalStatus,
  type StatusSnapshot,
} from "@atumlabs/payment-gateway-client";

// Collecting a submitted payment until it reaches a terminal outcome.
//
// x402 and MPP collect by re-attempting the purchase: there is a 402 to fetch
// again, and the merchant must not hold the payer's HTTP request open. PGC has
// no 402 and no merchant — the client talks to the gateway directly — so the
// collection mechanism is the one the SDK ships: waitForTerminalStatus (the
// same helper behind `send-payment --wait`).
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

export interface PaymentOutcome<T extends StatusSnapshot> {
  status: string;
  snapshot: T;
}

/**
 * Drive one submitted payment to a terminal outcome.
 *
 * @param fetchStatus - reads the payment's current status
 * @returns the terminal snapshot
 * @throws if the payment failed terminally, or was still settling when the budget ran out
 */
export async function collectPayment<T extends StatusSnapshot>(
  fetchStatus: () => Promise<T>,
  options: CollectOptions = {},
): Promise<PaymentOutcome<T>> {
  const first = await fetchStatus();
  if (isTerminalStatus(first.status)) {
    return settleOrThrow(first);
  }

  console.log(`  still settling — waiting for a terminal status`);
  const outcome = await waitForTerminalStatus({
    fetchStatus,
    budgetMs: options.budgetMs ?? DEFAULT_BUDGET_MS,
    intervalMs: options.intervalMs,
    onError: (error) =>
      console.warn(`  status check failed, still waiting: ${(error as Error).message}`),
  });

  if (outcome.timedOut || !outcome.snapshot) {
    throw new Error(
      `payment was still settling when the wait budget ran out. It is not lost: ` +
        `re-run this payment under the same request id to collect its outcome.`,
    );
  }

  return settleOrThrow(outcome.snapshot);
}

function settleOrThrow<T extends StatusSnapshot>(snapshot: T): PaymentOutcome<T> {
  const status = snapshot.status ?? "unknown";
  if (status === "completed") {
    return { status, snapshot };
  }
  if (status === "failed" || status === "cancelled") {
    throw new Error(
      `payment ${status} and nothing was delivered. That request id now resolves ` +
        `to this failed payment for good, so re-attempting under it cannot recover — ` +
        `but the same corridor can still be paid: start another payment under a NEW ` +
        `request id (re-running without REQUEST_ID generates one)`,
    );
  }
  throw new Error(`payment ended in an unexpected status: ${status}`);
}
