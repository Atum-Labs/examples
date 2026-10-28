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
// HTTP server whose connection drops before it answers. A pooled keep-alive connection can
// be closed by the server just as the payer reuses it, which fetch reports as a bare
// "fetch failed". Destroying the socket reproduces that.

async function withServer(
  handler: http.RequestListener,
  fn: (url: string) => Promise<void>,
): Promise<void> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://localhost:${port}/paid`);
  } finally {
    server.close();
  }
}

function settled(res: http.ServerResponse): void {
  const report = { success: true, extensions: { atum: { paymentId: "pay_1" } } };
  res.writeHead(200, {
    "payment-response": Buffer.from(JSON.stringify(report)).toString("base64"),
  });
  res.end(JSON.stringify({ ok: true }));
}

test("re-attempts at once when the connection drops, then returns the response that settled", async () => {
  let attempts = 0;

  await withServer(
    (req, res) => {
      attempts++;
      if (attempts === 1) {
        req.socket.destroy();
        return;
      }
      settled(res);
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
