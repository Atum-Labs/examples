/*
 * Copyright (c) 2026 Atum Labs, Inc. All rights reserved.
 * Proprietary reference implementation; not open source.
 * Access and use are governed by the LICENSE file at the root of this repository.
 * Do not remove, alter, or obscure this notice.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { randomBytes } from "node:crypto";

// Boots the real merchant and the real make-payments client as separate processes,
// exactly as a developer would run them by hand, and checks the documented outcome:
// 402 -> pay -> 200 with "Access granted". This exists to catch the example's own
// wiring breaking (an import path, an SDK version bump, a header change) — the
// protocol logic itself is covered by the SDK's own tests.
//
// The stub tests run with no facilitator, no gateway, and no funds. The real
// end-to-end test is opt-in (see the bottom of this file): it needs a funded wallet
// and moves real testnet funds, so it only runs when RUN_REAL_E2E and PRIVATE_KEY
// are set in the environment.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MERCHANT_DIR = path.resolve(HERE, "..");
const CLIENT_DIR = path.resolve(HERE, "../../x402-make-payments");

// Both the merchant and client `import "dotenv/config"`, which loads the .env in
// their working directory. Every spawned process below is pointed at a path that
// does not exist, so dotenv loads nothing and the tests stay hermetic — a developer's
// real .env (a live gateway, USE_STUB_FACILITATOR=false) can't leak into the children.
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

function waitForStdout(
  child: ChildProcessWithoutNullStreams,
  match: string,
  timeoutMs = 15_000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timed out waiting for merchant output to include "${match}"`)),
      timeoutMs,
    );
    child.stdout.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes(match)) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`merchant exited early (code ${code}) before printing "${match}"`));
    });
  });
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

interface MerchantHandle {
  url: string;
  output(): string;
}

async function withMerchant(
  port: number,
  env: Record<string, string>,
  fn: (merchant: MerchantHandle) => Promise<void>,
): Promise<void> {
  const merchant = spawn(tsxBin(MERCHANT_DIR), ["src/merchant.ts"], {
    cwd: MERCHANT_DIR,
    env: { ...process.env, DOTENV_CONFIG_PATH: NO_DOTENV, PORT: String(port), ...env },
  });
  let output = "";
  merchant.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
  merchant.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));

  try {
    await waitForStdout(merchant, "Merchant listening");
    await fn({ url: `http://localhost:${port}/paid`, output: () => output });
  } finally {
    merchant.kill();
  }
}

function assertPaid(result: RunResult, label: string): void {
  assert.equal(result.exitCode, 0, `${label} exited non-zero:\n${result.output}`);
  assert.match(result.output, /Status: 200/, `${label} expected a 200 response:\n${result.output}`);
  assert.match(result.output, /Access granted/, `${label} expected the resource body:\n${result.output}`);
}

// --- stub flow (no facilitator, gateway, or funds) -------------------------

const STUB_ENV = { USE_STUB_FACILITATOR: "true" };

test("stub flow: 402 -> pay -> 200", async () => {
  await withMerchant(4088, STUB_ENV, async ({ url }) => {
    const result = await runClient({ PRIVATE_KEY: randomPrivateKey(), MERCHANT_URL: url, RPC_URL: "" });
    assertPaid(result, "client");
  });
});

test("concurrent payments from different wallets all succeed", async () => {
  await withMerchant(4087, STUB_ENV, async ({ url }) => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        runClient({ PRIVATE_KEY: randomPrivateKey(), MERCHANT_URL: url, RPC_URL: "" }),
      ),
    );
    results.forEach((result, i) => assertPaid(result, `client ${i}`));
  });
});

test("the same wallet can pay more than once in sequence", async () => {
  await withMerchant(4086, STUB_ENV, async ({ url }) => {
    const key = randomPrivateKey();
    for (let i = 0; i < 3; i++) {
      const result = await runClient({ PRIVATE_KEY: key, MERCHANT_URL: url, RPC_URL: "" });
      assertPaid(result, `payment ${i + 1}`);
    }
  });
});

test("refuses to start in real mode without a valid DEST_ADDRESS", async () => {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DOTENV_CONFIG_PATH: NO_DOTENV,
    PORT: "4085",
    USE_STUB_FACILITATOR: "false",
    DEST_ADDRESS: "0xYourMerchantAddressHere",
  };
  const merchant = spawn(tsxBin(MERCHANT_DIR), ["src/merchant.ts"], { cwd: MERCHANT_DIR, env });
  let output = "";
  merchant.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
  merchant.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));

  const exitCode: number = await new Promise((resolve) =>
    merchant.once("exit", (code) => resolve(code ?? 1)),
  );
  assert.notEqual(exitCode, 0, `expected the merchant to refuse to start:\n${output}`);
  assert.match(output, /Refusing to start/, `expected the DEST_ADDRESS guard to fire:\n${output}`);
});

// --- real end-to-end (opt-in; moves real testnet funds) --------------------
//
// Runs only when RUN_REAL_E2E=1 and a funded PRIVATE_KEY is set. It settles a real
// payment against the hosted facilitator + gateway and asserts the merchant logged a
// real settlement tx — failing loudly if it sees the stub marker, so it can never
// give a false pass. Optional overrides: FACILITATOR_URL, GATEWAY_URL, DEST_ADDRESS,
// RPC_URL (defaults to Base Sepolia).
const REAL_E2E_ENABLED = process.env.RUN_REAL_E2E === "1" && !!process.env.PRIVATE_KEY;

test(
  "real e2e: settles a real payment against the hosted facilitator",
  { skip: REAL_E2E_ENABLED ? false : "set RUN_REAL_E2E=1 and PRIVATE_KEY to run" },
  async () => {
    const privateKey = process.env.PRIVATE_KEY as string;
    const merchantEnv: Record<string, string> = {
      USE_STUB_FACILITATOR: "false",
      DEST_ADDRESS: process.env.DEST_ADDRESS ?? "",
    };
    if (process.env.FACILITATOR_URL) merchantEnv.FACILITATOR_URL = process.env.FACILITATOR_URL;
    if (process.env.GATEWAY_URL) merchantEnv.GATEWAY_URL = process.env.GATEWAY_URL;

    await withMerchant(4089, merchantEnv, async ({ url, output }) => {
      const result = await runClient({
        PRIVATE_KEY: privateKey,
        MERCHANT_URL: url,
        RPC_URL: process.env.RPC_URL ?? "https://sepolia.base.org",
      });

      const paid = result.exitCode === 0 && /Status: 200/.test(result.output) && /Access granted/.test(result.output);
      if (paid) {
        // Real settlement confirmed — make sure it wasn't the stub.
        const merchantLog = output();
        assert.doesNotMatch(merchantLog, /stub/i, `real e2e must not settle via the stub:\n${merchantLog}`);
        assert.match(merchantLog, /→ 200: settled \(tx /, `expected a real settlement in the merchant log:\n${merchantLog}`);
        return;
      }

      // Known x402 v1 limitation: when settlement outruns the gateway's synchronous
      // window (~30s, server-side payment_sync_wait_seconds), the facilitator returns
      // "async tail is not supported in v1". The payment was submitted; x402 v1 just
      // can't confirm it synchronously — MPP handles this by polling the gateway, which
      // x402's hosted facilitator does not expose. Set ALLOW_ASYNC_TAIL=1 to treat a
      // clean submission-up-to-settlement as a conditional pass (wiring verified).
      const asyncTail = /async tail is not supported|did not complete synchronously/.test(result.output);
      if (asyncTail && process.env.ALLOW_ASYNC_TAIL === "1") {
        console.warn(
          "real e2e: submission accepted, but settlement exceeded the facilitator's synchronous " +
            "window (x402 v1 async tail unsupported). Wiring verified up to submission; settlement " +
            "is completing asynchronously and cannot be confirmed synchronously here.",
        );
        return;
      }
      if (asyncTail) {
        assert.fail(
          "x402 settlement did not complete within the facilitator's synchronous window (~30s, the " +
            "gateway's payment_sync_wait_seconds). x402 v1 has no async tail, so this corridor's " +
            "settlement is too slow for synchronous confirmation. Options: raise the gateway's " +
            "payment_sync_wait_seconds, use a faster corridor, or set ALLOW_ASYNC_TAIL=1 to accept " +
            `submission-only verification.\n\nClient output:\n${result.output}`,
        );
      }

      // Anything else is a genuine failure — surface it in full.
      assertPaid(result, "real client");
    });
  },
);
