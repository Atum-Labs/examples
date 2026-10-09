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
import http from "node:http";
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
  // gateway /v1/defaults round-trip — about 7s unloaded, and a CI runner is not unloaded.
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
  // Capture both streams: the real-settlement test asserts on the merchant's log
  // (the on-chain settlement lines), and reading stderr stops a slow consumer from
  // back-pressuring the child.
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

function assertPaid(result: { exitCode: number; output: string }, label: string): void {
  assert.equal(result.exitCode, 0, `${label} exited non-zero:\n${result.output}`);
  assert.match(result.output, /Status: 200/, `${label} expected a 200 response:\n${result.output}`);
  assert.match(
    result.output,
    /Payment-Receipt header: present/,
    `${label} expected a Payment-Receipt header:\n${result.output}`,
  );
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

// --- stub flow (no gateway or funds) ---------------------------------------

const STUB_ENV = { USE_STUB_SUBMITTER: "true" };

// The stub corridor exists nowhere but in the stub merchant, which answers /v1/defaults
// for it at its own origin — so that origin is the trust source a stub-mode payer checks
// the challenge against.
function stubGateway(merchantUrl: string): string {
  return new URL(merchantUrl).origin;
}

test("stub flow: 402 -> pay -> 200 with a receipt", async () => {
  await withMerchant(4098, STUB_ENV, async ({ url }) => {
    const result = await runClient({
      PRIVATE_KEY: randomPrivateKey(),
      MERCHANT_URL: url,
      RPC_URL: "",
      GATEWAY_URL: stubGateway(url),
    });
    assertPaid(result, "client");
  });
});

test("concurrent payments from different wallets all succeed", async () => {
  await withMerchant(4097, STUB_ENV, async ({ url }) => {
    const CLIENT_COUNT = 5;
    const results = await Promise.all(
      Array.from({ length: CLIENT_COUNT }, () =>
        runClient({
          PRIVATE_KEY: randomPrivateKey(),
          MERCHANT_URL: url,
          RPC_URL: "",
          GATEWAY_URL: stubGateway(url),
        }),
      ),
    );
    results.forEach((result, i) => assertPaid(result, `client ${i}`));
  });
});

test("the same wallet can complete multiple independent payments in sequence", async () => {
  await withMerchant(4096, STUB_ENV, async ({ url, output }) => {
    const key = randomPrivateKey();
    for (let i = 0; i < 3; i++) {
      const result = await runClient({
        PRIVATE_KEY: key,
        MERCHANT_URL: url,
        RPC_URL: "",
        GATEWAY_URL: stubGateway(url),
      });
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
    const result = await runClient({
      PRIVATE_KEY: randomPrivateKey(),
      MERCHANT_URL: url,
      RPC_URL: "",
      GATEWAY_URL: stubGateway(url),
    });
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
        GATEWAY_URL: stubGateway(url),
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

// The corridor is configurable (see FORWARD/REVERSE below), but the only tests that
// exercise it settle real funds and are opt-in — so a wiring mistake in it would reach
// a funded run before anything caught it. This test closes that gap with no funds and
// no chain: a sentinel corridor goes in, and the same sentinel must come back out of
// the challenge the merchant issues. Stub mode contacts no gateway, so it runs anywhere.
test("corridor overrides reach the challenge the merchant issues", async () => {
  // Deliberately not any real chain or token: if the override were ignored, the
  // assertions would report the shipped default rather than a plausible-looking value.
  const SOURCE_NETWORK = "eip155:999001";
  const SOURCE_ASSET = "0x00000000000000000000000000000000000000a1";
  const DEST_NETWORK = "eip155:999002";
  const DEST_ASSET = "0x00000000000000000000000000000000000000b2";

  await withMerchant(
    4091,
    { ...STUB_ENV, SOURCE_NETWORK, SOURCE_ASSET, DEST_NETWORK, DEST_ASSET },
    async ({ url }) => {
      const res = await fetch(`${url}/order_corridor_override_0001`);
      assert.equal(res.status, 402, "an unpaid request must be answered with a challenge");

      // MPP carries the challenge in WWW-Authenticate; its `request` param is the
      // base64-encoded payment request, which is where the corridor lives.
      const header = res.headers.get("www-authenticate") ?? "";
      const encoded = header.match(/request="([^"]+)"/)?.[1];
      assert.ok(encoded, `the 402 must carry a challenge request:\n${header}`);
      const request = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as {
        source?: { network?: string; asset?: string };
        extra?: { destination?: { network?: string; asset?: string } };
      };
      const shown = JSON.stringify(request, null, 2);

      assert.equal(request.source?.network, SOURCE_NETWORK, `the challenge must name the overridden source network:\n${shown}`);
      assert.equal(request.source?.asset, SOURCE_ASSET, `the challenge must name the overridden source asset:\n${shown}`);
      const destination = request.extra?.destination;
      assert.equal(destination?.network, DEST_NETWORK, `the challenge must name the overridden destination network:\n${shown}`);
      assert.equal(destination?.asset, DEST_ASSET, `the challenge must name the overridden destination asset:\n${shown}`);
    },
  );
});

// --- stub gateway defaults --------------------------------------------------
//
// In stub mode the merchant's placeholder corridor exists nowhere but in the merchant,
// so a payer that cross-checks a 402 against Atum's gateway has nothing real to ask.
// The stub merchant therefore answers /v1/defaults for its own corridor. What it says
// must agree with the challenge it issues field for field — a disagreement would teach a
// payer to distrust a correct challenge, or worse, to trust a wrong one.

interface StubChallengeRequest {
  source: { network: string; asset: string; amount: string };
  extra: {
    escrow: string;
    reserver: string;
    releaser: string;
    fulfillmentVerifierEndpoint: string;
    fulfillmentProxy: string;
    destination: { network: string; asset: string; address: string };
  };
}

interface GatewayDefaults {
  chain_id: string;
  escrow_contract: string;
  quote_selector: string;
  fulfillment_proxy: string;
  fulfillment_verifier: { account: string; endpoint: string };
  tokens: { symbol: string; address: string; decimals: number }[];
}

// WWW-Authenticate is what an MPP payer actually reads, so the comparison is made
// against the request decoded from it.
async function fetchChallenge(url: string): Promise<StubChallengeRequest> {
  const res = await fetch(`${url}/order_stub_defaults_0001`);
  assert.equal(res.status, 402, "an unpaid request must be answered with a challenge");
  const header = res.headers.get("www-authenticate") ?? "";
  const encoded = header.match(/request="([^"]+)"/)?.[1];
  assert.ok(encoded, `the 402 must carry a challenge request:\n${header}`);
  const request = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as StubChallengeRequest;
  const shown = JSON.stringify(request, null, 2);
  assert.ok(request.source?.network, `the challenge must name a source network:\n${shown}`);
  assert.ok(request.extra?.destination?.network, `the challenge must name a destination network:\n${shown}`);
  return request;
}

function defaultsUrl(merchantUrl: string, chainId?: string): string {
  const u = new URL("/v1/defaults", new URL(merchantUrl).origin);
  if (chainId !== undefined) u.searchParams.set("chain_id", chainId);
  return u.toString();
}

async function fetchDefaults(merchantUrl: string, chainId: string): Promise<GatewayDefaults> {
  const res = await fetch(defaultsUrl(merchantUrl, chainId));
  const text = await res.text();
  assert.equal(res.status, 200, `/v1/defaults for ${chainId} must answer 200:\n${text}`);
  return JSON.parse(text) as GatewayDefaults;
}

// EVM checksum casing is cosmetic, so addresses compare case-insensitively.
function sameAddress(a: string | undefined, b: string | undefined): boolean {
  return typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
}

function assertSameAddress(actual: string | undefined, expected: string, message: string): void {
  assert.ok(sameAddress(actual, expected), `${message}: got ${actual}, want ${expected}`);
}

function assertDefaultsShape(d: GatewayDefaults): void {
  const shown = JSON.stringify(d, null, 2);
  for (const field of ["chain_id", "escrow_contract", "quote_selector", "fulfillment_proxy"] as const) {
    assert.equal(typeof d[field], "string", `${field} must be a string:\n${shown}`);
    assert.notEqual(d[field], "", `${field} must be non-empty:\n${shown}`);
  }
  assert.equal(typeof d.fulfillment_verifier?.account, "string", `fulfillment_verifier.account must be a string:\n${shown}`);
  assert.notEqual(d.fulfillment_verifier.account, "", `fulfillment_verifier.account must be non-empty:\n${shown}`);
  assert.equal(typeof d.fulfillment_verifier?.endpoint, "string", `fulfillment_verifier.endpoint must be a string:\n${shown}`);
  assert.notEqual(d.fulfillment_verifier.endpoint, "", `fulfillment_verifier.endpoint must be non-empty:\n${shown}`);
  assert.ok(Array.isArray(d.tokens), `tokens must be an array:\n${shown}`);
  for (const t of d.tokens) {
    assert.equal(typeof t.symbol, "string", `every token needs a string symbol:\n${shown}`);
    assert.equal(typeof t.address, "string", `every token needs a string address:\n${shown}`);
    assert.equal(typeof t.decimals, "number", `every token needs numeric decimals:\n${shown}`);
  }
}

function findToken(d: GatewayDefaults, address: string): GatewayDefaults["tokens"][number] | undefined {
  return d.tokens.find((t) => sameAddress(t.address, address));
}

function assertListsTokenAs(d: GatewayDefaults, address: string, symbol: string, decimals: number): void {
  const shown = JSON.stringify(d, null, 2);
  const token = findToken(d, address);
  assert.ok(token, `tokens must list ${address}:\n${shown}`);
  assert.strictEqual(token.symbol, symbol, `${address} must be listed as ${symbol}:\n${shown}`);
  assert.strictEqual(token.decimals, decimals, `${address} must be listed with ${decimals} decimals:\n${shown}`);
}

// Every role a payer checks against the gateway, for the chain the payer deposits on.
async function assertSourceDefaultsMatchChallenge(url: string, request: StubChallengeRequest): Promise<GatewayDefaults> {
  const d = await fetchDefaults(url, request.source.network);
  assertDefaultsShape(d);
  const extra = request.extra;
  assert.equal(d.chain_id, request.source.network, "chain_id must echo the source chain asked for");
  assertSameAddress(d.escrow_contract, extra.escrow, "escrow_contract must be the escrow the challenge names");
  assertSameAddress(d.quote_selector, extra.reserver, "quote_selector must be the reserver the challenge names");
  assertSameAddress(
    d.fulfillment_verifier.account,
    extra.releaser,
    "the verifier account must be the releaser the challenge names",
  );
  assert.equal(
    d.fulfillment_verifier.endpoint,
    extra.fulfillmentVerifierEndpoint,
    "the verifier endpoint must be the one the challenge names",
  );
  return d;
}

// The fulfillment proxy lives on the destination chain, so that is where it is vouched for.
async function assertDestinationDefaultsMatchChallenge(
  url: string,
  request: StubChallengeRequest,
): Promise<GatewayDefaults> {
  const destination = request.extra.destination;
  const d = await fetchDefaults(url, destination.network);
  assertDefaultsShape(d);
  assert.equal(d.chain_id, destination.network, "chain_id must echo the destination chain asked for");
  assertSameAddress(
    d.fulfillment_proxy,
    request.extra.fulfillmentProxy,
    "fulfillment_proxy must be the one the challenge names",
  );
  return d;
}

test("stub merchant answers /v1/defaults for its source chain consistently with its 402", async () => {
  await withMerchant(4101, STUB_ENV, async ({ url }) => {
    const request = await fetchChallenge(url);
    const d = await assertSourceDefaultsMatchChallenge(url, request);
    assertListsTokenAs(d, request.source.asset, "USDC", 6);
  });
});

test("stub merchant answers /v1/defaults for its destination chain consistently with its 402", async () => {
  await withMerchant(4102, STUB_ENV, async ({ url }) => {
    const request = await fetchChallenge(url);
    const d = await assertDestinationDefaultsMatchChallenge(url, request);
    assertListsTokenAs(d, request.extra.destination.asset, "pathUSD", 6);
  });
});

test("stub /v1/defaults names the shipped corridor's chains and tokens", async () => {
  // The shipped default corridor is Base Sepolia USDC -> Tempo Moderato pathUSD; pin it
  // here so a default that drifts away from a known token is caught.
  await withMerchant(4103, STUB_ENV, async ({ url }) => {
    const request = await fetchChallenge(url);
    assert.equal(request.source.network, "eip155:84532");
    assertSameAddress(request.source.asset, "0x036CbD53842c5426634e7929541eC2318f3dCF7e", "shipped source asset");
    assert.equal(request.extra.destination.network, "eip155:42431");
    assertSameAddress(request.extra.destination.asset, "0x20c0000000000000000000000000000000000000", "shipped destination asset");

    const source = await fetchDefaults(url, "eip155:84532");
    assertListsTokenAs(source, "0x036CbD53842c5426634e7929541eC2318f3dCF7e", "USDC", 6);
    const destination = await fetchDefaults(url, "eip155:42431");
    assertListsTokenAs(destination, "0x20c0000000000000000000000000000000000000", "pathUSD", 6);
  });
});

test("stub /v1/defaults follows the configured corridor, not the shipped one", async () => {
  // A real mainnet corridor, deliberately different from the shipped testnet default, so
  // an answer hard-wired to the default corridor cannot pass.
  const corridor = {
    SOURCE_NETWORK: "eip155:8453",
    SOURCE_ASSET: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    DEST_NETWORK: "eip155:4217",
    DEST_ASSET: "0x20c0000000000000000000000000000000000000",
  };
  await withMerchant(4104, { ...STUB_ENV, ...corridor }, async ({ url }) => {
    const request = await fetchChallenge(url);
    // Guard the premise: the comparison below is only meaningful if the override took.
    assert.equal(request.source.network, corridor.SOURCE_NETWORK);
    assertSameAddress(request.source.asset, corridor.SOURCE_ASSET, "overridden source asset");
    assert.equal(request.extra.destination.network, corridor.DEST_NETWORK);
    assertSameAddress(request.extra.destination.asset, corridor.DEST_ASSET, "overridden destination asset");

    const source = await assertSourceDefaultsMatchChallenge(url, request);
    assertListsTokenAs(source, corridor.SOURCE_ASSET, "USDC", 6);
    const destination = await assertDestinationDefaultsMatchChallenge(url, request);
    assertListsTokenAs(destination, corridor.DEST_ASSET, "pathUSD", 6);

    // The shipped chains are no longer part of this corridor, so they must not be vouched for.
    for (const shipped of ["eip155:84532", "eip155:42431"]) {
      const res = await fetch(defaultsUrl(url, shipped));
      assert.equal(res.status, 404, `${shipped} is outside the overridden corridor and must be 404:\n${await res.text()}`);
    }
  });
});

test("stub /v1/defaults keys token metadata by address, whatever its casing", async () => {
  // The corridor reversed, with pathUSD written with an uppercase C, so a lookup that
  // compares addresses case-sensitively — or keys metadata by leg rather than by
  // address — cannot pass.
  const corridor = {
    SOURCE_NETWORK: "eip155:42431",
    SOURCE_ASSET: "0x20C0000000000000000000000000000000000000",
    DEST_NETWORK: "eip155:84532",
    DEST_ASSET: "0x036cbd53842c5426634e7929541ec2318f3dcf7e",
  };
  await withMerchant(4105, { ...STUB_ENV, ...corridor }, async ({ url }) => {
    const request = await fetchChallenge(url);
    assert.equal(request.source.network, corridor.SOURCE_NETWORK);
    assert.equal(request.extra.destination.network, corridor.DEST_NETWORK);

    const source = await assertSourceDefaultsMatchChallenge(url, request);
    assertListsTokenAs(source, corridor.SOURCE_ASSET, "pathUSD", 6);
    const destination = await assertDestinationDefaultsMatchChallenge(url, request);
    assertListsTokenAs(destination, corridor.DEST_ASSET, "USDC", 6);
  });
});

test("stub /v1/defaults does not vouch for metadata of an asset it does not know", async () => {
  const unknownAsset = "0x00000000000000000000000000000000000000aa";
  await withMerchant(4106, { ...STUB_ENV, DEST_ASSET: unknownAsset }, async ({ url }) => {
    const request = await fetchChallenge(url);
    // Guard the premise: the assertions below only mean something if the override took.
    assertSameAddress(request.extra.destination.asset, unknownAsset, "overridden destination asset");

    // The roles are still vouched for: they do not depend on which token is paid out.
    const destination = await assertDestinationDefaultsMatchChallenge(url, request);
    // Inventing a symbol or decimals for an unknown token would let a payer trust a
    // guess, so the token must be absent rather than listed with made-up metadata.
    assert.equal(
      findToken(destination, unknownAsset),
      undefined,
      `an unknown asset must not be listed:\n${JSON.stringify(destination, null, 2)}`,
    );

    // The known source leg is unaffected by an unknown destination.
    const source = await assertSourceDefaultsMatchChallenge(url, request);
    assertListsTokenAs(source, request.source.asset, "USDC", 6);
  });
});

test("stub /v1/defaults refuses chains outside its corridor and a missing chain_id", async () => {
  await withMerchant(4107, STUB_ENV, async ({ url }) => {
    const request = await fetchChallenge(url);
    // Guard the premise: a merchant that answers nothing at /v1/defaults would pass the
    // 404 checks below vacuously, so its own chain must answer first.
    await fetchDefaults(url, request.source.network);

    // The merchant must not invent trust anchors for a chain it does not settle on.
    const outside = "eip155:1";
    assert.notEqual(request.source.network, outside);
    assert.notEqual(request.extra.destination.network, outside);
    const foreign = await fetch(defaultsUrl(url, outside));
    assert.equal(foreign.status, 404, `a chain outside the corridor must be 404:\n${await foreign.text()}`);

    const bare = await fetch(defaultsUrl(url));
    assert.equal(bare.status, 404, `a request without chain_id must be 404:\n${await bare.text()}`);
  });
});

test("stub merchant says its /v1/defaults answers are for the demo only", async () => {
  // An operator reading the log must be told these trust anchors are the merchant's own
  // placeholders, not Atum's — a payer trusting them outside the demo trusts the payee.
  await withMerchant(4108, STUB_ENV, async ({ url, output }) => {
    // The note may be printed after the listening banner withMerchant waits for. The
    // child's stdout is one ordered pipe, so once the line logged for a later request has
    // arrived, everything printed before it has too.
    await fetchChallenge(url);
    for (let i = 0; i < 50 && !/challenge issued/.test(output()); i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.match(output(), /challenge issued/, `the merchant never logged the challenge:\n${output()}`);
    const lines = output().split("\n");
    assert.ok(
      lines.some((line) => /\/v1\/defaults/.test(line) && /stub|demo/i.test(line)),
      `expected a log line saying /v1/defaults is answered for the stub demo only:\n${output()}`,
    );
  });
});

// A gateway stand-in that answers any /v1/defaults lookup, so real mode can boot with
// no network. Bound to an OS-assigned port so it can never collide with a merchant port.
async function withFakeGateway(fn: (gatewayUrl: string) => Promise<void>): Promise<void> {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://localhost");
    const chainId = u.searchParams.get("chain_id");
    if (u.pathname !== "/v1/defaults" || !chainId) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({
        chain_id: chainId,
        escrow_contract: "0x00000000000000000000000000000000000000e1",
        quote_selector: "0x00000000000000000000000000000000000000e2",
        fulfillment_proxy: "0x00000000000000000000000000000000000000e3",
        fulfillment_verifier: {
          account: "0x00000000000000000000000000000000000000e4",
          endpoint: "http://127.0.0.1:1/verify",
        },
        tokens: [],
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("a real-mode merchant never answers /v1/defaults for its own corridor", async () => {
  await withFakeGateway(async (gatewayUrl) => {
    const env = {
      USE_STUB_SUBMITTER: "false",
      GATEWAY_URL: gatewayUrl,
      MPP_SECRET_KEY: randomBytes(32).toString("hex"),
      DEST_ADDRESS: "0x00000000000000000000000000000000000000d1",
      SOURCE_NETWORK: "eip155:84532",
      DEST_NETWORK: "eip155:42431",
    };
    await withMerchant(4109, env, async ({ url, output }) => {
      // Guard the premise: this must be the real-mode merchant, booted off the stand-in.
      assert.match(output(), /real gateway/, `expected the merchant to boot in real mode:\n${output()}`);
      // Trust anchors must come from Atum, never from the party being paid.
      for (const chainId of [env.SOURCE_NETWORK, env.DEST_NETWORK]) {
        const res = await fetch(defaultsUrl(url, chainId));
        assert.equal(res.status, 404, `a real merchant must not serve /v1/defaults for ${chainId}:\n${await res.text()}`);
      }
    });
  });
});

// --- payer trust source -----------------------------------------------------
//
// A challenge is written by the party being paid, so the payer checks its escrow and
// roles against a trust source the merchant does not control before signing. Which source
// is the payer's choice: GATEWAY_URL when set, Atum's production gateways otherwise.

// The payer's "Requesting <url>" line already contains the merchant origin, so a bare
// URL match would pass vacuously; the trust-source line must also say it is about trust.
function trustSourceLines(output: string): string[] {
  return output.split("\n").filter((line) => /trust/i.test(line));
}

test("the payer says which gateway it trusts when GATEWAY_URL is set", async () => {
  await withMerchant(4110, STUB_ENV, async ({ url }) => {
    const gatewayUrl = stubGateway(url);
    const result = await runClient({
      PRIVATE_KEY: randomPrivateKey(),
      MERCHANT_URL: url,
      RPC_URL: "",
      GATEWAY_URL: gatewayUrl,
    });
    assertPaid(result, "client");
    assert.ok(
      trustSourceLines(result.output).some((line) => line.includes(gatewayUrl)),
      `expected a line naming ${gatewayUrl} as the trust source:\n${result.output}`,
    );
    assert.ok(
      !trustSourceLines(result.output).some((line) => /production/i.test(line)),
      `a configured GATEWAY_URL must not be reported as the production gateways:\n${result.output}`,
    );
  });
});

// An empty GATEWAY_URL is "unset" (a blank line in .env), so the payer falls back to
// Atum's production gateways. Those do not vouch for the stub corridor — and offline they
// cannot be reached at all, bounded by the SDK's lookup timeout — so either way this run
// must not pay. Only the reported trust source and the absence of a payment are asserted.
test("the payer falls back to Atum's production gateways when GATEWAY_URL is empty", { timeout: 90_000 }, async () => {
  await withMerchant(4111, STUB_ENV, async ({ url, output }) => {
    const result = await runClient({
      PRIVATE_KEY: randomPrivateKey(),
      MERCHANT_URL: url,
      RPC_URL: "",
      GATEWAY_URL: "",
    });
    const lines = trustSourceLines(result.output);
    assert.ok(
      lines.some((line) => /production/i.test(line)),
      `expected a line saying Atum's production gateways are the trust source:\n${result.output}`,
    );
    assert.ok(
      !lines.some((line) => line.includes(stubGateway(url))),
      `with GATEWAY_URL empty the payer must not trust the merchant's own origin:\n${result.output}`,
    );
    assert.notEqual(result.exitCode, 0, `expected the payer not to pay the stub corridor:\n${result.output}`);
    assert.doesNotMatch(result.output, /Status: 200/, `the payer must not have been served:\n${result.output}`);
    assert.doesNotMatch(output(), /→ 200:/, `the merchant must not have served the run:\n${output()}`);
    assert.doesNotMatch(output(), /settled payment/, `the merchant must not have settled the run:\n${output()}`);
  });
});

// A trust source that repeats the stub merchant's own /v1/defaults answer for every chain
// but vouches for a different escrow. Mirroring the merchant keeps every other anchor and
// every token identical to its challenge, so the escrow is the only thing a payer can
// object to. Counting lookups proves a refusal came from the comparison, not from a
// lookup that never happened. Bound to an OS-assigned port so it never collides.
async function withSkewedGateway(
  merchantUrl: string,
  escrow: string,
  fn: (gateway: { url: string; lookups(): number }) => Promise<void>,
): Promise<void> {
  let lookups = 0;
  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://localhost");
    const chainId = u.searchParams.get("chain_id");
    if (req.method !== "GET" || u.pathname !== "/v1/defaults" || !chainId) {
      res.writeHead(404).end();
      return;
    }
    lookups++;
    void fetch(defaultsUrl(merchantUrl, chainId)).then(
      async (upstream) => {
        if (upstream.status !== 200) {
          res.writeHead(upstream.status).end(await upstream.text());
          return;
        }
        const d = (await upstream.json()) as GatewayDefaults;
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({ ...d, escrow_contract: escrow }),
        );
      },
      (err: unknown) => res.writeHead(502).end(String(err)),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;
  try {
    await fn({ url: `http://127.0.0.1:${port}`, lookups: () => lookups });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

// The same merchant is then paid with its own defaults as the trust source, so the
// refusal can only be the trust check and not a broken setup.
test("the payer refuses the stub merchant when its trust source does not vouch for the challenge's escrow", async () => {
  await withMerchant(4112, STUB_ENV, async ({ url, output }) => {
    const request = await fetchChallenge(url);
    const untrustedEscrow = "0x00000000000000000000000000000000000000bA";
    // Guard the premise: the skew only means something if it differs from the challenge.
    assert.ok(
      !sameAddress(request.extra.escrow, untrustedEscrow),
      `the skewed escrow must differ from the challenge's ${request.extra.escrow}`,
    );

    await withSkewedGateway(url, untrustedEscrow, async (gateway) => {
      const refused = await runClient({
        PRIVATE_KEY: randomPrivateKey(),
        MERCHANT_URL: url,
        RPC_URL: "",
        GATEWAY_URL: gateway.url,
      });
      assert.notEqual(refused.exitCode, 0, `expected the payer to refuse:\n${refused.output}`);
      assert.match(refused.output, /extra\.escrow/, `expected the refusal to name the field:\n${refused.output}`);
      assert.match(refused.output, /not trusted/, `expected an untrusted-escrow refusal:\n${refused.output}`);
      assert.ok(
        gateway.lookups() >= 1,
        `the payer must have consulted the trust source before refusing (lookups: ${gateway.lookups()}):\n${refused.output}`,
      );
    });
    assert.doesNotMatch(output(), /→ 200:/, `the merchant must not have served the refused run:\n${output()}`);
    assert.doesNotMatch(output(), /settled payment/, `the merchant must not have settled the refused run:\n${output()}`);

    const paid = await runClient({
      PRIVATE_KEY: randomPrivateKey(),
      MERCHANT_URL: url,
      RPC_URL: "",
      GATEWAY_URL: stubGateway(url),
    });
    assertPaid(paid, "client trusting the stub merchant's own defaults");
  });
});

// --- real end-to-end (opt-in; moves real testnet funds) --------------------
//
// Runs only when RUN_REAL_E2E=1 and a funded PRIVATE_KEY is set. It settles a real
// payment across the corridor through the hosted gateway and asserts the merchant
// logged a real settlement — failing loudly if it sees the stub payment id, so it can
// never give a false pass. MPP has no separate facilitator: the merchant verifies and
// submits in-process, and when settlement outruns the gateway's synchronous window the
// payer's re-attempt at the same purchase is what collects the result.
//
// A fresh MPP_SECRET_KEY is generated per run (any private >= 32-byte secret works —
// the same merchant issues and verifies the challenge).
//
// Optional overrides: GATEWAY_URL, DEST_ADDRESS, FULFILLMENT_DEADLINE_SECONDS; the
// corridor itself (SOURCE_NETWORK, SOURCE_ASSET, DEST_NETWORK, DEST_ASSET); and the
// per-direction source RPCs RPC_URL / REVERSE_RPC_URL (default to the shipped
// corridor's chains).
//
// All of them are read from the EXPORTED ENVIRONMENT, not from .env. Every process this
// file spawns is deliberately pointed at a nonexistent dotenv path (NO_DOTENV above) so
// the suite stays hermetic — which also means .env cannot reach it. `.env` repoints the
// merchant you run by hand (`npm run dev`); export these in your shell to repoint the test.
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
// merchant's /v1/defaults lookup, where it fails with nothing pointing back to the cause.
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
  const paymentId = merchantLog.match(/settled payment (\S+)/)?.[1];
  const deposit = merchantLog.match(/source deposit:\s*(\S+)/)?.[1] ?? "(see merchant log)";
  const payout = merchantLog.match(/destination payout:\s*(\S+)/)?.[1];
  const bar = "─".repeat(72);
  process.stdout.write(
    `\n${bar}\n` +
      `  ✅ ${protocol} — REAL SETTLEMENT CONFIRMED\n` +
      (paymentId ? `     payment id:          ${paymentId}\n` : "") +
      `     corridor:            ${corridorLabel(dir)}\n` +
      attemptSummary(clientLog) +
      `     amount:              ${amount} (atomic) paid to ${dest}\n` +
      `     source deposit:      ${deposit}\n` +
      (payout ? `     destination payout:  ${payout}\n` : "") +
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
    // GATEWAY_URL is passed explicitly too: the payer's trust source is a deliberate
    // choice, and empty means Atum's production gateways.
    const result = await withHeartbeat(`MPP real settlement (${corridorLabel(dir)})`, () =>
      runClient({
        PRIVATE_KEY: privateKey,
        MERCHANT_URL: url,
        RPC_URL: dir.rpcUrl ?? "",
        GATEWAY_URL: process.env.GATEWAY_URL ?? "",
      }),
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
  "real e2e (forward): settles a real payment through the gateway",
  { skip: REAL_E2E_ENABLED ? false : "set RUN_REAL_E2E=1 and PRIVATE_KEY to run" },
  () => runRealSettlement(FORWARD, 4099),
);

test(
  "real e2e (reverse): settles a real payment back along the same corridor",
  { skip: reverseSkip },
  () => runRealSettlement(REVERSE, 4100),
);
