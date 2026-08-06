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
  getOutput: () => string,
  timeoutMs = 15_000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    // Accumulate before matching: a split write can land "MPP merchant" and
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
    await waitForStdout(merchant, "MPP merchant listening", () => output);
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
  await withMerchant(4096, STUB_ENV, async ({ url, output }) => {
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
  // The stub reports the first attempt as still settling, as the gateway does when
  // cross-chain settlement outruns its ~30s synchronous window.
  await withMerchant(4094, { ...STUB_ENV, STUB_PENDING_ATTEMPTS: "1" }, async ({ url, output }) => {
    const result = await runClient({ PRIVATE_KEY: randomPrivateKey(), MERCHANT_URL: url, RPC_URL: "" });
    assertPaid(result, "client");
    assert.match(
      result.output,
      /still settling \(payment pay_stub_[0-9a-f]+\)/,
      `expected the payer to report the pending attempt:\n${result.output}`,
    );
    // The merchant must NOT hold the request open waiting for settlement.
    assert.match(
      output(),
      /accepted, still settling — the payer's re-attempt/,
      `expected the merchant to return pending rather than wait:\n${output()}`,
    );
  });
});

test("re-attempting a fulfilled purchase re-serves it instead of delivering twice", async () => {
  await withMerchant(4093, STUB_ENV, async ({ url, output }) => {
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
      /was already fulfilled — re-serving, not a new sale/,
      `expected the second attempt to be recognised as already fulfilled:\n${output()}`,
    );
  });
});

