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
  getOutput: () => string,
  timeoutMs = 15_000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    // Accumulate before matching: a split write can land "Merchant" and
    // "listening" in separate chunks, which a per-chunk check would miss.
    let buf = "";
    // Surface what the merchant actually printed — a bad GATEWAY_URL, a busy
    // port, or an invalid amount all exit early, and the reason is in its output.
    const fail = (why: string) =>
      reject(new Error(`${why}\n--- merchant output ---\n${getOutput()}`));
    const timer = setTimeout(
      () => fail(`timed out waiting for merchant output to include "${match}"`),
      timeoutMs,
    );
    child.stdout.on("data", (chunk: Buffer) => {
      buf += chunk.toString();
      if (buf.includes(match)) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      fail(`merchant exited early (code ${code}) before printing "${match}"`);
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
    await waitForStdout(merchant, "Merchant listening", () => output);
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
  await withMerchant(4086, STUB_ENV, async ({ url, output }) => {
    const key = randomPrivateKey();
    for (let i = 0; i < 3; i++) {
      const result = await runClient({ PRIVATE_KEY: key, MERCHANT_URL: url, RPC_URL: "" });
      assertPaid(result, `payment ${i + 1}`);
    }
    // Each run names a new purchase, so these are three distinct payments — not one
    // payment re-served three times.
    assert.doesNotMatch(
      output(),
      /already fulfilled/,
      `distinct purchases must not collapse onto one payment:\n${output()}`,
    );
  });
});

test("a still-settling payment is collected by the payer's re-attempt", async () => {
  // The stub reports the first attempt as still settling, as the facilitator does when
  // cross-chain settlement outruns the gateway's ~30s synchronous window.
  await withMerchant(4084, { ...STUB_ENV, STUB_PENDING_ATTEMPTS: "1" }, async ({ url, output }) => {
    const result = await runClient({ PRIVATE_KEY: randomPrivateKey(), MERCHANT_URL: url, RPC_URL: "" });
    assertPaid(result, "client");
    assert.match(
      output(),
      /402: still settling \(payment pay_stub_[0-9a-f]+\) — awaiting the payer's re-attempt/,
      `expected the merchant to report pending with its payment id:\n${output()}`,
    );
  });
});

