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

// Boots the real merchant (stub mode — no gateway, no funds) and the real client
// as separate processes, exactly as a developer would run them by hand, and checks
// the documented outcome: 402 -> pay -> 200 with a Payment-Receipt header. This
// exists to catch the example's own wiring breaking (e.g. an import path or an
// mppx/SDK version bump) — the protocol logic itself is covered by the SDK's tests.
//
// Each test gets its own port and its own merchant process — not because concurrent
// requests are expected to interfere (each challenge gets its own `expires`, and the
// deposit nonce is scoped to the payer account — see the multi-client test below),
// but so the tests themselves stay independent of one another and can be run in
// any order or in parallel without port clashes.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MERCHANT_DIR = path.resolve(HERE, "..");
const CLIENT_DIR = path.resolve(HERE, "../../mpp-make-payments");

// The merchant and client both `import "dotenv/config"`, which loads the .env in
// their working directory. Every spawned process below is pointed at a path that
// does not exist, so dotenv loads nothing and the tests stay hermetic. Otherwise a
// developer's real .env (real MPP_SECRET_KEY, USE_STUB_SUBMITTER=false, a live
// gateway) leaks into the child and, e.g., defeats the placeholder-secret guard the
// refuse-to-start test relies on — booting the merchant in real mode so it never exits.
const NO_DOTENV = path.join(HERE, "no-such.env");

function tsxBin(dir: string): string {
  return path.join(dir, "node_modules", ".bin", "tsx");
}

function randomPrivateKey(): string {
  return `0x${randomBytes(32).toString("hex")}`;
}

function waitForStdout(
  child: ChildProcessWithoutNullStreams,
  match: string,
  timeoutMs = 20_000,
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

function runClient(env: Record<string, string>): Promise<{ exitCode: number; output: string }> {
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
  // Capture both streams: the real-settlement test asserts on the merchant's log
  // (the on-chain settlement lines), and reading stderr stops a slow consumer from
  // back-pressuring the child.
  let output = "";
  merchant.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
  merchant.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));

  try {
    await waitForStdout(merchant, "MPP merchant listening");
    await fn({ url: `http://localhost:${port}/paid`, output: () => output });
  } finally {
    merchant.kill();
  }
}

function assertPaid(result: { exitCode: number; output: string }, label: string): void {
  assert.equal(result.exitCode, 0, `${label} exited non-zero:\n${result.output}`);
  assert.match(result.output, /Status: 200/, `${label} expected a 200 response:\n${result.output}`);
  assert.match(
    result.output,
    /Payment-Receipt header: present/,
    `${label} expected a Payment-Receipt header:\n${result.output}`,
  );
}

// --- stub flow (no gateway or funds) ---------------------------------------

const STUB_ENV = { USE_STUB_SUBMITTER: "true" };

test("stub flow: 402 -> pay -> 200 with a receipt", async () => {
  await withMerchant(4098, STUB_ENV, async ({ url }) => {
    const result = await runClient({
      PRIVATE_KEY: randomPrivateKey(),
      MERCHANT_URL: url,
      RPC_URL: "",
    });
    assertPaid(result, "client");
  });
});

test("concurrent payments from different wallets all succeed", async () => {
  await withMerchant(4097, STUB_ENV, async ({ url }) => {
    const CLIENT_COUNT = 5;
    const results = await Promise.all(
      Array.from({ length: CLIENT_COUNT }, () =>
        runClient({ PRIVATE_KEY: randomPrivateKey(), MERCHANT_URL: url, RPC_URL: "" }),
      ),
    );
    results.forEach((result, i) => assertPaid(result, `client ${i}`));
  });
});

test("the same wallet can complete multiple independent payments in sequence", async () => {
  await withMerchant(4096, STUB_ENV, async ({ url }) => {
    const key = randomPrivateKey();
    for (let i = 0; i < 3; i++) {
      const result = await runClient({ PRIVATE_KEY: key, MERCHANT_URL: url, RPC_URL: "" });
      assertPaid(result, `payment ${i + 1}`);
    }
  });
});

