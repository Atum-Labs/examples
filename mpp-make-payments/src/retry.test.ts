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
import { sendWithRetries } from "./retry.js";

// Verifies the actual retry policy client.ts uses (not a re-typed copy of it) against
// a real HTTP server that fails transiently, so a future change that accidentally
// rebuilds the credential per attempt — instead of resending the identical one — would
// fail this test.

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

test("resends the identical credential on every attempt and succeeds once the server recovers", async () => {
  const seenAuthHeaders: Array<string | undefined> = [];
  let callCount = 0;

  await withServer(
    (req, res) => {
      callCount++;
      seenAuthHeaders.push(req.headers.authorization);
      if (callCount < 3) {
        res.writeHead(500);
        res.end("simulated settlement timeout");
        return;
      }
      res.writeHead(200, { "payment-receipt": "sim" });
      res.end(JSON.stringify({ ok: true }));
    },
    async (url) => {
      const credential = "Payment fake-credential-bytes";
      const res = await sendWithRetries(() => fetch(url, { headers: { Authorization: credential } }), {
        retryDelayMs: 10,
      });

      assert.equal(res.status, 200);
      assert.equal(callCount, 3, "expected two failures then a success");
      assert.deepEqual(
        seenAuthHeaders,
        [credential, credential, credential],
        "every attempt must resend the identical credential, never a rebuilt one",
      );
    },
  );
});

test("gives up after maxAttempts and surfaces the final failing response", async () => {
  let callCount = 0;

  await withServer(
    (_req, res) => {
      callCount++;
      res.writeHead(503);
      res.end("still down");
    },
    async (url) => {
      const res = await sendWithRetries(() => fetch(url, { headers: { Authorization: "Payment x" } }), {
        maxAttempts: 2,
        retryDelayMs: 10,
      });

      assert.equal(res.status, 503);
      assert.equal(callCount, 2, "should stop at maxAttempts, not retry forever");
    },
  );
});

test("does not retry a non-5xx response (e.g. a rejected credential)", async () => {
  let callCount = 0;

  await withServer(
    (_req, res) => {
      callCount++;
      res.writeHead(400);
      res.end("bad credential");
    },
    async (url) => {
      const res = await sendWithRetries(() => fetch(url, { headers: { Authorization: "Payment x" } }), {
        retryDelayMs: 10,
      });

      assert.equal(res.status, 400);
      assert.equal(callCount, 1, "a 4xx is not a transient failure and should not be retried");
    },
  );
});

test("rejects an invalid maxAttempts instead of silently doing nothing", async () => {
  await assert.rejects(
    () => sendWithRetries(() => fetch("http://localhost:1"), { maxAttempts: 0 }),
    /maxAttempts must be at least 1/,
  );
});
