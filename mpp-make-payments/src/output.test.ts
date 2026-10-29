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
import { Receipt } from "mppx";

// Output regressions for the payer's terminal trace: arrival is claimed only from a
// successful payment receipt, and a supplied PRIVATE_KEY does not imply real settlement.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_DIR = path.resolve(HERE, "..");
const NO_DOTENV = path.join(HERE, "no-such.env");

function tsxBin(dir: string): string {
  return path.join(dir, "node_modules", ".bin", "tsx");
}

function randomPrivateKey(): string {
  return `0x${randomBytes(32).toString("hex")}`;
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

function successfulReceipt(): string {
  return Receipt.serialize({
    method: "atum-escrow",
    status: "success",
    timestamp: new Date().toISOString(),
    reference: `0x${"22".repeat(32)}`,
    paymentId: "pay_stub_output",
    state: "completed",
    destinationChainId: "eip155:42431",
  } as Receipt.Receipt);
}

test("an HTTP 400 with no receipt does not claim destination arrival", async () => {
  await withStub(
    (_req, res) => {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Name the purchase in the URL" }));
    },
    async (url) => {
      const result = await runClient({
        PRIVATE_KEY: randomPrivateKey(),
        MERCHANT_URL: url,
        RPC_URL: "",
        GATEWAY_URL: "",
      });
      assert.notEqual(result.exitCode, 0, `expected a non-zero exit:\n${result.output}`);
      assert.match(result.output, /Status: 400/, `expected Status: 400:\n${result.output}`);
      assert.match(
        result.output,
        /Destination  settlement details unavailable \(HTTP 400\)/,
        `expected unavailable settlement details:\n${result.output}`,
      );
      assert.doesNotMatch(result.output, /arrived/, `HTTP 400 must not claim arrival:\n${result.output}`);
    },
  );
});

async function assertStubArrivalWithoutRealBanner(env: Record<string, string>): Promise<void> {
  await withStub(
    (_req, res) => {
      res.writeHead(200, {
        "content-type": "application/json",
        "payment-receipt": successfulReceipt(),
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
  // Existing regressions used RPC_URL: "", so a banner keyed off RPC_URL still passed.
  await assertStubArrivalWithoutRealBanner({ RPC_URL: "http://127.0.0.1:1" });
});

test("a 200 with no receipt does not print Payment settled", async () => {
  await withStub(
    (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "fulfilled" }));
    },
    async (url) => {
      const result = await runClient({
        PRIVATE_KEY: randomPrivateKey(),
        MERCHANT_URL: url,
        RPC_URL: "",
        GATEWAY_URL: "",
      });
      assert.equal(result.exitCode, 0, `client exited non-zero:\n${result.output}`);
      assert.match(
        result.output,
        /Destination  settlement details unavailable \(no receipt\)/,
        `expected unavailable settlement details:\n${result.output}`,
      );
      assert.doesNotMatch(result.output, /Payment settled/, `200 with no receipt must not print settled:\n${result.output}`);
      assert.doesNotMatch(result.output, /arrived/, `200 with no receipt must not claim arrival:\n${result.output}`);
    },
  );
});

test("a receipt for a real payment is not labelled stub and links its payout", async () => {
  const payout = `0x${"ab".repeat(32)}`;
  const header = Receipt.serialize({
    method: "atum-escrow",
    status: "success",
    timestamp: new Date().toISOString(),
    reference: payout,
    paymentId: `0x${"cd".repeat(32)}`,
    state: "finalizing",
    destinationChainId: "eip155:42431",
  } as Receipt.Receipt);
  await withStub(
    (_req, res) => {
      res.writeHead(200, {
        "content-type": "application/json",
        "payment-receipt": header,
      });
      res.end(JSON.stringify({ status: "fulfilled" }));
    },
    async (url) => {
      const result = await runClient({
        PRIVATE_KEY: randomPrivateKey(),
        MERCHANT_URL: url,
        RPC_URL: "",
        GATEWAY_URL: "",
      });
      assert.equal(result.exitCode, 0, `client exited non-zero:\n${result.output}`);
      assert.match(result.output, /arrived/, `expected arrival from dest chain:\n${result.output}`);
      assert.doesNotMatch(result.output, /arrived \(stub\)/, `a real payment must not read as stub:\n${result.output}`);
      assert.match(result.output, new RegExp(`destination payout: .*${payout}`), `expected the payout link:\n${result.output}`);
    },
  );
});
