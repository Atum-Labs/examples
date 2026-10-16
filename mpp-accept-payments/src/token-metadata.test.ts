/*
 * Copyright (c) 2026 Atum Labs, Inc.
 * SPDX-License-Identifier: MIT
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import net from "node:net";
import http from "node:http";
import { randomBytes } from "node:crypto";

// Every corridor token carries a symbol and decimals. In real mode those come from the
// gateway the merchant settles through, never from a guess: a source token whose decimals
// differ from the destination's must scale the spend cap, or the payer is asked to
// authorize an amount off by orders of magnitude. In stub mode the merchant's own
// /v1/defaults must never vouch for a token it does not know, so a payer refuses rather
// than pricing on invented decimals.
//
// The merchant is booted as a child process and driven over HTTP, as smoke.test.ts does;
// the gateway is a stand-in this file owns, so real mode needs no network or funds.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MERCHANT_DIR = path.resolve(HERE, "..");

// Pointing dotenv at a nonexistent file keeps a developer's real .env out of the child.
const NO_DOTENV = path.join(HERE, "no-such.env");

function tsxBin(dir: string): string {
  return path.join(dir, "node_modules", ".bin", "tsx");
}

const merchantListening = (port: number) =>
  new RegExp(`merchant listening on http://localhost:${port}\\b`, "i");

function portAnswers(port: number, timeoutMs = 2_000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(port);
    const settle = (answered: boolean) => {
      socket.destroy();
      resolve(answered);
    };
    socket.setTimeout(timeoutMs, () => settle(false));
    socket.once("connect", () => settle(true));
    socket.once("error", () => settle(false));
  });
}

const BOOT_TIMEOUT_MS = Number(process.env.MERCHANT_BOOT_TIMEOUT_MS ?? 45_000);

function waitForListening(child: ChildProcess, port: number, getOutput: () => string): Promise<void> {
  return new Promise((resolve, reject) => {
    let done = false;
    const fail = (why: string) => reject(new Error(`${why}\n--- merchant output ---\n${getOutput()}`));
    const finish = () => {
      done = true;
      clearTimeout(timer);
      child.removeListener("exit", onExit);
      child.removeListener("error", onError);
    };
    const timer = setTimeout(() => {
      finish();
      fail(`timed out after ${BOOT_TIMEOUT_MS}ms waiting for the merchant to listen on port ${port}`);
    }, BOOT_TIMEOUT_MS);
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

interface MerchantHandle {
  url: string;
  output(): string;
}

function spawnMerchant(port: number, env: Record<string, string | undefined>): {
  child: ChildProcess;
  output(): string;
} {
  const child = spawn(tsxBin(MERCHANT_DIR), ["src/merchant.ts"], {
    cwd: MERCHANT_DIR,
    env: { ...process.env, DOTENV_CONFIG_PATH: NO_DOTENV, PORT: String(port), ...env },
  });
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => (output += chunk.toString()));
  child.stderr?.on("data", (chunk: Buffer) => (output += chunk.toString()));
  child.on("error", () => {});
  return { child, output: () => output };
}

async function withMerchant(
  port: number,
  env: Record<string, string | undefined>,
  fn: (merchant: MerchantHandle) => Promise<void>,
): Promise<void> {
  if (await portAnswers(port)) {
    throw new Error(`port ${port} is already in use — stop the process holding it (find it with lsof -ti:${port})`);
  }
  const { child, output } = spawnMerchant(port, env);
  try {
    await waitForListening(child, port, output);
    const body = fn({ url: `http://localhost:${port}/paid`, output });
    const died = new Promise<never>((_, reject) =>
      child.once("exit", (code, signal) =>
        reject(
          new Error(`merchant exited during the test (${signal ? `killed by ${signal}` : `code ${code}`}):\n${output()}`),
        ),
      ),
    );
    try {
      await Promise.race([body, died]);
    } finally {
      await body.catch(() => {});
    }
  } finally {
    child.kill();
  }
}

// A refusal is an exit, so a merchant that reaches its listening banner instead has
// accepted a corridor it should not have and fails here rather than at a timeout.
async function expectRefusalToStart(
  port: number,
  env: Record<string, string | undefined>,
): Promise<{ exitCode: number; output: string }> {
  if (await portAnswers(port)) {
    throw new Error(`port ${port} is already in use — stop the process holding it (find it with lsof -ti:${port})`);
  }
  const { child, output } = spawnMerchant(port, env);
  try {
    return await new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        settled = true;
        reject(new Error(`merchant neither exited nor listened within ${BOOT_TIMEOUT_MS}ms:\n${output()}`));
      }, BOOT_TIMEOUT_MS);
      child.once("exit", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ exitCode: code ?? 1, output: output() });
      });
      const watch = (): void => {
        if (settled) return;
        if (merchantListening(port).test(output())) {
          settled = true;
          clearTimeout(timer);
          reject(new Error(`expected the merchant to refuse to start, but it is serving:\n${output()}`));
          return;
        }
        setTimeout(watch, 100);
      };
      watch();
    });
  } finally {
    child.kill();
  }
}

interface ChallengeRequest {
  source: { network: string; asset: string; amount: string };
  extra: { destination: { network: string; asset: string } };
}

async function fetchChallenge(url: string, purchaseId: string): Promise<ChallengeRequest> {
  const res = await fetch(`${url}/${purchaseId}`);
  assert.equal(res.status, 402, `an unpaid request must be answered with a challenge:\n${await res.clone().text()}`);
  const header = res.headers.get("www-authenticate") ?? "";
  const encoded = header.match(/request="([^"]+)"/)?.[1];
  assert.ok(encoded, `the 402 must carry a challenge request:\n${header}`);
  return JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as ChallengeRequest;
}

interface Token {
  symbol: string;
  address: string;
  decimals: number;
}

interface GatewayDefaults {
  chain_id: string;
  tokens?: Token[];
}

// Spend cap the payer authorizes, in source atomic units: the destination amount plus
// markup, rescaled from destination decimals to source decimals, rounded down.
function expectedSourceAmount(
  fulfillment: bigint,
  markupBps: bigint,
  sourceDecimals: number,
  destDecimals: number,
): bigint {
  return (
    (fulfillment * (10_000n + markupBps) * 10n ** BigInt(sourceDecimals)) /
    (10_000n * 10n ** BigInt(destDecimals))
  );
}

// --- real mode: metadata comes from the gateway --------------------------------

// A well-formed /v1/defaults answer. `tokens` of `undefined` omits the field entirely;
// otherwise it is sent as given, so a test can serve malformed entries on purpose.
function defaultsBody(chainId: string, tokens: unknown): Record<string, unknown> {
  const body: Record<string, unknown> = {
    chain_id: chainId,
    escrow_contract: "0x00000000000000000000000000000000000000e1",
    quote_selector: "0x00000000000000000000000000000000000000e2",
    fulfillment_proxy: "0x00000000000000000000000000000000000000e3",
    fulfillment_verifier: {
      account: "0x00000000000000000000000000000000000000e4",
      endpoint: "https://verifier.example.com/verify",
    },
  };
  if (tokens !== undefined) body.tokens = tokens;
  return body;
}

interface RawAnswer {
  status: number;
  contentType: string;
  body: string;
}

function jsonAnswer(value: unknown): RawAnswer {
  return { status: 200, contentType: "application/json", body: JSON.stringify(value) };
}

// A gateway stand-in answering /v1/defaults per chain with exactly the bytes given.
// Chains not in the map are 404, as the real gateway answers an unsupported chain. It
// answers under any path prefix, so a GATEWAY_URL carrying a path still reaches it. Bound
// to an OS-assigned port so it never collides with a merchant port. `served` lists every
// lookup it answered from the map, so a test can prove the merchant got as far as reading
// a particular chain's answer.
interface ServedLookup {
  chainId: string;
  pathname: string;
}

async function withRawGateway(
  answers: Record<string, RawAnswer>,
  fn: (gatewayUrl: string, served: () => ServedLookup[]) => Promise<void>,
): Promise<void> {
  const servedLookups: ServedLookup[] = [];
  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://localhost");
    const chainId = u.searchParams.get("chain_id");
    if (req.method !== "GET" || !u.pathname.endsWith("/v1/defaults") || !chainId || !(chainId in answers)) {
      res.writeHead(404).end();
      return;
    }
    const answer = answers[chainId];
    servedLookups.push({ chainId, pathname: u.pathname });
    res.writeHead(answer.status, { "content-type": answer.contentType }).end(answer.body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`, () => [...servedLookups]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

// The full wire shape with a token list per chain. An entry is sent as given, so a test
// can put a malformed token next to a valid one.
function withTokenGateway(
  tokensByChain: Record<string, unknown[] | Record<string, unknown> | undefined>,
  fn: (gatewayUrl: string, served: () => ServedLookup[]) => Promise<void>,
): Promise<void> {
  const answers: Record<string, RawAnswer> = {};
  for (const [chainId, tokens] of Object.entries(tokensByChain)) {
    answers[chainId] = jsonAnswer(defaultsBody(chainId, tokens));
  }
  return withRawGateway(answers, fn);
}

// The shipped Base Sepolia USDC -> Tempo pathUSD corridor. Both are 6-decimal tokens in
// reality, so a gateway that says the source has 18 decimals can only move the spend cap
// if the merchant actually reads decimals from the gateway rather than a local table or
// an assumed 6.
const REAL_SOURCE_NETWORK = "eip155:84532";
const REAL_SOURCE_ASSET = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const REAL_DEST_NETWORK = "eip155:42431";
const REAL_DEST_ASSET = "0x20c0000000000000000000000000000000000000";

const FULFILLMENT = 50_001n;
const MARKUP = 300n;

// The real-mode start-up guards (non-placeholder secret, valid DEST_ADDRESS) are
// satisfied so token metadata is the only thing that can decide the outcome.
function realEnv(gatewayUrl: string): Record<string, string> {
  return {
    USE_STUB_SUBMITTER: "false",
    GATEWAY_URL: gatewayUrl,
    MPP_SECRET_KEY: randomBytes(32).toString("hex"),
    DEST_ADDRESS: "0x00000000000000000000000000000000000000d1",
    SOURCE_NETWORK: REAL_SOURCE_NETWORK,
    SOURCE_ASSET: REAL_SOURCE_ASSET,
    DEST_NETWORK: REAL_DEST_NETWORK,
    DEST_ASSET: REAL_DEST_ASSET,
    FULFILLMENT_AMOUNT: FULFILLMENT.toString(),
    MARKUP_BPS: MARKUP.toString(),
  };
}

test("real mode prices the spend cap with the source decimals the gateway reports", async () => {
  await withTokenGateway(
    {
      [REAL_SOURCE_NETWORK]: [{ symbol: "USDC", address: REAL_SOURCE_ASSET, decimals: 18 }],
      [REAL_DEST_NETWORK]: [{ symbol: "pathUSD", address: REAL_DEST_ASSET, decimals: 6 }],
    },
    async (gatewayUrl) => {
      await withMerchant(4120, realEnv(gatewayUrl), async ({ url, output }) => {
        assert.match(output(), /real gateway/, `expected the merchant to boot in real mode:\n${output()}`);
        const request = await fetchChallenge(url, "order_token_decimals_0001");
        const shown = JSON.stringify(request, null, 2);
        assert.equal(
          request.source.amount,
          expectedSourceAmount(FULFILLMENT, MARKUP, 18, 6).toString(),
          `the spend cap must be rescaled from 6 to 18 decimals:\n${shown}`,
        );
      });
    },
  );
});

test("real mode matches the gateway's token list to the configured EVM address case-insensitively", async () => {
  // Guard the premise: the configured spelling must differ from the listed one, or the
  // match below is trivially exact.
  assert.notEqual(REAL_SOURCE_ASSET, REAL_SOURCE_ASSET.toLowerCase());
  await withTokenGateway(
    {
      [REAL_SOURCE_NETWORK]: [{ symbol: "USDC", address: REAL_SOURCE_ASSET.toLowerCase(), decimals: 18 }],
      [REAL_DEST_NETWORK]: [{ symbol: "pathUSD", address: REAL_DEST_ASSET, decimals: 6 }],
    },
    async (gatewayUrl) => {
      await withMerchant(4121, realEnv(gatewayUrl), async ({ url }) => {
        const request = await fetchChallenge(url, "order_token_casing_0001");
        const shown = JSON.stringify(request, null, 2);
        // The challenge names the token as the merchant configured it, not as listed.
        assert.equal(request.source.asset, REAL_SOURCE_ASSET, `the configured source spelling:\n${shown}`);
        assert.equal(
          request.source.amount,
          expectedSourceAmount(FULFILLMENT, MARKUP, 18, 6).toString(),
          `the lowercase listing's decimals must be the ones applied:\n${shown}`,
        );
      });
    },
  );
});

function assertNamesMissingToken(result: { exitCode: number; output: string }): void {
  assert.notEqual(result.exitCode, 0, `expected the merchant to refuse to start:\n${result.output}`);
  assert.ok(
    result.output.includes(REAL_DEST_NETWORK),
    `the refusal must name the chain the token is missing on (${REAL_DEST_NETWORK}):\n${result.output}`,
  );
  assert.ok(
    result.output.toLowerCase().includes(REAL_DEST_ASSET.toLowerCase()),
    `the refusal must name the missing token (${REAL_DEST_ASSET}):\n${result.output}`,
  );
}

test("real mode refuses to start when the gateway does not list the destination token", async () => {
  await withTokenGateway(
    {
      [REAL_SOURCE_NETWORK]: [{ symbol: "USDC", address: REAL_SOURCE_ASSET, decimals: 6 }],
      // Another token on the same chain, so the list is non-empty but lacks the one configured.
      [REAL_DEST_NETWORK]: [
        { symbol: "AlphaUSD", address: "0x20c0000000000000000000000000000000000001", decimals: 6 },
      ],
    },
    async (gatewayUrl) => {
      assertNamesMissingToken(await expectRefusalToStart(4122, realEnv(gatewayUrl)));
    },
  );
});

test("real mode refuses to start when the gateway's answer has no tokens field", async () => {
  await withTokenGateway(
    {
      [REAL_SOURCE_NETWORK]: [{ symbol: "USDC", address: REAL_SOURCE_ASSET, decimals: 6 }],
      [REAL_DEST_NETWORK]: undefined,
    },
    async (gatewayUrl) => {
      assertNamesMissingToken(await expectRefusalToStart(4123, realEnv(gatewayUrl)));
    },
  );
});

// --- stub mode -----------------------------------------------------------------

const STUB_ENV = { USE_STUB_SUBMITTER: undefined };

// The stub used to boot on unknown tokens and leave them out of /v1/defaults; it now
// refuses at startup, because a stub that cannot describe the token it charges in would
// issue a challenge no payer can price. The refusal names the token, its chain, and where
// the stub's known tokens are listed — and never falls back to a placeholder symbol.

function assertStubRefusesToken(
  result: { exitCode: number; output: string },
  chainId: string,
  address: string,
): void {
  assert.notEqual(result.exitCode, 0, `expected the merchant to refuse to start:\n${result.output}`);
  assert.ok(
    result.output.toLowerCase().includes(address.toLowerCase()),
    `the refusal must name the unknown token ${address}:\n${result.output}`,
  );
  assert.ok(result.output.includes(chainId), `the refusal must name its chain ${chainId}:\n${result.output}`);
  assert.ok(result.output.includes("STUB_KNOWN_TOKENS"), `the refusal must say where to add the token:\n${result.output}`);
  // \b keeps STUB_KNOWN_TOKENS from matching: `_` is a word character.
  assert.doesNotMatch(result.output, /\bSTUB\b/, `no STUB placeholder symbol may appear:\n${result.output}`);
}

const SENTINEL_SOURCE_NETWORK = "eip155:999001";
const SENTINEL_DEST_NETWORK = "eip155:999002";

test("stub mode refuses to start on corridor tokens it does not know", async () => {
  // Deliberately not any real chain or token, so no table can know them.
  const corridor = {
    SOURCE_NETWORK: SENTINEL_SOURCE_NETWORK,
    SOURCE_ASSET: "0x00000000000000000000000000000000000000a1",
    DEST_NETWORK: SENTINEL_DEST_NETWORK,
    DEST_ASSET: "0x00000000000000000000000000000000000000b2",
  };
  const result = await expectRefusalToStart(4124, { ...STUB_ENV, ...corridor });
  assertStubRefusesToken(result, corridor.SOURCE_NETWORK, corridor.SOURCE_ASSET);
});

test("stub mode refuses to start when only the source token is unknown", async () => {
  const corridor = {
    SOURCE_NETWORK: SENTINEL_SOURCE_NETWORK,
    SOURCE_ASSET: "0x00000000000000000000000000000000000000a1",
    DEST_NETWORK: SENTINEL_DEST_NETWORK,
    DEST_ASSET: REAL_DEST_ASSET,
  };
  const result = await expectRefusalToStart(4148, { ...STUB_ENV, ...corridor });
  assertStubRefusesToken(result, corridor.SOURCE_NETWORK, corridor.SOURCE_ASSET);
});

test("stub mode knows its tokens by address, on any network", async () => {
  // Known tokens on chains that do not exist: the table is keyed by address alone, so
  // the stub boots and vouches for each with its real metadata.
  const corridor = {
    SOURCE_NETWORK: SENTINEL_SOURCE_NETWORK,
    SOURCE_ASSET: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    DEST_NETWORK: SENTINEL_DEST_NETWORK,
    DEST_ASSET: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  };
  await withMerchant(4149, { ...STUB_ENV, ...corridor }, async ({ url }) => {
    const origin = new URL(url).origin;
    for (const [chainId, address] of [
      [corridor.SOURCE_NETWORK, corridor.SOURCE_ASSET],
      [corridor.DEST_NETWORK, corridor.DEST_ASSET],
    ] as const) {
      const res = await fetch(`${origin}/v1/defaults?chain_id=${encodeURIComponent(chainId)}`);
      const text = await res.text();
      assert.equal(res.status, 200, `/v1/defaults for ${chainId} must answer 200:\n${text}`);
      const d = JSON.parse(text) as GatewayDefaults;
      assert.ok(Array.isArray(d.tokens), `tokens must be an array:\n${text}`);
      const token = d.tokens.find((t) => typeof t.address === "string" && t.address.toLowerCase() === address.toLowerCase());
      assert.ok(token, `${chainId} must list ${address}:\n${text}`);
      assert.strictEqual(token.symbol, "USDC", `${address} must be listed as USDC:\n${text}`);
      assert.strictEqual(token.decimals, 6, `${address} must be listed with 6 decimals:\n${text}`);
    }
  });
});

test("stub default corridor prices the spend cap 1:1 across its two 6-decimal tokens", async () => {
  // Corridor variables are removed so the shipped defaults (Base Sepolia USDC -> Tempo
  // pathUSD) apply. 50001 × 10300 / 10000 = 51501.03, so a cap that rounds up or keeps
  // the fraction fails.
  const unsetCorridor = {
    SOURCE_NETWORK: undefined,
    SOURCE_ASSET: undefined,
    DEST_NETWORK: undefined,
    DEST_ASSET: undefined,
  };
  await withMerchant(
    4125,
    { ...STUB_ENV, ...unsetCorridor, FULFILLMENT_AMOUNT: FULFILLMENT.toString(), MARKUP_BPS: MARKUP.toString() },
    async ({ url }) => {
      const request = await fetchChallenge(url, "order_stub_amount_0001");
      const shown = JSON.stringify(request, null, 2);
      assert.equal(request.source.network, REAL_SOURCE_NETWORK, `the default source network:\n${shown}`);
      assert.equal(request.extra.destination.network, REAL_DEST_NETWORK, `the default destination network:\n${shown}`);
      assert.equal(
        request.source.amount,
        expectedSourceAmount(FULFILLMENT, MARKUP, 6, 6).toString(),
        `two 6-decimal tokens must not rescale the cap:\n${shown}`,
      );
      assert.equal(request.source.amount, "51501", `the floored cap:\n${shown}`);
    },
  );
});

// --- real mode: a corridor the SDK would refuse never boots --------------------
//
// A merchant that boots on a corridor its SDK rejects only fails later, on the first
// paying request, with the cause buried in a route error. Refusing at start-up puts the
// cause in front of the operator who can fix it.

const VALID_SOURCE_TOKEN = { symbol: "USDC", address: REAL_SOURCE_ASSET, decimals: 6 };
const VALID_DEST_TOKEN = { symbol: "pathUSD", address: REAL_DEST_ASSET, decimals: 6 };

test("real mode refuses to start when the corridor's tokens are not the same money", async () => {
  await withTokenGateway(
    {
      [REAL_SOURCE_NETWORK]: [{ symbol: "EURC", address: REAL_SOURCE_ASSET, decimals: 6 }],
      [REAL_DEST_NETWORK]: [VALID_DEST_TOKEN],
    },
    async (gatewayUrl) => {
      const result = await expectRefusalToStart(4126, realEnv(gatewayUrl));
      assert.notEqual(result.exitCode, 0, `expected the merchant to refuse to start:\n${result.output}`);
      assert.match(result.output, /EURC|not the same money/, `the refusal must name the mismatch:\n${result.output}`);
    },
  );
});

test("real mode refuses to start when the gateway reports decimals as a string", async () => {
  await withTokenGateway(
    {
      [REAL_SOURCE_NETWORK]: [VALID_SOURCE_TOKEN],
      [REAL_DEST_NETWORK]: [{ symbol: "pathUSD", address: REAL_DEST_ASSET, decimals: "6" }],
    },
    async (gatewayUrl) => {
      const result = await expectRefusalToStart(4127, realEnv(gatewayUrl));
      assert.notEqual(result.exitCode, 0, `expected the merchant to refuse to start:\n${result.output}`);
      assert.match(result.output, /decimals/, `the refusal must name the decimals field:\n${result.output}`);
      assertBlamesGatewayMetadata(result);
    },
  );
});

test("real mode refuses to start when the spend cap would round below the price", async () => {
  // 50001 × 10300 × 10^0 / (10000 × 10^6) floors to 0: a cap worth less than the price
  // can never settle, so it must never be offered.
  assert.equal(expectedSourceAmount(FULFILLMENT, MARKUP, 0, 6), 0n);
  await withTokenGateway(
    {
      [REAL_SOURCE_NETWORK]: [{ symbol: "USDC", address: REAL_SOURCE_ASSET, decimals: 0 }],
      [REAL_DEST_NETWORK]: [VALID_DEST_TOKEN],
    },
    async (gatewayUrl) => {
      const result = await expectRefusalToStart(4128, realEnv(gatewayUrl));
      assert.notEqual(result.exitCode, 0, `expected the merchant to refuse to start:\n${result.output}`);
    },
  );
});

// --- real mode: malformed gateway answers --------------------------------------
//
// A malformed answer is the gateway's fault, not the corridor's, so the refusal must
// point the operator at GATEWAY_URL and the chain asked about — never a bare TypeError
// from reading a field off something that is not an object.

function assertBlamesGateway(
  result: { exitCode: number; output: string },
  { namesGatewayUrl }: { namesGatewayUrl: boolean },
): void {
  assert.notEqual(result.exitCode, 0, `expected the merchant to refuse to start:\n${result.output}`);
  assert.ok(
    result.output.includes(REAL_DEST_NETWORK),
    `the refusal must name the chain whose answer was malformed (${REAL_DEST_NETWORK}):\n${result.output}`,
  );
  if (namesGatewayUrl) {
    assert.ok(result.output.includes("GATEWAY_URL"), `the refusal must point at GATEWAY_URL:\n${result.output}`);
    // A malformed answer says nothing about the configured assets, so sending the
    // operator to check them would chase the wrong setting.
    for (const assetVar of ["SOURCE_ASSET", "DEST_ASSET"]) {
      assert.ok(
        !result.output.includes(assetVar),
        `a malformed gateway answer must not blame ${assetVar}:\n${result.output}`,
      );
    }
  }
  assert.ok(!result.output.includes("TypeError"), `a malformed answer must not surface as a TypeError:\n${result.output}`);
}

const VALID_SOURCE_ANSWER = jsonAnswer(defaultsBody(REAL_SOURCE_NETWORK, [VALID_SOURCE_TOKEN]));

test("real mode names the gateway when /v1/defaults answers JSON null", async () => {
  await withRawGateway(
    { [REAL_SOURCE_NETWORK]: VALID_SOURCE_ANSWER, [REAL_DEST_NETWORK]: jsonAnswer(null) },
    async (gatewayUrl) => {
      assertBlamesGateway(await expectRefusalToStart(4129, realEnv(gatewayUrl)), { namesGatewayUrl: true });
    },
  );
});

test("real mode names the gateway when /v1/defaults answers HTML", async () => {
  await withRawGateway(
    {
      [REAL_SOURCE_NETWORK]: VALID_SOURCE_ANSWER,
      [REAL_DEST_NETWORK]: { status: 200, contentType: "text/html", body: "<html>not a gateway</html>" },
    },
    async (gatewayUrl) => {
      assertBlamesGateway(await expectRefusalToStart(4130, realEnv(gatewayUrl)), { namesGatewayUrl: true });
    },
  );
});

test("real mode names the gateway when /v1/defaults answers for a different chain", async () => {
  await withRawGateway(
    {
      [REAL_SOURCE_NETWORK]: VALID_SOURCE_ANSWER,
      [REAL_DEST_NETWORK]: jsonAnswer(defaultsBody("eip155:1", [VALID_DEST_TOKEN])),
    },
    async (gatewayUrl) => {
      assertBlamesGateway(await expectRefusalToStart(4131, realEnv(gatewayUrl)), { namesGatewayUrl: true });
    },
  );
});

test("real mode refuses a /v1/defaults answer whose tokens is not an array", async () => {
  await withTokenGateway(
    { [REAL_SOURCE_NETWORK]: [VALID_SOURCE_TOKEN], [REAL_DEST_NETWORK]: {} },
    async (gatewayUrl) => {
      assertBlamesGateway(await expectRefusalToStart(4132, realEnv(gatewayUrl)), { namesGatewayUrl: false });
    },
  );
});

test("real mode skips a malformed token entry and finds the valid one after it", async () => {
  await withTokenGateway(
    { [REAL_SOURCE_NETWORK]: [VALID_SOURCE_TOKEN], [REAL_DEST_NETWORK]: [null, VALID_DEST_TOKEN] },
    async (gatewayUrl) => {
      await withMerchant(4133, realEnv(gatewayUrl), async ({ url }) => {
        const request = await fetchChallenge(url, "order_token_skip_bad_0001");
        assert.equal(
          request.source.amount,
          expectedSourceAmount(FULFILLMENT, MARKUP, 6, 6).toString(),
          `the challenge must be priced off the valid entries:\n${JSON.stringify(request, null, 2)}`,
        );
      });
    },
  );
});

// --- real mode: every field of both tokens comes from the gateway ---------------

test("real mode applies the destination decimals the gateway reports", async () => {
  // Large enough that rescaling 18 -> 6 decimals still leaves a non-zero cap, and far
  // from the 6/6 result, so an assumed destination decimals cannot pass.
  const fulfillment = 10_000_000_000_000_000_000n;
  const expected = expectedSourceAmount(fulfillment, MARKUP, 6, 18);
  assert.notEqual(expected, 0n);
  assert.notEqual(expected, expectedSourceAmount(fulfillment, MARKUP, 6, 6));
  await withTokenGateway(
    {
      [REAL_SOURCE_NETWORK]: [VALID_SOURCE_TOKEN],
      [REAL_DEST_NETWORK]: [{ symbol: "pathUSD", address: REAL_DEST_ASSET, decimals: 18 }],
    },
    async (gatewayUrl) => {
      const env = { ...realEnv(gatewayUrl), FULFILLMENT_AMOUNT: fulfillment.toString() };
      await withMerchant(4134, env, async ({ url }) => {
        const request = await fetchChallenge(url, "order_token_dest_decimals_0001");
        assert.equal(
          request.source.amount,
          expected.toString(),
          `the spend cap must be rescaled from 18 to 6 decimals:\n${JSON.stringify(request, null, 2)}`,
        );
      });
    },
  );
});

test("real mode refuses to start when the gateway does not list the source token", async () => {
  await withTokenGateway(
    {
      [REAL_SOURCE_NETWORK]: [
        { symbol: "EURC", address: "0x808456652fdb597867f38412077A9182bf77359F", decimals: 6 },
      ],
      [REAL_DEST_NETWORK]: [VALID_DEST_TOKEN],
    },
    async (gatewayUrl) => {
      const result = await expectRefusalToStart(4135, realEnv(gatewayUrl));
      assert.notEqual(result.exitCode, 0, `expected the merchant to refuse to start:\n${result.output}`);
      assert.ok(
        result.output.includes(REAL_SOURCE_NETWORK),
        `the refusal must name the chain the token is missing on (${REAL_SOURCE_NETWORK}):\n${result.output}`,
      );
      assert.ok(
        result.output.toLowerCase().includes(REAL_SOURCE_ASSET.toLowerCase()),
        `the refusal must name the missing token (${REAL_SOURCE_ASSET}):\n${result.output}`,
      );
    },
  );
});

// --- refusals that already hold --------------------------------------------------

test("stub mode refuses to start on a fulfillment amount the SDK would refuse", async () => {
  // A fractional atomic amount is not a charge any token can carry; booting anyway would
  // answer every request with a 500 instead of telling the operator once.
  const result = await expectRefusalToStart(4136, {
    ...STUB_ENV,
    SOURCE_NETWORK: undefined,
    SOURCE_ASSET: undefined,
    DEST_NETWORK: undefined,
    DEST_ASSET: undefined,
    FULFILLMENT_AMOUNT: "1.5",
    MARKUP_BPS: MARKUP.toString(),
  });
  assert.notEqual(result.exitCode, 0, `expected the merchant to refuse to start:\n${result.output}`);
  assert.match(result.output, /fulfillmentAmount/, `the refusal must name the invalid amount:\n${result.output}`);
});

test("real mode names the gateway when /v1/defaults answers HTTP 500", async () => {
  await withRawGateway(
    {
      [REAL_SOURCE_NETWORK]: VALID_SOURCE_ANSWER,
      [REAL_DEST_NETWORK]: {
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ code: "INTERNAL", message: "boom" }),
      },
    },
    async (gatewayUrl) => {
      const result = await expectRefusalToStart(4137, realEnv(gatewayUrl));
      assert.notEqual(result.exitCode, 0, `expected the merchant to refuse to start:\n${result.output}`);
      assert.ok(
        result.output.includes(REAL_DEST_NETWORK),
        `the refusal must name the chain whose lookup failed (${REAL_DEST_NETWORK}):\n${result.output}`,
      );
      assert.ok(result.output.includes("GATEWAY_URL"), `the refusal must point at GATEWAY_URL:\n${result.output}`);
    },
  );
});

// --- real mode: gateway-supplied metadata is checked where it is read -------------
//
// Metadata the gateway supplies is the gateway's to get right, so a bad field must be
// refused where it is read, pointing at GATEWAY_URL and the token it describes. The SDK's
// own `destination.decimals` / `destination.symbol` wording names neither, so seeing it
// means the merchant let the bad value through to the SDK.

function assertBlamesGatewayMetadata(result: { exitCode: number; output: string }): void {
  assert.notEqual(result.exitCode, 0, `expected the merchant to refuse to start:\n${result.output}`);
  assert.ok(result.output.includes("GATEWAY_URL"), `the refusal must point at GATEWAY_URL:\n${result.output}`);
  assert.ok(
    result.output.includes(REAL_DEST_NETWORK),
    `the refusal must name the chain the token is listed on (${REAL_DEST_NETWORK}):\n${result.output}`,
  );
  assert.ok(
    result.output.toLowerCase().includes(REAL_DEST_ASSET.toLowerCase()),
    `the refusal must name the token (${REAL_DEST_ASSET}):\n${result.output}`,
  );
  for (const sdkField of ["destination.decimals", "destination.symbol"]) {
    assert.ok(
      !result.output.includes(sdkField),
      `the merchant must refuse the gateway's metadata itself, not leave it to the SDK (${sdkField}):\n${result.output}`,
    );
  }
}

function refuseDestToken(port: number, destToken: Record<string, unknown>) {
  return new Promise<{ exitCode: number; output: string }>((resolve, reject) => {
    withTokenGateway(
      { [REAL_SOURCE_NETWORK]: [VALID_SOURCE_TOKEN], [REAL_DEST_NETWORK]: [destToken] },
      async (gatewayUrl) => resolve(await expectRefusalToStart(port, realEnv(gatewayUrl))),
    ).catch(reject);
  });
}

test("real mode refuses gateway-reported fractional decimals and blames the gateway", async () => {
  assertBlamesGatewayMetadata(
    await refuseDestToken(4138, { symbol: "pathUSD", address: REAL_DEST_ASSET, decimals: 1.5 }),
  );
});

test("real mode refuses a gateway token with no symbol and blames the gateway", async () => {
  assertBlamesGatewayMetadata(await refuseDestToken(4139, { address: REAL_DEST_ASSET, decimals: 6 }));
});

test("real mode refuses a gateway token with an empty symbol and blames the gateway", async () => {
  assertBlamesGatewayMetadata(
    await refuseDestToken(4140, { symbol: "", address: REAL_DEST_ASSET, decimals: 6 }),
  );
});

test("real mode refuses gateway-reported decimals beyond any token's range", async () => {
  // Only the refusal is pinned: whether the merchant or the SDK's range check catches it,
  // a merchant that boots on 78 decimals would price every cap absurdly.
  const result = await refuseDestToken(4141, { symbol: "pathUSD", address: REAL_DEST_ASSET, decimals: 78 });
  assert.notEqual(result.exitCode, 0, `expected the merchant to refuse to start:\n${result.output}`);
});

// --- real mode: an every-chain answer to a one-chain lookup -------------------------

test("real mode refuses an every-chain map where one chain's defaults were asked for", async () => {
  // The shape a gateway answers when chain_id is ignored: defaults keyed by chain, with no
  // top-level chain_id. The entry inside is valid, so only the shape can cause a refusal.
  await withRawGateway(
    {
      [REAL_SOURCE_NETWORK]: VALID_SOURCE_ANSWER,
      [REAL_DEST_NETWORK]: jsonAnswer({ [REAL_DEST_NETWORK]: defaultsBody(REAL_DEST_NETWORK, [VALID_DEST_TOKEN]) }),
    },
    async (gatewayUrl) => {
      const result = await expectRefusalToStart(4142, realEnv(gatewayUrl));
      assertBlamesGateway(result, { namesGatewayUrl: true });
      assert.ok(
        !result.output.includes("every chain rather than"),
        `the refusal must be the merchant's own, not the gateway client's wording:\n${result.output}`,
      );
    },
  );
});

// --- real mode: GATEWAY_URL is never printed whole ---------------------------------
//
// A gateway URL can carry a credential in its path or query, and the merchant's output
// lands in terminals and CI logs, so only its origin may ever be printed.

const PATH_SECRET = "PATHSECRET";
const QUERY_SECRET = "QUERYSECRET";

// The gateway client appends /v1/defaults to GATEWAY_URL as a string, so a credential can
// only ride in the path; one in a query would end up in front of /v1/defaults.
function secretGatewayUrl(gatewayOrigin: string): string {
  return `${gatewayOrigin}/sk_live_${PATH_SECRET}`;
}

function assertNoGatewaySecrets(output: string): void {
  assert.ok(!output.includes(PATH_SECRET), `the gateway URL's path must not be printed:\n${output}`);
  assert.ok(!output.includes(QUERY_SECRET), `the gateway URL's query must not be printed:\n${output}`);
}

// Proves the lookup went through the secret path and the gateway answered this chain, so
// a refusal came from reading that answer rather than from a failed fetch.
function assertServedUnderSecretPath(served: ServedLookup[], chainId: string): void {
  assert.ok(
    served.some((l) => l.chainId === chainId && l.pathname === `/sk_live_${PATH_SECRET}/v1/defaults`),
    `the gateway must have answered ${chainId} under the secret path (served: ${JSON.stringify(served)})`,
  );
}

test("real mode prints only the gateway's origin when it boots", async () => {
  await withTokenGateway(
    { [REAL_SOURCE_NETWORK]: [VALID_SOURCE_TOKEN], [REAL_DEST_NETWORK]: [VALID_DEST_TOKEN] },
    async (gatewayOrigin) => {
      await withMerchant(4143, realEnv(secretGatewayUrl(gatewayOrigin)), async ({ output }) => {
        // The merchant names its submitter on a line printed after the listening banner, so
        // wait for that whole line (through its newline) before judging what was printed.
        const submitterLine = /^Submitter:.*\n/m;
        for (let i = 0; i < 100 && !submitterLine.test(output()); i++) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        const all = output();
        const submitter = all.match(submitterLine)?.[0];
        assert.ok(submitter, `the merchant must print its Submitter line after listening:\n${all}`);
        assert.ok(
          submitter.includes(gatewayOrigin),
          `the Submitter line must name the gateway's origin ${gatewayOrigin}:\n${all}`,
        );
        assertNoGatewaySecrets(all);
      });
    },
  );
});

test("real mode does not print the gateway URL's secrets when a token is unlisted", async () => {
  await withTokenGateway(
    {
      [REAL_SOURCE_NETWORK]: [VALID_SOURCE_TOKEN],
      [REAL_DEST_NETWORK]: [
        { symbol: "AlphaUSD", address: "0x20c0000000000000000000000000000000000001", decimals: 6 },
      ],
    },
    async (gatewayOrigin, served) => {
      const result = await expectRefusalToStart(4144, realEnv(secretGatewayUrl(gatewayOrigin)));
      assert.notEqual(result.exitCode, 0, `expected the merchant to refuse to start:\n${result.output}`);
      assertServedUnderSecretPath(served(), REAL_DEST_NETWORK);
      assert.ok(
        result.output.toLowerCase().includes(REAL_DEST_ASSET.toLowerCase()),
        `the refusal must be the unlisted-token one, naming ${REAL_DEST_ASSET}:\n${result.output}`,
      );
      assertNoGatewaySecrets(result.output);
    },
  );
});

test("real mode does not print the gateway URL's secrets when an answer is malformed", async () => {
  await withRawGateway(
    { [REAL_SOURCE_NETWORK]: VALID_SOURCE_ANSWER, [REAL_DEST_NETWORK]: jsonAnswer(null) },
    async (gatewayOrigin, served) => {
      const result = await expectRefusalToStart(4145, realEnv(secretGatewayUrl(gatewayOrigin)));
      assert.notEqual(result.exitCode, 0, `expected the merchant to refuse to start:\n${result.output}`);
      assertServedUnderSecretPath(served(), REAL_DEST_NETWORK);
      assert.ok(
        result.output.includes(REAL_DEST_NETWORK),
        `the refusal must name the chain whose answer was malformed (${REAL_DEST_NETWORK}):\n${result.output}`,
      );
      assertNoGatewaySecrets(result.output);
    },
  );
});

test("real mode refuses a GATEWAY_URL that is not a URL", async () => {
  const result = await expectRefusalToStart(4146, realEnv("not a url"));
  assert.notEqual(result.exitCode, 0, `expected the merchant to refuse to start:\n${result.output}`);
  assert.ok(result.output.includes("GATEWAY_URL"), `the refusal must name GATEWAY_URL:\n${result.output}`);
  // The diagnosis itself, not a generic lookup failure that merely mentions the variable.
  assert.ok(result.output.includes("not a valid URL"), `the refusal must say GATEWAY_URL is not a valid URL:\n${result.output}`);
  assert.ok(!result.output.includes("TypeError"), `a bad GATEWAY_URL must not surface as a TypeError:\n${result.output}`);
});

test("real mode refuses a GATEWAY_URL with a query and does not print it", async () => {
  // No lookup can succeed through such a URL, so it must not boot; and since a query is
  // where an API key often rides, the refusal must not echo it either.
  await withTokenGateway(
    { [REAL_SOURCE_NETWORK]: [VALID_SOURCE_TOKEN], [REAL_DEST_NETWORK]: [VALID_DEST_TOKEN] },
    async (gatewayOrigin) => {
      const result = await expectRefusalToStart(4147, realEnv(`${gatewayOrigin}/?api_key=${QUERY_SECRET}`));
      assert.notEqual(result.exitCode, 0, `expected the merchant to refuse to start:\n${result.output}`);
      assert.ok(!result.output.includes(QUERY_SECRET), `the gateway URL's query must not be printed:\n${result.output}`);
    },
  );
});