test("re-attempting a fulfilled purchase re-serves it instead of delivering twice", async () => {
  await withMerchant(4083, STUB_ENV, async ({ url, output }) => {
    // The same purchase paid twice — what a payer does when it never received the first
    // 200, and what happens when one identifier is reused across two purchases. Both
    // resolve to one payment, so the merchant must deliver once.
    const purchaseId = "order_fulfilled_once_0001";
    const key = randomPrivateKey();
    for (const label of ["first", "re-attempt"]) {
      const result = await runClient({
        PRIVATE_KEY: key,
        MERCHANT_URL: url,
        RPC_URL: "",
        PURCHASE_ID: purchaseId,
      });
      assertPaid(result, label);
    }
    assert.match(
      output(),
      /already fulfilled — re-serving, not a new sale/,
      `expected the second attempt to be recognised as already fulfilled:\n${output()}`,
    );
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

// Cross-chain settlement runs in child processes whose logs are captured (not echoed),
// so the terminal would otherwise look frozen for 30s+. Print elapsed seconds while we
// wait, so it's clear the run is still progressing rather than hung.
async function withHeartbeat<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const start = Date.now();
  process.stdout.write(`  ⏳ ${label}: settling on-chain…\n`);
  const timer = setInterval(() => {
    process.stdout.write(`  ⏳ ${label}: still settling — ${Math.round((Date.now() - start) / 1000)}s elapsed\n`);
  }, 10_000);
  timer.unref?.();
  try {
    return await fn();
  } finally {
    clearInterval(timer);
  }
}

// Human labels for the shipped corridor, so the final report reads as chains/tokens
// rather than raw CAIP-2 ids. Falls back to the raw value for anything not listed.
const CHAIN_NAMES: Record<string, string> = {
  "eip155:84532": "Base Sepolia",
  "eip155:42431": "Tempo (Moderato)",
};
const ASSET_NAMES: Record<string, string> = {
  "0x036cbd53842c5426634e7929541ec2318f3dcf7e": "USDC",
  "0x20c0000000000000000000000000000000000000": "pathUSD",
};
function endpointLabel(network: string, asset: string): string {
  return `${CHAIN_NAMES[network] ?? network} ${ASSET_NAMES[asset.toLowerCase()] ?? asset}`;
}

// A settlement direction. The shipped corridor is bidirectional (Base ↔ Tempo): the
// forward leg is what most integrators run first; the reverse leg proves the ↔.
interface Direction {
  label: string;
  sourceNetwork: string;
  sourceAsset: string;
  destNetwork: string;
  destAsset: string;
  rpcUrl?: string; // source-chain RPC for the client's Permit2 approval (optional)
}

const FORWARD: Direction = {
  label: "Base Sepolia → Tempo (Moderato)",
  sourceNetwork: "eip155:84532",
  sourceAsset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  destNetwork: "eip155:42431",
  destAsset: "0x20c0000000000000000000000000000000000000",
  rpcUrl: process.env.RPC_URL ?? "https://sepolia.base.org",
};

// Reverse pays FROM Tempo, so the payer must be funded on Tempo (pathUSD — which also
// covers gas, since Tempo has no native gas token). The source-chain RPC for the Permit2
// approval defaults to the public Moderato endpoint; override with REVERSE_RPC_URL.
// Runs by default in a funded run; set SKIP_REVERSE=1 to skip it.
const REVERSE: Direction = {
  label: "Tempo (Moderato) → Base Sepolia",
  sourceNetwork: "eip155:42431",
  sourceAsset: "0x20c0000000000000000000000000000000000000",
  destNetwork: "eip155:84532",
  destAsset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  rpcUrl: process.env.REVERSE_RPC_URL ?? "https://rpc.moderato.tempo.xyz",
};

// Final "what settled where" summary, pulled from the merchant's own settlement log.
function printSettlementReport(protocol: string, dir: Direction, merchantLog: string): void {
  const amount = process.env.FULFILLMENT_AMOUNT ?? "50000";
  const dest = process.env.DEST_ADDRESS ?? "(unset)";
  const deposit = merchantLog.match(/source deposit:\s*(\S+)/)?.[1];
  const payout = merchantLog.match(/destination payout:\s*(\S+)/)?.[1];
  // x402's /settle often reports only the fulfillment (settlement) tx, not a separate
  // source-deposit hash — surface whichever legs the facilitator named, as clickable links.
  const settlementTx = merchantLog.match(/settlement tx:\s*(\S+)/)?.[1];
  const bar = "─".repeat(72);
  const txLines = [
    deposit ? `     source deposit:      ${deposit}` : "",
    payout ? `     destination payout:  ${payout}` : "",
    !deposit && !payout && settlementTx ? `     settlement tx:       ${settlementTx}` : "",
    !deposit && !payout && !settlementTx ? `     transactions:        (see merchant log above)` : "",
  ]
    .filter(Boolean)
    .join("\n");
  process.stdout.write(
    `\n${bar}\n` +
      `  ✅ ${protocol} — SETTLED (${dir.label})\n` +
      `     corridor:            ${endpointLabel(dir.sourceNetwork, dir.sourceAsset)}  →  ${endpointLabel(dir.destNetwork, dir.destAsset)}\n` +
      `     expected amount:     ${amount} (atomic) to ${dest}  — confirm on-chain below\n` +
      `${txLines}\n` +
      `${bar}\n\n`,
  );
}

async function runRealSettlement(dir: Direction, port: number): Promise<void> {
  const privateKey = process.env.PRIVATE_KEY as string;
  const merchantEnv: Record<string, string> = {
    USE_STUB_FACILITATOR: "false",
    DEST_ADDRESS: process.env.DEST_ADDRESS ?? "",
    SOURCE_NETWORK: dir.sourceNetwork,
    SOURCE_ASSET: dir.sourceAsset,
    DEST_NETWORK: dir.destNetwork,
    DEST_ASSET: dir.destAsset,
  };
  if (process.env.FACILITATOR_URL) merchantEnv.FACILITATOR_URL = process.env.FACILITATOR_URL;
  if (process.env.GATEWAY_URL) merchantEnv.GATEWAY_URL = process.env.GATEWAY_URL;

  await withMerchant(port, merchantEnv, async ({ url, output }) => {
    // Set RPC_URL explicitly (empty when the direction has none) so a value exported for
    // the other direction can't leak in and point the approval at the wrong chain.
    const result = await withHeartbeat(`x402 real settlement (${dir.label})`, () =>
      runClient({ PRIVATE_KEY: privateKey, MERCHANT_URL: url, RPC_URL: dir.rpcUrl ?? "" }),
    );

    const paid = result.exitCode === 0 && /Status: 200/.test(result.output) && /Access granted/.test(result.output);
    if (paid) {
      // Real settlement confirmed — make sure it wasn't the stub.
      const merchantLog = output();
      assert.doesNotMatch(merchantLog, /stub/i, `real e2e must not settle via the stub:\n${merchantLog}`);
      assert.match(merchantLog, /→ 200: settled\b/, `expected a settled 200 in the merchant log:\n${merchantLog}`);
      assert.match(merchantLog, /(source deposit|destination payout|settlement tx):\s+\S*0x[0-9a-fA-F]{64}/, `expected a real settlement tx in the merchant log:\n${merchantLog}`);
      printSettlementReport("x402", dir, merchantLog);
      return;
    }

    // A settlement slower than the gateway's synchronous window is not a failure and is
    // not a special case here: the client re-attempts the same purchase until it reaches
    // a terminal outcome. Only exhausting those attempts lands here, and it means the
    // payment is still in flight rather than lost.
    if (/still settling after/.test(result.output)) {
      assert.fail(
        "the payment was accepted but had not settled after the client's re-attempts. It is not " +
          "lost: re-run this purchase under the same identifier to collect its outcome " +
          `(the client printed it).\n\nClient output:\n${result.output}`,
      );
    }

    // Anything else is a genuine failure — surface it in full.
    assertPaid(result, "real client");
  });
}

// The corridor is bidirectional, so a funded run settles BOTH ways by default. The
// reverse leg spends on Tempo (pathUSD, which also covers gas), so the payer must be
// funded there too; set SKIP_REVERSE=1 to limit a run to the forward (Base → Tempo) leg.
const reverseSkip = !REAL_E2E_ENABLED
  ? "set RUN_REAL_E2E=1 and PRIVATE_KEY to run"
  : process.env.SKIP_REVERSE === "1"
    ? "reverse leg disabled (SKIP_REVERSE=1)"
    : false;

test(
  "real e2e: settles a real Base → Tempo payment against the hosted facilitator",
  { skip: REAL_E2E_ENABLED ? false : "set RUN_REAL_E2E=1 and PRIVATE_KEY to run" },
  () => runRealSettlement(FORWARD, 4089),
);

test(
  "real e2e (reverse): settles a real Tempo → Base payment against the hosted facilitator",
  { skip: reverseSkip },
  () => runRealSettlement(REVERSE, 4090),
);
