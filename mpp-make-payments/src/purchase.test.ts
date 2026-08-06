/*
 * Copyright (c) 2026 Atum Labs, Inc. All rights reserved.
 * Proprietary reference implementation; not open source.
 * Access and use are governed by the LICENSE file at the root of this repository.
 * Do not remove, alter, or obscure this notice.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { payPurchase } from "./purchase.js";

// Exercises the actual re-attempt loop client.ts uses (not a re-typed copy) against a real
// HTTP server that answers as the merchant does: `402` + problem details while settlement
// is in flight, then `200`. The distinction that matters is pending vs terminal — they
// call for opposite actions, and confusing them either strands the payer or double-charges.

const PAYMENT_ACTION_REQUIRED = "https://paymentauth.org/problems/payment-action-required";

async function withServer(
  handler: http.RequestListener,
  fn: (url: string) => Promise<void>,
): Promise<void> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://localhost:${port}/paid/order_test_0123456789`);
  } finally {
    server.close();
  }
}

function problem(res: http.ServerResponse, body: Record<string, unknown>): void {
  res.writeHead(402, { "content-type": "application/problem+json" });
  res.end(JSON.stringify(body));
}

test("re-attempts while settling, then returns the response that settled", async () => {
  let attempts = 0;

  await withServer(
    (_req, res) => {
      attempts++;
      if (attempts < 3) {
        problem(res, {
          type: PAYMENT_ACTION_REQUIRED,
          detail: "still settling",
          paymentId: "pay_1",
        });
        return;
      }
      res.writeHead(200, { "payment-receipt": "sim" });
      res.end(JSON.stringify({ ok: true }));
    },
    async (url) => {
      const res = await payPurchase(() => fetch(url), { intervalMs: 10 });

      assert.equal(res.status, 200);
      assert.equal(attempts, 3, "expected two pending answers then a settled one");
    },
  );
});

test("stops immediately on a terminal failure and says a new purchase id is needed", async () => {
  let attempts = 0;

  await withServer(
    (_req, res) => {
      attempts++;
      problem(res, {
        type: "https://paymentauth.org/problems/verification-failed",
        detail: "the payment reached a terminal state without settling",
        paymentId: "pay_dead",
      });
    },
    async (url) => {
      await assert.rejects(
        () => payPurchase(() => fetch(url), { intervalMs: 10 }),
        /pay_dead.*NEW purchase id/s,
      );
      // Re-attempting a dead payment resolves to the same failure forever, so looping on
      // it would strand the payer.
      assert.equal(attempts, 1, "a terminal failure must not be retried");
    },
  );
});

test("gives up after maxAttempts, naming the payment so it can still be collected", async () => {
  let attempts = 0;

  await withServer(
    (_req, res) => {
      attempts++;
      problem(res, { type: PAYMENT_ACTION_REQUIRED, detail: "still settling", paymentId: "pay_slow" });
    },
    async (url) => {
      await assert.rejects(
        () => payPurchase(() => fetch(url), { maxAttempts: 2, intervalMs: 10 }),
        /pay_slow was still settling after 2 attempts/,
      );
      assert.equal(attempts, 2, "should stop at maxAttempts, not retry forever");
    },
  );
});

test("hands back a non-402 response rather than retrying it", async () => {
  let attempts = 0;

  await withServer(
    (_req, res) => {
      attempts++;
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Name the purchase in the URL" }));
    },
    async (url) => {
      const res = await payPurchase(() => fetch(url), { intervalMs: 10 });

      assert.equal(res.status, 400);
      assert.equal(attempts, 1, "a 400 is not a payment outcome and should not be retried");
    },
  );
});
