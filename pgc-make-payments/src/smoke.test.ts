/*
 * Copyright (c) 2026 Atum Labs, Inc.
 * SPDX-License-Identifier: MIT
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { randomBytes } from "node:crypto";

// Runs the real pgc-make-payments client as a separate process, exactly as a
// developer would, against its in-process stub gateway. This catches the
// example's own wiring breaking (an import path, an SDK version bump, the
// offline signing flow) without needing a hosted gateway, funds, or a key —
// the client signs a Permit2 authorization off-chain, so no chain interaction
// happens here.

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

const STUB_ENV = {
  USE_STUB_GATEWAY: "true",
  RPC_URL: "",
  DEST_ADDRESS: "",
  GATEWAY_URL: "",
};

test("stub flow: prepare -> sign -> submit -> completed", async () => {
  const result = await runClient({ ...STUB_ENV, PRIVATE_KEY: randomPrivateKey() });
  assert.equal(result.exitCode, 0, `client exited non-zero:\n${result.output}`);
  assert.match(result.output, /settled — payment pay_stub_/, `expected a settled payment:\n${result.output}`);
  assert.match(
    result.output,
    /Request pmt_[0-9a-f]{20} — to re-attempt it/,
    `expected a generated request id:\n${result.output}`,
  );
});

test("a still-settling payment is collected by waiting on the same request id", async () => {
  const result = await runClient({
    ...STUB_ENV,
    PRIVATE_KEY: randomPrivateKey(),
    STUB_PENDING_ATTEMPTS: "2",
  });
  assert.equal(result.exitCode, 0, `client exited non-zero:\n${result.output}`);
  assert.match(result.output, /still settling/, `expected the pending wait to be reported:\n${result.output}`);
  assert.match(result.output, /settled — payment pay_stub_/, `expected the wait to settle:\n${result.output}`);
});

test("resuming a payment reuses its request id instead of generating a new one", async () => {
  const requestId = "pmt_resumed_0123456789";
  const result = await runClient({
    ...STUB_ENV,
    PRIVATE_KEY: randomPrivateKey(),
    REQUEST_ID: requestId,
  });
  assert.equal(result.exitCode, 0, `client exited non-zero:\n${result.output}`);
  assert.match(
    result.output,
    new RegExp(`Request ${requestId} — to re-attempt it`),
    `REQUEST_ID must name the payment verbatim:\n${result.output}`,
  );
});

// A stub run signs offline and never touches a chain, so it needs a well-formed key
// rather than a funded one. Generating one keeps `npm run pay` working on a first
// run instead of stopping it to go and produce a key by hand.
test("stub run with no PRIVATE_KEY signs with a generated throwaway key", async () => {
  const result = await runClient({ ...STUB_ENV, PRIVATE_KEY: "" });
  assert.equal(result.exitCode, 0, `client exited non-zero:\n${result.output}`);
  assert.match(result.output, /settled — payment pay_stub_/, `expected a settled payment:\n${result.output}`);
  assert.match(
    result.output,
    /No PRIVATE_KEY set — signing this stub run with a throwaway key \(0x[0-9a-fA-F]{40}\)/,
    `expected the generated-key notice naming the address:\n${result.output}`,
  );
});

// Real settlement is the case where a generated key is the wrong answer: it would be
// an unfunded address, and the failure would surface as a reverted transaction rather
// than the missing config that caused it. RPC_URL (or USE_STUB_GATEWAY=false) is what
// marks the run as real.
test("exits with an error when PRIVATE_KEY is missing and RPC_URL is set", async () => {
  const result = await runClient({
    ...STUB_ENV,
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

test("exits with an error when PRIVATE_KEY is missing and USE_STUB_GATEWAY=false", async () => {
  const result = await runClient({
    USE_STUB_GATEWAY: "false",
    PRIVATE_KEY: "",
    RPC_URL: "",
    DEST_ADDRESS: "0x0000000000000000000000000000000000000001",
  });
  assert.notEqual(result.exitCode, 0, `expected a non-zero exit:\n${result.output}`);
  assert.match(
    result.output,
    /PRIVATE_KEY is required in \.env for real settlement/,
    `expected the missing-key error:\n${result.output}`,
  );
});
