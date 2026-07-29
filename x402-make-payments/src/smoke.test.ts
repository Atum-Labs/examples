/*
 * Copyright (c) 2026 Atum Labs, Inc. All rights reserved.
 * Proprietary reference implementation; not open source.
 * Access and use are governed by the LICENSE file at the root of this repository.
 * Do not remove, alter, or obscure this notice.
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

// A well-formed atum-escrow 402 challenge the client's scheme can sign offline.
const CHALLENGE = {
  x402Version: 2,
  resource: { url: "http://stub/paid", description: "Example premium resource" },
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

// Stub merchant: 402 with the challenge until a payment credential shows up, then
// 200 with the resource. It does not verify the signature (the SDK's job) — it only
// proves the client completes the handshake end to end.
function startStubMerchant(): Promise<{ url: string; close: () => void }> {
  const server = http.createServer((req, res) => {
    const paid = Boolean(req.headers["payment-signature"] ?? req.headers["x-payment"]);
    if (!paid) {
      res
        .writeHead(402, {
          "content-type": "application/json",
          "PAYMENT-REQUIRED": encodeHeader(CHALLENGE),
        })
        .end(JSON.stringify(CHALLENGE));
      return;
    }
    res
      .writeHead(200, {
        "content-type": "application/json",
        "PAYMENT-RESPONSE": encodeHeader({ success: true, transaction: `0x${"11".repeat(32)}` }),
      })
      .end(JSON.stringify({ message: "Access granted.", data: "Your premium content here." }));
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}/paid`,
        close: () => server.close(),
      });
    });
  });
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
    // No RPC_URL, so the client skips the on-chain Permit2 preflight and signs offline.
    const result = await runClient({ PRIVATE_KEY: randomPrivateKey(), MERCHANT_URL: merchant.url });
    assert.equal(result.exitCode, 0, `client exited non-zero:\n${result.output}`);
    assert.match(result.output, /Status: 200/, `expected a 200 response:\n${result.output}`);
    assert.match(result.output, /Access granted/, `expected the resource body:\n${result.output}`);
  } finally {
    merchant.close();
  }
});

test("exits with an error when PRIVATE_KEY is missing", async () => {
  const result = await runClient({ MERCHANT_URL: "http://127.0.0.1:1/paid", PRIVATE_KEY: "" });
  assert.notEqual(result.exitCode, 0, `expected a non-zero exit:\n${result.output}`);
  assert.match(result.output, /PRIVATE_KEY is required/, `expected the missing-key error:\n${result.output}`);
});
