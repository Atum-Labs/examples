/*
 * Copyright (c) 2026 Atum Labs, Inc.
 * SPDX-License-Identifier: MIT
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { collectPayment, type PaymentSnapshot } from "./purchase.js";

// Exercises collectPayment against a scripted status sequence. Which statuses end the wait,
// and what each one tells the payer to do, is where a wrong answer costs money: reading a
// payment waiting on its refund as failed invites a second payment while the first can still
// complete, and reading a failed one as pending strands the payer.

const PAYMENT_ID = "pay_0123456789abcdef";

// Answers the given statuses in order, repeating the last, and counts the checks.
function statuses(...sequence: string[]): { fetchStatus: () => Promise<PaymentSnapshot>; checks: () => number } {
  let checks = 0;
  return {
    fetchStatus: async () => ({ payment_id: PAYMENT_ID, status: sequence[Math.min(checks++, sequence.length - 1)] }),
    checks: () => checks,
  };
}

const FAST = { intervalMs: 5, budgetMs: 2_000 };

test("reports the payout as soon as it is finalizing, then waits for completed", async () => {
  const s = statuses("pending", "finalizing", "finalizing", "completed");
  const payouts: string[] = [];
  const outcome = await collectPayment(s.fetchStatus, { ...FAST, onPayout: (snap) => payouts.push(snap.status ?? "") });
  assert.equal(outcome.status, "completed");
  assert.equal(s.checks(), 4, "finalizing is not final; the wait must continue to completed");
  assert.equal(payouts[0], "finalizing", "the payout is reported at the first answer that names it");
});

test("stops on refund_available, names the payment, and says not to pay again", async () => {
  const s = statuses("pending", "refund_available", "completed");
  await assert.rejects(
    () => collectPayment(s.fetchStatus, FAST),
    (err: Error) => {
      assert.match(err.message, new RegExp(`payment ${PAYMENT_ID} is refund_available`));
      assert.match(err.message, /Do not pay again while it is refund_available/);
      assert.match(err.message, new RegExp(`npx payment-status ${PAYMENT_ID}`));
      assert.doesNotMatch(err.message, /NEW request id/, "a payment waiting on its refund is not spent");
      return true;
    },
  );
  assert.equal(s.checks(), 2, "the wait ends at refund_available; waiting longer does not help");
});

test("answers a payment already waiting on its refund without waiting", async () => {
  const s = statuses("refund_available");
  await assert.rejects(() => collectPayment(s.fetchStatus, FAST), /is refund_available/);
  assert.equal(s.checks(), 1);
});

for (const terminal of ["failed", "refunded"]) {
  test(`treats ${terminal} as terminal: the request id is spent, a new one can pay`, async () => {
    const s = statuses("pending", terminal);
    await assert.rejects(
      () => collectPayment(s.fetchStatus, FAST),
      new RegExp(`payment ${PAYMENT_ID} ${terminal} and nothing was delivered.*NEW request id`, "s"),
    );
  });
}

test("a payout still finalizing when the budget runs out is reported as paid, not as unpaid", async () => {
  const s = statuses("pending", "finalizing");
  const outcome = await collectPayment(s.fetchStatus, { intervalMs: 5, budgetMs: 50 });
  assert.equal(outcome.status, "finalizing");
  assert.equal(outcome.snapshot.payment_id, PAYMENT_ID);
});

test("a payment with no payout when the budget runs out is not lost, and is named", async () => {
  const s = statuses("pending");
  await assert.rejects(
    () => collectPayment(s.fetchStatus, { intervalMs: 5, budgetMs: 50 }),
    new RegExp(`payment ${PAYMENT_ID} was still settling when the wait budget ran out.*same request id`, "s"),
  );
});

test("a status this client does not know is not reported as success", async () => {
  const s = statuses("settled_somehow");
  await assert.rejects(
    () => collectPayment(s.fetchStatus, { intervalMs: 5, budgetMs: 50 }),
    (err: Error) => {
      assert.doesNotMatch(err.message, /completed/);
      return true;
    },
  );
});