test("refuses a request that does not name the purchase", async () => {
  await withMerchant(4092, STUB_ENV, async ({ url }) => {
    // Without an identifier the challenge carries no payment identity, the payer's client
    // refuses to sign, and a retry could not be told from a second payment.
    const res = await fetch(url);
    assert.equal(res.status, 400, "a request with no purchase in the URL must be refused");
    const body = (await res.json()) as { error?: string };
    assert.match(String(body.error), /Name the purchase in the URL/);
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

test("refuses to start in real-settlement mode without a valid DEST_ADDRESS", async () => {
  // A real (non-placeholder) secret so the secret guard passes and the DEST_ADDRESS
  // guard is the one under test. DEST_ADDRESS is the .env.example placeholder.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DOTENV_CONFIG_PATH: NO_DOTENV,
    PORT: "4094",
    USE_STUB_SUBMITTER: "false",
    MPP_SECRET_KEY: randomBytes(32).toString("hex"),
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
  assert.match(output, /DEST_ADDRESS/, `expected the DEST_ADDRESS guard specifically:\n${output}`);
});

// --- real end-to-end (opt-in; moves real testnet funds) --------------------
//
// Runs only when RUN_REAL_E2E=1 and a funded PRIVATE_KEY is set. It settles a real
// Base -> Tempo payment through the hosted gateway and asserts the merchant logged a
// real settlement — failing loudly if it sees the stub payment id, so it can never
// give a false pass. MPP has no separate facilitator: the merchant verifies and submits
// in-process, and when settlement outruns the gateway's synchronous window the payer's
// re-attempt at the same purchase is what collects the result.
//
// A fresh MPP_SECRET_KEY is generated per run (any private >= 32-byte secret works —
// the same merchant issues and verifies the challenge). Optional overrides:
// GATEWAY_URL, RPC_URL (defaults to Base Sepolia), FULFILLMENT_DEADLINE_SECONDS.
const REAL_E2E_ENABLED = process.env.RUN_REAL_E2E === "1" && !!process.env.PRIVATE_KEY;

// A real cross-chain run can take 60–120s, spread across the payer's re-attempts. Those
// run in a child process whose logs are captured (not echoed), so print elapsed seconds
// while we wait — otherwise the terminal looks frozen.
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
/**
 * How many attempts the payer needed, read from its own log, plus the pending lines when it
 * took more than one. A settlement that outruns the gateway's synchronous window is
 * collected by re-attempting the purchase — without this the run just looks slow, and the
 * retry that did the work is invisible.
 */
function attemptSummary(clientLog: string): string {
  const attempts = Number(clientLog.match(/settled after (\d+) attempt\(s\)/)?.[1] ?? "1");
  if (attempts <= 1) return `     attempts:            1 (settled inside the gateway's synchronous window)\n`;
  const pending = clientLog
    .split("\n")
    .filter((line) => line.includes("still settling"))
    .map((line) => `       ${line.trim()}\n`)
    .join("");
  return (
    `     attempts:            ${attempts} (settlement outran the ~30s window; the re-attempt collected it)\n` +
    pending
  );
}

function printSettlementReport(protocol: string, dir: Direction, merchantLog: string, clientLog: string): void {
  const amount = process.env.FULFILLMENT_AMOUNT ?? "50000";
  const dest = process.env.DEST_ADDRESS ?? "(unset)";
  const paymentId = merchantLog.match(/settled payment (\S+)/)?.[1];
  const deposit = merchantLog.match(/source deposit:\s*(\S+)/)?.[1] ?? "(see merchant log)";
  const payout = merchantLog.match(/destination payout:\s*(\S+)/)?.[1];
  const bar = "─".repeat(72);
  process.stdout.write(
    `\n${bar}\n` +
      `  ✅ ${protocol} — REAL SETTLEMENT CONFIRMED (${dir.label})\n` +
      (paymentId ? `     payment id:          ${paymentId}\n` : "") +
      `     corridor:            ${endpointLabel(dir.sourceNetwork, dir.sourceAsset)}  →  ${endpointLabel(dir.destNetwork, dir.destAsset)}\n` +
      attemptSummary(clientLog) +
      `     amount:              ${amount} (atomic) paid to ${dest}\n` +
      `     source deposit:      ${deposit}\n` +
      (payout ? `     destination payout:  ${payout}\n` : "") +
      `${bar}\n\n`,
  );
}

async function runRealSettlement(dir: Direction, port: number): Promise<void> {
  const privateKey = process.env.PRIVATE_KEY as string;
  const merchantEnv: Record<string, string> = {
    USE_STUB_SUBMITTER: "false",
    DEST_ADDRESS: process.env.DEST_ADDRESS ?? "",
    SOURCE_NETWORK: dir.sourceNetwork,
    SOURCE_ASSET: dir.sourceAsset,
    DEST_NETWORK: dir.destNetwork,
    DEST_ASSET: dir.destAsset,
    // A real, private secret so the placeholder-secret guard passes.
    MPP_SECRET_KEY: process.env.MPP_SECRET_KEY ?? randomBytes(32).toString("hex"),
  };
  if (process.env.GATEWAY_URL) merchantEnv.GATEWAY_URL = process.env.GATEWAY_URL;
  if (process.env.FULFILLMENT_DEADLINE_SECONDS)
    merchantEnv.FULFILLMENT_DEADLINE_SECONDS = process.env.FULFILLMENT_DEADLINE_SECONDS;

  await withMerchant(port, merchantEnv, async ({ url, output }) => {
    // Set RPC_URL explicitly (empty when the direction has none) so a value exported for
    // the other direction can't leak in and point the approval at the wrong chain.
    const result = await withHeartbeat(`MPP real settlement (${dir.label})`, () =>
      runClient({ PRIVATE_KEY: privateKey, MERCHANT_URL: url, RPC_URL: dir.rpcUrl ?? "" }),
    );

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
    printSettlementReport("MPP", dir, merchantLog, result.output);
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
  "real e2e: settles a real Base → Tempo payment through the gateway",
  { skip: REAL_E2E_ENABLED ? false : "set RUN_REAL_E2E=1 and PRIVATE_KEY to run" },
  () => runRealSettlement(FORWARD, 4099),
);

test(
  "real e2e (reverse): settles a real Tempo → Base payment through the gateway",
  { skip: reverseSkip },
  () => runRealSettlement(REVERSE, 4100),
);
