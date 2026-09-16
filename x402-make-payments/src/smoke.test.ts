/*
 * Copyright (c) 2026 Atum Labs, Inc.
 * SPDX-License-Identifier: MIT
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";

// Runs the real make-payments client as a separate process, exactly as a developer
// would, against a minimal in-process stub that speaks the x402 402 -> pay -> 200
// handshake. This catches the example's own wiring breaking (an import path, an SDK
// version bump, the offline signing flow) without needing the sibling merchant
// example, a facilitator, a gateway, or any funds — the client signs a Permit2
// authorization off-chain, so no chain interaction happens here.
//
// The atum-escrow 402 challenge below intentionally mirrors the one the stub in
// x402-accept-payments issues (buildRequirements(STUB_CORRIDOR)); it's the exact
// shape the client's registered scheme knows how to sign.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_DIR = path.resolve(HERE, "..");

// The client `import "dotenv/config"`s, which loads the .env in its working
// directory. Point every spawned process at a path that does not exist so dotenv
// loads nothing and the test stays hermetic — a developer's real .env can't leak in.
const NO_DOTENV = path.join(HERE, "no-such.env");

function tsxBin(dir: string): string {
  return path.join(dir, "node_modules", ".bin", "tsx");
}

function randomPrivateKey(): string {
  return `0x${randomBytes(32).toString("hex")}`;
}

// A well-formed atum-escrow 402 challenge the client's scheme can sign offline. Like the
// real merchant, it declares that the payer must name the purchase it is paying for.
const CHALLENGE = {
  x402Version: 2,
  resource: { url: "http://stub/paid", description: "Example premium resource" },
  extensions: { "payment-identifier": { info: { required: true } } },
  accepts: [
    {
      scheme: "atum-escrow",
      network: "eip155:84532", // Base Sepolia
      asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", // Base Sepolia USDC
      payTo: "0x0000000000000000000000000000000000000001",
      amount: "51500",
      maxTimeoutSeconds: 60,
      extra: {
        atum: {
          destination: {
            network: "eip155:42431", // Tempo Moderato
            asset: "0x20c0000000000000000000000000000000000000", // Tempo pathUSD
            address: "0x000000000000000000000000000000000000dEaD",
          },
          fulfillmentAmount: "50000",
          escrow: "0x0000000000000000000000000000000000000001",
          fulfillmentProxy: "0x0000000000000000000000000000000000000003",
          reserver: "0x0000000000000000000000000000000000000004",
          releaser: "0x0000000000000000000000000000000000000005",
          fulfillmentVerifierEndpoint: "http://localhost:8080/veri-fill",
          quoteDeadlineSeconds: 5,
          fulfillmentDeadlineSeconds: 300,
        },
      },
    },
  ],
};

const encodeHeader = (value: unknown): string =>
  Buffer.from(JSON.stringify(value), "utf8").toString("base64");

const decodeHeader = (value: string): Record<string, unknown> =>
  JSON.parse(Buffer.from(value, "base64").toString("utf8")) as Record<string, unknown>;

const STUB_PAYMENT_ID = "pay_stub_0000000000000000";

/**
 * Stub merchant: 402 with the challenge until a payment shows up, then 200 with the
 * resource. It does not verify the signature (the SDK's job) — it only proves the client
 * completes the handshake end to end.
 *
 * `pendingAttempts` makes the first N presented payments answer `settlement_pending`, as
 * the real facilitator does when cross-chain settlement outruns the gateway's synchronous
 * window, so the client's re-attempt loop is exercised.
 */
