/*
 * Copyright (c) 2026 Atum Labs, Inc.
 * SPDX-License-Identifier: MIT
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { readFileSync } from "node:fs";
import net from "node:net";
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

// Written from inside the merchant's listen callback, so it appears only once this
// process owns this exact port.
const merchantListening = (port: number) =>
  new RegExp(`merchant listening on http://localhost:${port}\\b`, "i");

// A connect is the only portable way to ask whether anything already holds the port
// without binding it.
function portAnswers(port: number, timeoutMs = 2_000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(port);
    const settle = (answered: boolean) => {
      socket.destroy();
      resolve(answered);
    };
    // A filtered port answers neither way, and destroying emits `close` rather than
    // `error`, so the timeout has to settle this itself.
    socket.setTimeout(timeoutMs, () => settle(false));
    socket.once("connect", () => settle(true));
    socket.once("error", () => settle(false));
  });
}

// Ready is "our merchant is accepting on its port", which the banner above proves and a
// bare connection cannot.
function waitForListening(
  child: ChildProcess,
  port: number,
  getOutput: () => string,
  // Boot covers a cold tsx transform of the ~800KB SDK bundle and, in real mode, a
  // gateway /defaults round-trip — about 7s unloaded, and a CI runner is not unloaded.
  timeoutMs = Number(process.env.MERCHANT_BOOT_TIMEOUT_MS ?? 45_000),
): Promise<void> {
  return new Promise((resolve, reject) => {
    let done = false;
    // Surface what the merchant actually printed — a bad GATEWAY_URL, a busy
    // port, or an invalid amount all exit early, and the reason is in its output.
    const fail = (why: string) =>
      reject(new Error(`${why}\n--- merchant output ---\n${getOutput()}`));
    const finish = () => {
      done = true;
      clearTimeout(timer);
      child.removeListener("exit", onExit);
      child.removeListener("error", onError);
    };
    const timer = setTimeout(() => {
      finish();
      fail(
        `timed out after ${timeoutMs}ms waiting for the merchant to listen on port ${port} ` +
          `(raise MERCHANT_BOOT_TIMEOUT_MS)`,
      );
    }, timeoutMs);
    // A merchant that dies fails the test immediately rather than at the timeout. A spawn
    // that never ran emits `error` instead of `exit`.
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      finish();
      fail(`merchant exited early (${signal ? `killed by ${signal}` : `code ${code}`}) without listening`);
    };
    const onError = (err: Error) => {
      finish();
      fail(`merchant failed to spawn: ${err.message}`);
    };
    child.once("exit", onExit);
    child.once("error", onError);
    const probe = async (): Promise<void> => {
      if (done) return;
      const answered = await portAnswers(port);
      if (answered && merchantListening(port).test(getOutput())) {
        finish();
        resolve();
        return;
      }
      if (!done) setTimeout(() => void probe(), 100);
    };
    void probe();
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
  // Fail in milliseconds with something actionable: the boot wait would otherwise burn
  // its whole budget waiting for a banner that can never arrive.
  if (await portAnswers(port)) {
    throw new Error(
      `port ${port} is already in use — stop the process holding it (find it with lsof -ti:${port})`,
    );
  }

  const merchant = spawn(tsxBin(MERCHANT_DIR), ["src/merchant.ts"], {
    cwd: MERCHANT_DIR,
    env: { ...process.env, DOTENV_CONFIG_PATH: NO_DOTENV, PORT: String(port), ...env },
  });
  let output = "";
  merchant.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
  merchant.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
  // A child with no `error` listener turns any later failure into an uncaught exception
  // that ends the whole run, and the boot handlers detach once boot is done.
  merchant.on("error", () => {});

  try {
    await waitForListening(merchant, port, () => output);
    const body = fn({ url: `http://localhost:${port}/paid`, output: () => output });
    // If the merchant dies while the body runs, fail with its output rather than leaving
    // the body to hit a bare connection error with nothing to explain it.
    const died = new Promise<never>((_, reject) =>
      merchant.once("exit", (code, signal) =>
        reject(
          new Error(
            `merchant exited during the test (${signal ? `killed by ${signal}` : `code ${code}`}):\n${output}`,
          ),
        ),
      ),
    );
    try {
      await Promise.race([body, died]);
    } finally {
      // A death wins that race with the body still in flight; wait for it so the clients
      // it spawned cannot leak into the next test.
      await body.catch(() => {});
    }
  } finally {
    merchant.kill();
  }
}

function assertPaid(result: RunResult, label: string): void {
  assert.equal(result.exitCode, 0, `${label} exited non-zero:\n${result.output}`);
  assert.match(result.output, /Status: 200/, `${label} expected a 200 response:\n${result.output}`);
  assert.match(result.output, /Access granted/, `${label} expected the resource body:\n${result.output}`);
}

// The banner is the ownership proof, so a reworded log line must fail here in
// milliseconds rather than as a boot timeout in every other test.
test("the readiness pattern still matches the merchant's own banner", () => {
  const source = readFileSync(path.join(MERCHANT_DIR, "src", "merchant.ts"), "utf8");
  assert.match(
    source,
    /merchant listening on http:\/\/localhost:\$\{PORT\}/i,
    "the merchant's listening banner is what withMerchant waits for",
  );
});

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

// The corridor is configurable (see FORWARD/REVERSE below), but the only tests that
// exercise it settle real funds and are opt-in — so a wiring mistake in it would reach
// a funded run before anything caught it. This test closes that gap with no funds and
// no chain: a sentinel corridor goes in, and the same sentinel must come back out of
// the 402 the merchant issues. Stub mode contacts no gateway, so it runs anywhere.
test("corridor overrides reach the 402 the merchant issues", async () => {
  // Deliberately not any real chain or token: if the override were ignored, the
  // assertions would report the shipped default rather than a plausible-looking value.
  const SOURCE_NETWORK = "eip155:999001";
  const SOURCE_ASSET = "0x00000000000000000000000000000000000000a1";
  const DEST_NETWORK = "eip155:999002";
  const DEST_ASSET = "0x00000000000000000000000000000000000000b2";

  await withMerchant(
    4082,
    { ...STUB_ENV, SOURCE_NETWORK, SOURCE_ASSET, DEST_NETWORK, DEST_ASSET },
    async ({ url }) => {
      const res = await fetch(url);
      assert.equal(res.status, 402, "an unpaid request must be answered with a challenge");

      // The 402 mirrors its PAYMENT-REQUIRED header in the body, so the body is the
      // readable way to assert on what was offered.
      const challenge = (await res.json()) as {
        accepts?: {
          network?: string;
          asset?: string;
          extra?: { atum?: { destination?: { network?: string; asset?: string } } };
        }[];
      };
      const offer = challenge.accepts?.[0];
      const shown = JSON.stringify(challenge, null, 2);

      assert.equal(offer?.network, SOURCE_NETWORK, `the 402 must name the overridden source network:\n${shown}`);
      assert.equal(offer?.asset, SOURCE_ASSET, `the 402 must name the overridden source asset:\n${shown}`);
      const destination = offer?.extra?.atum?.destination;
      assert.equal(destination?.network, DEST_NETWORK, `the 402 must name the overridden destination network:\n${shown}`);
      assert.equal(destination?.asset, DEST_ASSET, `the 402 must name the overridden destination asset:\n${shown}`);
    },
  );
});

// --- real end-to-end (opt-in; moves real testnet funds) --------------------
//
// Runs only when RUN_REAL_E2E=1 and a funded PRIVATE_KEY is set. It settles a real
// payment against the hosted facilitator + gateway and asserts the merchant logged a
// real settlement tx — failing loudly if it sees the stub marker, so it can never
// give a false pass.
//
// Optional overrides: FACILITATOR_URL, GATEWAY_URL, DEST_ADDRESS; the corridor itself
// (SOURCE_NETWORK, SOURCE_ASSET, DEST_NETWORK, DEST_ASSET); and the per-direction
// source RPCs RPC_URL / REVERSE_RPC_URL (default to the shipped corridor's chains).
//
// All of them are read from the EXPORTED ENVIRONMENT, not from .env. Every process
// this file spawns is deliberately pointed at a nonexistent dotenv path (NO_DOTENV
// above) so the suite stays hermetic — which also means .env cannot reach it. `.env`
// repoints the merchant you run by hand (`npm run dev`); export these in your shell
// to repoint the test.
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

// Human labels for the corridor, so the final report reads as chains/tokens rather
// than raw CAIP-2 ids. Falls back to the raw value for anything not listed, so an
// unlisted chain still reports honestly — just less readably.
const CHAIN_NAMES: Record<string, string> = {
  "eip155:84532": "Base Sepolia",
  "eip155:42431": "Tempo (Moderato)",
  // Mainnet ids are listed too, so a corridor repointed at mainnet still reads as
  // chains and tokens rather than raw ids.
  "eip155:8453": "Base",
  "eip155:4217": "Tempo",
};
// Keys are lowercase — endpointLabel lowercases before looking up, so a checksummed
// address and a lowercase one resolve to the same name.
const ASSET_NAMES: Record<string, string> = {
  "0x036cbd53842c5426634e7929541ec2318f3dcf7e": "USDC", // Base Sepolia
  "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": "USDC", // Base mainnet
  "0x20c0000000000000000000000000000000000000": "pathUSD", // Tempo (both networks)
};
function endpointLabel(network: string, asset: string): string {
  return `${CHAIN_NAMES[network] ?? network} ${ASSET_NAMES[asset.toLowerCase()] ?? asset}`;
}

// A settlement direction. The shipped corridor is bidirectional (Base ↔ Tempo): the
// forward leg is what most integrators run first; the reverse leg proves the ↔.
interface Direction {
  sourceNetwork: string;
  sourceAsset: string;
  destNetwork: string;
  destAsset: string;
  rpcUrl?: string; // source-chain RPC for the client's Permit2 approval (optional)
}

// The corridor's label is DERIVED, never stored. A stored string keeps saying
// "Base Sepolia → Tempo" after an override repoints the corridor, and this label is
// what the settlement report prints as evidence — a report naming a corridor it did
// not settle is worse than no report at all.
function corridorLabel(dir: Direction): string {
  return `${endpointLabel(dir.sourceNetwork, dir.sourceAsset)} → ${endpointLabel(dir.destNetwork, dir.destAsset)}`;
}

// Identify an RPC endpoint by origin only. A provider URL commonly carries an API key
// in its path or query, and this is printed to stdout — where a CI job would archive it.
function rpcOrigin(url: string | undefined): string {
  if (!url) return "(none)";
  try {
    return new URL(url).origin;
  } catch {
    return "(malformed URL)";
  }
}

// Corridor overrides, read from the exported environment (see the note above).
//
// `??` alone would accept an exported-but-empty variable — `export SOURCE_NETWORK=`,
// an empty CI matrix cell, a `set -a` wrapper — as a real value and carry "" into the
// merchant's /defaults lookup, where it fails with nothing pointing back to the cause.
// Trim, and treat empty as "not set".
//
// Deliberately NOT used for the rpcUrl fields below: there, "" is a MEANINGFUL value
// ("this direction has no chain to approve on") that the stub tests depend on.
const corridorEnv = (name: string, fallback: string): string =>
  process.env[name]?.trim() || fallback;

// Source of truth for these four defaults is src/merchant.ts (SOURCE_NETWORK …
// DEST_ASSET) — same env var names, same values. Keep the two in sync, and .env.example
// with them; nothing asserts it automatically.
const FORWARD: Direction = {
  sourceNetwork: corridorEnv("SOURCE_NETWORK", "eip155:84532"),
  sourceAsset: corridorEnv("SOURCE_ASSET", "0x036CbD53842c5426634e7929541eC2318f3dCF7e"),
  destNetwork: corridorEnv("DEST_NETWORK", "eip155:42431"),
  destAsset: corridorEnv("DEST_ASSET", "0x20c0000000000000000000000000000000000000"),
  rpcUrl: process.env.RPC_URL ?? "https://sepolia.base.org",
};

// The reverse leg spends FROM the destination endpoint — so it mirrors the corridor
// rather than getting its own four variables, and the payer must be funded on whatever
// chain that is, including for gas (unless that chain's token covers gas, as Tempo's
// pathUSD does). Its source-chain RPC for the Permit2 approval defaults to the shipped
// corridor's destination chain; override with REVERSE_RPC_URL.
// Runs by default in a funded run; set SKIP_REVERSE=1 to skip it.
const REVERSE: Direction = {
  sourceNetwork: corridorEnv("DEST_NETWORK", "eip155:42431"),
  sourceAsset: corridorEnv("DEST_ASSET", "0x20c0000000000000000000000000000000000000"),
  destNetwork: corridorEnv("SOURCE_NETWORK", "eip155:84532"),
  destAsset: corridorEnv("SOURCE_ASSET", "0x036CbD53842c5426634e7929541eC2318f3dCF7e"),
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
      `  ✅ ${protocol} — SETTLED\n` +
      `     corridor:            ${corridorLabel(dir)}\n` +
      attemptSummary(clientLog) +
      `     expected amount:     ${amount} (atomic) to ${dest}  — confirm on-chain below\n` +
      `${txLines}\n` +
      `${bar}\n\n`,
  );
}

async function runRealSettlement(dir: Direction, port: number): Promise<void> {
  const privateKey = process.env.PRIVATE_KEY as string;

  // Print the corridor BEFORE anything can fail. Otherwise it appears only in the
  // success report — so the run that most needs it, a misconfigured override that
  // never settles, is the one that never shows what it was trying to settle.
  process.stdout.write(
    `  → corridor: ${corridorLabel(dir)}  ·  source RPC: ${rpcOrigin(dir.rpcUrl)}\n`,
  );

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
    const result = await withHeartbeat(`x402 real settlement (${corridorLabel(dir)})`, () =>
      runClient({ PRIVATE_KEY: privateKey, MERCHANT_URL: url, RPC_URL: dir.rpcUrl ?? "" }),
    );

    const paid = result.exitCode === 0 && /Status: 200/.test(result.output) && /Access granted/.test(result.output);
    if (paid) {
      // Real settlement confirmed — make sure it wasn't the stub.
      const merchantLog = output();
      assert.doesNotMatch(merchantLog, /stub/i, `real e2e must not settle via the stub:\n${merchantLog}`);
      assert.match(merchantLog, /→ 200: settled\b/, `expected a settled 200 in the merchant log:\n${merchantLog}`);
      assert.match(merchantLog, /(source deposit|destination payout|settlement tx):\s+\S*0x[0-9a-fA-F]{64}/, `expected a real settlement tx in the merchant log:\n${merchantLog}`);
      printSettlementReport("x402", dir, merchantLog, result.output);
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
// reverse leg spends from the destination endpoint, so the payer must be funded there
// too; set SKIP_REVERSE=1 to limit a run to the forward leg.
const reverseSkip = !REAL_E2E_ENABLED
  ? "set RUN_REAL_E2E=1 and PRIVATE_KEY to run"
  : process.env.SKIP_REVERSE === "1"
    ? "reverse leg disabled (SKIP_REVERSE=1)"
    : false;

// The test names say which LEG, not which chains: the corridor is a runtime input now,
// and it is reported by the corridor line each leg prints as it starts.
test(
  "real e2e (forward): settles a real payment against the hosted facilitator",
  { skip: REAL_E2E_ENABLED ? false : "set RUN_REAL_E2E=1 and PRIVATE_KEY to run" },
  () => runRealSettlement(FORWARD, 4089),
);

test(
  "real e2e (reverse): settles a real payment back along the same corridor",
  { skip: reverseSkip },
  () => runRealSettlement(REVERSE, 4090),
);