test("refuses to start in real-settlement mode with the default placeholder secret", async () => {
  // MPP_SECRET_KEY is deleted (not just omitted) so this test doesn't depend on
  // whatever happens to be set in the environment it runs in.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DOTENV_CONFIG_PATH: NO_DOTENV,
    PORT: "4095",
    USE_STUB_SUBMITTER: "false",
  };
  delete env.MPP_SECRET_KEY;

  const merchant = spawn(tsxBin(MERCHANT_DIR), ["src/merchant.ts"], { cwd: MERCHANT_DIR, env });
  let output = "";
  merchant.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
  merchant.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));

  const exitCode: number = await new Promise((resolve) =>
    merchant.once("exit", (code) => resolve(code ?? 1)),
  );

  assert.notEqual(exitCode, 0, `expected the merchant to refuse to start:\n${output}`);
  assert.match(output, /Refusing to start/, `expected the placeholder-secret guard to fire:\n${output}`);
});

// --- real end-to-end (opt-in; moves real testnet funds) --------------------
//
// Runs only when RUN_REAL_E2E=1 and a funded PRIVATE_KEY is set. It settles a real
// Base -> Tempo payment through the hosted gateway and asserts the merchant logged a
// real settlement — failing loudly if it sees the stub payment id, so it can never
// give a false pass. MPP has no separate facilitator: the merchant polls the gateway
// past its synchronous window until settlement is terminal, so (unlike x402 v1) a
// slow cross-chain corridor still resolves to a confirmed result here.
//
// A fresh MPP_SECRET_KEY is generated per run (any private >= 32-byte secret works —
// the same merchant issues and verifies the challenge). Optional overrides:
// GATEWAY_URL, RPC_URL (defaults to Base Sepolia), FULFILLMENT_DEADLINE_SECONDS.
const REAL_E2E_ENABLED = process.env.RUN_REAL_E2E === "1" && !!process.env.PRIVATE_KEY;

test(
  "real e2e: settles a real Base -> Tempo payment through the gateway",
  { skip: REAL_E2E_ENABLED ? false : "set RUN_REAL_E2E=1 and PRIVATE_KEY to run" },
  async () => {
    const privateKey = process.env.PRIVATE_KEY as string;
    const merchantEnv: Record<string, string> = {
      USE_STUB_SUBMITTER: "false",
      DEST_ADDRESS: process.env.DEST_ADDRESS ?? "",
      // A real, private secret so the placeholder-secret guard passes.
      MPP_SECRET_KEY: process.env.MPP_SECRET_KEY ?? randomBytes(32).toString("hex"),
    };
    if (process.env.GATEWAY_URL) merchantEnv.GATEWAY_URL = process.env.GATEWAY_URL;
    if (process.env.FULFILLMENT_DEADLINE_SECONDS)
      merchantEnv.FULFILLMENT_DEADLINE_SECONDS = process.env.FULFILLMENT_DEADLINE_SECONDS;

    await withMerchant(4099, merchantEnv, async ({ url, output }) => {
      const result = await runClient({
        PRIVATE_KEY: privateKey,
        MERCHANT_URL: url,
        RPC_URL: process.env.RPC_URL ?? "https://sepolia.base.org",
      });

      assertPaid(result, "real client");

      // Real settlement confirmed — make sure it wasn't the stub. The stub logs a
      // "pay_stub_…" payment id; a real settlement logs a hex payment id plus the
      // source-deposit and destination-payout transaction links.
      const merchantLog = output();
      assert.doesNotMatch(merchantLog, /stub/i, `real e2e must not settle via the stub:\n${merchantLog}`);
      assert.match(
        merchantLog,
        /settled payment 0x[0-9a-f]/i,
        `expected a real on-chain settlement in the merchant log:\n${merchantLog}`,
      );
    });
  },
);