function startStubMerchant(pendingAttempts = 0): Promise<StubMerchant> {
  // The purchase identifier each presented payment named, in order. Every attempt at one
  // purchase must name the same value — that is what makes them one payment.
  const presented: string[] = [];
  const server = http.createServer((req, res) => {
    const payment = (req.headers["payment-signature"] ?? req.headers["x-payment"]) as string | undefined;
    if (!payment) {
      res
        .writeHead(402, {
          "content-type": "application/json",
          "PAYMENT-REQUIRED": encodeHeader(CHALLENGE),
        })
        .end(JSON.stringify(CHALLENGE));
      return;
    }

    const extensions = decodeHeader(payment).extensions as
      | { "payment-identifier"?: { info?: { id?: string } } }
      | undefined;
    presented.push(extensions?.["payment-identifier"]?.info?.id ?? "(unnamed)");

    if (presented.length <= pendingAttempts) {
      const pending = {
        success: false,
        errorReason: "settlement_pending",
        errorMessage: "still settling; re-attempt the purchase under the same identifier",
        extensions: { atum: { paymentId: STUB_PAYMENT_ID, state: "pending" } },
      };
      res
        .writeHead(402, {
          "content-type": "application/json",
          "PAYMENT-REQUIRED": encodeHeader(CHALLENGE),
          "PAYMENT-RESPONSE": encodeHeader(pending),
        })
        .end(JSON.stringify(CHALLENGE));
      return;
    }

    res
      .writeHead(200, {
        "content-type": "application/json",
        "PAYMENT-RESPONSE": encodeHeader({
          success: true,
          transaction: `0x${"11".repeat(32)}`,
          extensions: { atum: { paymentId: STUB_PAYMENT_ID, state: "completed" } },
        }),
      })
      .end(JSON.stringify({ message: "Access granted.", data: "Your premium content here." }));
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}/paid`,
        close: () => server.close(),
        presented: () => presented,
      });
    });
  });
}

interface StubMerchant {
  url: string;
  close: () => void;
  /** The purchase identifier each presented payment named, in order. */
  presented: () => string[];
}

interface RunResult {
  exitCode: number;
  output: string;
}

function runClient(env: Record<string, string>): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const client = spawn(tsxBin(CLIENT_DIR), ["src/client.ts"], {
      cwd: CLIENT_DIR,
      env: { ...process.env, DOTENV_CONFIG_PATH: NO_DOTENV, ...env },
    });
    let output = "";
    client.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    client.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
    client.once("error", reject);
    client.once("exit", (code) => resolve({ exitCode: code ?? 1, output }));
  });
}

test("stub flow: 402 -> sign -> pay -> 200", async () => {
  const merchant = await startStubMerchant();
  try {
    // No RPC_URL, so the client skips the on-chain Permit2 approval and signs offline.
    const result = await runClient({ PRIVATE_KEY: randomPrivateKey(), MERCHANT_URL: merchant.url, RPC_URL: "" });
    assert.equal(result.exitCode, 0, `client exited non-zero:\n${result.output}`);
    assert.match(result.output, /Status: 200/, `expected a 200 response:\n${result.output}`);
    assert.match(result.output, /Access granted/, `expected the resource body:\n${result.output}`);

    // The payment must name the purchase, or the gateway could not de-duplicate a retry.
    assert.deepEqual(merchant.presented().length, 1, "expected exactly one payment");
    assert.match(
      merchant.presented()[0],
      /^order_[0-9a-f]{20}$/,
      `expected a generated purchase identifier, got ${merchant.presented()[0]}`,
    );
  } finally {
    merchant.close();
  }
});

test("a still-settling payment is collected by re-attempting the same purchase", async () => {
  // One pending answer, then settled — the shape of a cross-chain settlement that outruns
  // the gateway's synchronous window.
  const merchant = await startStubMerchant(1);
  try {
    const result = await runClient({ PRIVATE_KEY: randomPrivateKey(), MERCHANT_URL: merchant.url, RPC_URL: "" });
    assert.equal(result.exitCode, 0, `client exited non-zero:\n${result.output}`);
    assert.match(result.output, /still settling/, `expected the pending attempt to be reported:\n${result.output}`);
    assert.match(result.output, /Status: 200/, `expected the re-attempt to be served:\n${result.output}`);

    // Two attempts, ONE purchase. If these differed, the re-attempt would have been a
    // second payment rather than a retry of the first.
    const presented = merchant.presented();
    assert.equal(presented.length, 2, `expected a re-attempt, got ${presented.length} payment(s)`);
    assert.equal(presented[0], presented[1], "every attempt at one purchase must name the same identifier");
  } finally {
    merchant.close();
  }
});

test("resuming a purchase reuses its identifier instead of generating a new one", async () => {
  const merchant = await startStubMerchant();
  try {
    const purchaseId = "order_resumed_0123456789";
    const result = await runClient({
      PRIVATE_KEY: randomPrivateKey(),
      MERCHANT_URL: merchant.url,
      RPC_URL: "",
      PURCHASE_ID: purchaseId,
    });
    assert.equal(result.exitCode, 0, `client exited non-zero:\n${result.output}`);
    assert.deepEqual(merchant.presented(), [purchaseId], "PURCHASE_ID must name the purchase verbatim");
  } finally {
    merchant.close();
  }
});

// A stub run signs offline and never touches a chain, so it needs a well-formed key
// rather than a funded one. Generating one keeps `cp .env.example .env && npm run pay`
// working on a first run instead of stopping it to go and produce a key by hand.
test("stub run with no PRIVATE_KEY signs with a generated throwaway key", async () => {
  const merchant = await startStubMerchant();
  try {
    const result = await runClient({ MERCHANT_URL: merchant.url, PRIVATE_KEY: "", RPC_URL: "" });
    assert.equal(result.exitCode, 0, `client exited non-zero:\n${result.output}`);
    assert.match(result.output, /Status: 200/, `expected a 200 response:\n${result.output}`);
    assert.match(
      result.output,
      /No PRIVATE_KEY set — signing this stub run with a throwaway key \(0x[0-9a-fA-F]{40}\)/,
      `expected the generated-key notice naming the address:\n${result.output}`,
    );
  } finally {
    merchant.close();
  }
});

// Real settlement is the case where a generated key is the wrong answer: it would be an
// unfunded address, and the failure would surface as a reverted transaction rather than
// the missing config that caused it. RPC_URL is what marks the run as real.
test("exits with an error when PRIVATE_KEY is missing and RPC_URL is set", async () => {
  const result = await runClient({
    MERCHANT_URL: "http://127.0.0.1:1/paid",
    PRIVATE_KEY: "",
    RPC_URL: "http://127.0.0.1:1",
  });
  assert.notEqual(result.exitCode, 0, `expected a non-zero exit:\n${result.output}`);
  assert.match(
    result.output,
    /PRIVATE_KEY is required in \.env for real settlement/,
    `expected the missing-key error:\n${result.output}`,
  );
});
