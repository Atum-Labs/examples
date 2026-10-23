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

// Banner must stay neutral until the receipt names stub vs real. A 200 with a
// PAYMENT-RESPONSE is enough — no 402 — so RPC_URL being set does not hit a chain.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_DIR = path.resolve(HERE, "..");
const NO_DOTENV = path.join(HERE, "no-such.env");

function tsxBin(dir: string): string {
  return path.join(dir, "node_modules", ".bin", "tsx");
}

function randomPrivateKey(): string {
  return `0x${randomBytes(32).toString("hex")}`;
}

function encodeHeader(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

function stubPaymentResponse(): string {
  return encodeHeader({
    success: true,
    transaction: `0x${"11".repeat(32)}`,
    extensions: { atum: { paymentId: "pay_stub_output", state: "completed" } },
    fulfillmentConfirmation: {
      stub: true,
      destination_chain_id: "eip155:42431",
      destination_tx_hash: `0x${"22".repeat(32)}`,
      source_chain_id: "eip155:84532",
      source_tx_hash: `0x${"11".repeat(32)}`,
    },
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

async function withStub(
  handler: http.RequestListener,
  fn: (url: string) => Promise<void>,
): Promise<void> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}/paid`);
  } finally {
    server.close();
  }
}

async function assertStubArrivalWithoutRealBanner(env: Record<string, string>): Promise<void> {
  await withStub(
    (_req, res) => {
      res.writeHead(200, {
        "content-type": "application/json",
        "PAYMENT-RESPONSE": stubPaymentResponse(),
      });
      res.end(JSON.stringify({ status: "fulfilled", message: "Payment received. Report delivered." }));
    },
    async (url) => {
      const result = await runClient({
        PRIVATE_KEY: randomPrivateKey(),
        MERCHANT_URL: url,
        GATEWAY_URL: "",
        ...env,
      });
      assert.equal(result.exitCode, 0, `client exited non-zero:\n${result.output}`);
      assert.match(result.output, /Status: 200/, `expected a 200 response:\n${result.output}`);
      assert.doesNotMatch(
        result.output,
        /real settlement/,
        `banner must not claim real settlement before the receipt:\n${result.output}`,
      );
      assert.match(
        result.output,
        /Destination  Tempo \(Moderato\) pathUSD — arrived \(stub\)/,
        `expected stub destination arrival:\n${result.output}`,
      );
    },
  );
}

test("a successful stub receipt prints destination arrival and not real settlement", async () => {
  await assertStubArrivalWithoutRealBanner({ RPC_URL: "" });
});

test("RPC_URL set against a stub merchant does not print real settlement", async () => {
  await assertStubArrivalWithoutRealBanner({ RPC_URL: "http://127.0.0.1:1" });
});
