/*
 * Copyright (c) 2026 Atum Labs, Inc.
 * SPDX-License-Identifier: MIT
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { describeError, payPurchase } from "./purchase.js";

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

// A pooled keep-alive connection can be closed by the server just as the payer reuses it,
// which fetch reports as a bare "fetch failed". Destroying the socket reproduces that.
test("re-attempts at once when the connection drops, then returns the response that settled", async () => {
  let attempts = 0;

  await withServer(
    (req, res) => {
      attempts++;
      if (attempts === 1) {
        req.socket.destroy();
        return;
      }
      res.writeHead(200, { "payment-receipt": "sim" });
      res.end(JSON.stringify({ ok: true }));
    },
    async (url) => {
      const startedAt = Date.now();
      const res = await payPurchase(() => fetch(url), { intervalMs: 60_000 });

      assert.equal(res.status, 200);
      assert.equal(attempts, 2, "expected one dropped connection then a settled attempt");
      assert.ok(Date.now() - startedAt < 60_000, "a dropped connection is re-attempted without the interval");
    },
  );
});

test("gives up after three network errors in a row, naming the cause", async () => {
  let attempts = 0;

  await withServer(
    (req) => {
      attempts++;
      req.socket.destroy();
    },
    async (url) => {
      await assert.rejects(
        () => payPurchase(() => fetch(url), { intervalMs: 10 }),
        (err) => {
          assert.match(describeError(err), /^fetch failed: \S/);
          return true;
        },
      );
      assert.equal(attempts, 3, "an unreachable merchant must fail fast, not for the whole budget");
    },
  );
});

test("does not re-attempt an error that is not a network failure", async () => {
  let attempts = 0;
  const refusal = new Error("the challenge names an escrow the trusted gateway does not vouch for");

  await assert.rejects(
    () =>
      payPurchase(
        async () => {
          attempts++;
          throw refusal;
        },
        { intervalMs: 10 },
      ),
    refusal,
  );
  assert.equal(attempts, 1, "a refusal is final; re-attempting cannot change it");
  assert.equal(describeError(refusal), refusal.message);
});

test("does not re-attempt a URL fetch cannot parse", async () => {
  let attempts = 0;

  await assert.rejects(
    () =>
      payPurchase(
        () => {
          attempts++;
          return fetch("not-a-url/paid");
        },
        { intervalMs: 10 },
      ),
    /Failed to parse URL/,
  );
  assert.equal(attempts, 1, "a malformed MERCHANT_URL is a configuration error, not a network error");
});
