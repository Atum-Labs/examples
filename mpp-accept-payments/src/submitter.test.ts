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

// The real-mode submitter, driven end to end: the merchant boots with USE_STUB_SUBMITTER=false
// against a gateway stand-in this file owns, and the mpp-make-payments payer pays it. The
// stand-in answers POST /v1/payments the way the gateway can, so each outcome a real gateway
// produces is exercised through the same code a production merchant runs, with no network or
// funds:
//
//   - a payout on chain but not yet final (finalizing), served with the receipt
//   - a refusal the gateway asks to retry, which the payer re-attempts
//   - a refusal whose request must change, which stops the payer
//   - a payment waiting on its refund, which stops the payer with how to return the deposit
//   - an error with no classification, or a dropped connection, whose outcome is unknown
//
// GATEWAY_URL carries a secret in its path, as a keyed URL does, and no log may print it.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MERCHANT_DIR = path.resolve(HERE, "..");
const CLIENT_DIR = path.resolve(HERE, "../../mpp-make-payments");
const NO_DOTENV = path.join(HERE, "no-such.env");
const BOOT_TIMEOUT_MS = Number(process.env.MERCHANT_BOOT_TIMEOUT_MS ?? 45_000);

const SOURCE = { network: "eip155:84532", asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", symbol: "USDC" };
const DEST = { network: "eip155:42431", asset: "0x20c0000000000000000000000000000000000000", symbol: "pathUSD" };
const GATEWAY_SECRET = "key-0123456789abcdef";
const PAYMENT_ID = `0x${"cd".repeat(32)}`;
const DEPOSIT_TX = `0x${"aa".repeat(32)}`;
const PAYOUT_TX = `0x${"bb".repeat(32)}`;

function tsxBin(dir: string): string {
  return path.join(dir, "node_modules", ".bin", "tsx");
}

function portAnswers(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(port);
    const settle = (answered: boolean) => {
      socket.destroy();
      resolve(answered);
    };
    socket.setTimeout(2_000, () => settle(false));
    socket.once("connect", () => settle(true));
    socket.once("error", () => settle(false));
  });
}

// An HTTP answer, or "drop": the connection closes with no answer, as a network failure does.
type GatewayAnswer = { status: number; body: Record<string, unknown> } | "drop";

interface Submission {
  producer: string | undefined;
  depositRequestHashV2: string | undefined;
}

function defaults(chainId: string, token: { asset: string; symbol: string }): Record<string, unknown> {
  return {
    chain_id: chainId,
    escrow_contract: "0x00000000000000000000000000000000000000e1",
    quote_selector: "0x00000000000000000000000000000000000000e2",
    fulfillment_proxy: "0x00000000000000000000000000000000000000e3",
    fulfillment_verifier: {
      account: "0x00000000000000000000000000000000000000e4",
      endpoint: "https://verifier.example.com/verify",
    },
    tokens: [{ symbol: token.symbol, address: token.asset, decimals: 6 }],
  };
}

const paidOut = (status: "finalizing" | "completed"): GatewayAnswer => ({
  status: 200,
  body: {
    payment_id: PAYMENT_ID,
    status,
    transactions: {
      deposit: { transaction_hash: DEPOSIT_TX, chain_id: SOURCE.network },
      fulfillment: { transaction_hash: PAYOUT_TX, chain_id: DEST.network },
    },
  },
});

// A gateway stand-in under GATEWAY_URL's secret path: GET /v1/defaults for both corridor
// chains, and POST /v1/payments answering from `answers` in order, repeating the last.
async function withGateway(
  answers: GatewayAnswer[],
  fn: (gatewayUrl: string, submissions: Submission[]) => Promise<void>,
): Promise<void> {
  const submissions: Submission[] = [];
  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://localhost");
    if (!u.pathname.startsWith(`/${GATEWAY_SECRET}/`)) {
      res.writeHead(404).end();
      return;
    }
    if (req.method === "GET" && u.pathname.endsWith("/v1/defaults")) {
      const chainId = u.searchParams.get("chain_id");
      const token = chainId === SOURCE.network ? SOURCE : chainId === DEST.network ? DEST : undefined;
      if (!chainId || !token) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(defaults(chainId, token)));
      return;
    }
    if (req.method === "POST" && u.pathname.endsWith("/v1/payments")) {
      req.resume();
      req.on("end", () => {
        submissions.push({
          producer: req.headers["x-atum-producer"] as string | undefined,
          depositRequestHashV2: req.headers["x-atum-deposit-request-hash-v2"] as string | undefined,
        });
        const answer = answers[Math.min(submissions.length, answers.length) - 1];
        if (answer === "drop") {
          req.socket.destroy();
          return;
        }
        res.writeHead(answer.status, { "content-type": "application/json" }).end(JSON.stringify(answer.body));
      });
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}/${GATEWAY_SECRET}`, submissions);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function waitForListening(child: ChildProcess, port: number, output: () => string): Promise<void> {
  return new Promise((resolve, reject) => {
    const listening = new RegExp(`merchant listening on http://localhost:${port}\\b`, "i");
    const startedAt = Date.now();
    const onExit = (code: number | null) =>
      reject(new Error(`merchant exited (code ${code}) without listening:\n${output()}`));
    child.once("exit", onExit);
    const poll = (): void => {
      if (listening.test(output())) {
        child.removeListener("exit", onExit);
        resolve();
      } else if (Date.now() - startedAt > BOOT_TIMEOUT_MS) {
        child.removeListener("exit", onExit);
        reject(new Error(`merchant did not listen within ${BOOT_TIMEOUT_MS}ms:\n${output()}`));
      } else {
        setTimeout(poll, 100);
      }
    };
    poll();
  });
}

interface Run {
  merchant: string;
  payer: string;
  payerExitCode: number;
}

// Boot the real-mode merchant against the gateway, pay it once with the sibling payer, and
// return both logs.
async function payThroughGateway(port: number, gatewayUrl: string): Promise<Run> {
  if (await portAnswers(port)) {
    throw new Error(`port ${port} is already in use — stop the process holding it (find it with lsof -ti:${port})`);
  }
  const merchant = spawn(tsxBin(MERCHANT_DIR), ["src/merchant.ts"], {
    cwd: MERCHANT_DIR,
    env: {
      ...process.env,
      DOTENV_CONFIG_PATH: NO_DOTENV,
      PORT: String(port),
      USE_STUB_SUBMITTER: "false",
      GATEWAY_URL: gatewayUrl,
      MPP_SECRET_KEY: randomBytes(32).toString("hex"),
      DEST_ADDRESS: "0x00000000000000000000000000000000000000d1",
      SOURCE_NETWORK: SOURCE.network,
      SOURCE_ASSET: SOURCE.asset,
      DEST_NETWORK: DEST.network,
      DEST_ASSET: DEST.asset,
    },
  });
  let merchantLog = "";
  merchant.stdout.on("data", (chunk: Buffer) => (merchantLog += chunk.toString()));
  merchant.stderr.on("data", (chunk: Buffer) => (merchantLog += chunk.toString()));
  try {
    await waitForListening(merchant, port, () => merchantLog);
    const payer = await new Promise<{ exitCode: number; output: string }>((resolve, reject) => {
      const client = spawn(tsxBin(CLIENT_DIR), ["src/client.ts"], {
        cwd: CLIENT_DIR,
        env: {
          ...process.env,
          DOTENV_CONFIG_PATH: NO_DOTENV,
          MERCHANT_URL: `http://localhost:${port}/paid`,
          GATEWAY_URL: gatewayUrl,
          PRIVATE_KEY: `0x${randomBytes(32).toString("hex")}`,
          RPC_URL: "",
          PURCHASE_ID: "",
        },
      });
      let output = "";
      client.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
      client.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
      client.once("error", reject);
      client.once("exit", (code) => resolve({ exitCode: code ?? 1, output }));
    });
    return { merchant: merchantLog, payer: payer.output, payerExitCode: payer.exitCode };
  } finally {
    merchant.kill();
  }
}

function assertNoGatewaySecret(run: Run): void {
  assert.doesNotMatch(run.merchant, new RegExp(GATEWAY_SECRET), `the merchant log printed GATEWAY_URL:\n${run.merchant}`);
  assert.doesNotMatch(run.payer, new RegExp(GATEWAY_SECRET), `the payer log printed GATEWAY_URL:\n${run.payer}`);
}

test("real mode serves a finalizing payout, says it is not yet final, and forwards the diagnostic headers", async () => {
  await withGateway([paidOut("finalizing")], async (gatewayUrl, submissions) => {
    const run = await payThroughGateway(4160, gatewayUrl);
    assert.equal(run.payerExitCode, 0, `payer exited non-zero:\n${run.payer}\n--- merchant ---\n${run.merchant}`);
    assert.equal(submissions.length, 1, `expected one submission:\n${run.merchant}`);
    assert.equal(submissions[0].producer, "mppx", "the submitter must forward context.shadow");
    assert.match(submissions[0].depositRequestHashV2 ?? "", /^0x[0-9a-f]{64}$/);
    assert.match(
      run.merchant,
      new RegExp(`settled — payment ${PAYMENT_ID} \\(finalizing: payout on chain, not yet final\\)`),
      `the merchant must say the payout it served on is not final:\n${run.merchant}`,
    );
    assert.match(run.merchant, new RegExp(`source deposit: .*${DEPOSIT_TX}`), `expected the deposit link:\n${run.merchant}`);
    assert.match(run.merchant, new RegExp(`destination payout: .*${PAYOUT_TX}`), `expected the payout link:\n${run.merchant}`);
    assert.match(run.payer, /payout on chain, not yet final \(finalizing\)/, `expected the payer to say so too:\n${run.payer}`);
    assertNoGatewaySecret(run);
  });
});

test("real mode re-attempts a refusal the gateway asks to retry, and both sides name it", async () => {
  const retryable: GatewayAnswer = {
    status: 503,
    body: {
      code: "AUTHORIZATION_UNAVAILABLE",
      message: "authorization is unavailable; retry shortly",
      retry_classification: "RETRY_AFTER_DELAY",
      request_id_reusable: true,
    },
  };
  await withGateway([retryable, paidOut("completed")], async (gatewayUrl, submissions) => {
    const run = await payThroughGateway(4161, gatewayUrl);
    assert.equal(run.payerExitCode, 0, `payer exited non-zero:\n${run.payer}\n--- merchant ---\n${run.merchant}`);
    assert.equal(submissions.length, 2, `expected the refused attempt and the re-attempt:\n${run.merchant}`);
    assert.match(
      run.merchant,
      /could not take the payment \(AUTHORIZATION_UNAVAILABLE\); nothing was charged/,
      `the merchant must log the refusal:\n${run.merchant}`,
    );
    assert.match(
      run.payer,
      /could not take the payment \(AUTHORIZATION_UNAVAILABLE\); nothing was charged/,
      `the payer must say why it re-attempts:\n${run.payer}`,
    );
    assert.match(run.merchant, new RegExp(`settled — payment ${PAYMENT_ID}$`, "m"), `a completed payout is final:\n${run.merchant}`);
    assertNoGatewaySecret(run);
  });
});

test("real mode stops the payer on a refusal whose request must change, and says how to resume", async () => {
  const rejected: GatewayAnswer = {
    status: 422,
    body: {
      code: "INSUFFICIENT_FUNDS",
      message: "the paying account cannot fund the deposit",
      retry_classification: "NOT_RETRYABLE_FIX_REQUEST",
      request_id_reusable: true,
    },
  };
  await withGateway([rejected], async (gatewayUrl, submissions) => {
    const run = await payThroughGateway(4162, gatewayUrl);
    assert.notEqual(run.payerExitCode, 0, `the payer must not report success:\n${run.payer}`);
    assert.equal(submissions.length, 1, `a refusal that needs a changed request is not re-attempted:\n${run.merchant}`);
    assert.match(
      run.merchant,
      /refused the payment \(INSUFFICIENT_FUNDS\); nothing was charged — the request must change/,
      `the merchant must log the refusal:\n${run.merchant}`,
    );
    assert.match(run.payer, /Status: 400/, `expected the refusal to reach the payer as a 400:\n${run.payer}`);
    assert.match(run.payer, /re-run with PURCHASE_ID=order_[0-9a-f]+/, `expected how to resume:\n${run.payer}`);
    assertNoGatewaySecret(run);
  });
});

test("real mode stops the payer on a payment waiting on its refund, and says how to return the deposit", async () => {
  // Nobody but the payer submits this refund, so re-attempting cannot change it; and a late
  // delivery can still complete the payment, so the payer must not pay again under a new id.
  const refundAvailable: GatewayAnswer = {
    status: 200,
    body: { payment_id: PAYMENT_ID, status: "refund_available" },
  };
  await withGateway([refundAvailable], async (gatewayUrl, submissions) => {
    const run = await payThroughGateway(4163, gatewayUrl);
    assert.notEqual(run.payerExitCode, 0, `a refund is not a delivery:\n${run.payer}`);
    assert.equal(submissions.length, 1, `re-attempting cannot change a refund that waits on the payer:\n${run.merchant}`);
    assert.match(
      run.merchant,
      new RegExp(`payment ${PAYMENT_ID} refund_available — not delivered; its deposit is still in escrow`),
      `the merchant must not call it still settling:\n${run.merchant}`,
    );
    assert.match(run.payer, new RegExp(`payment ${PAYMENT_ID} is refund_available`), `expected the payment id:\n${run.payer}`);
    assert.match(
      run.payer,
      new RegExp(`refund_signature from GET /v1/payments/${PAYMENT_ID}/status`),
      `expected how to return the deposit:\n${run.payer}`,
    );
    assert.doesNotMatch(run.payer, /still settling/, `the payer must not end on "still settling":\n${run.payer}`);
    assertNoGatewaySecret(run);
  });
});

test("real mode answers an unknown outcome as still settling, so the payer re-attempts the same purchase", async () => {
  // A 5xx with no classification: the gateway may have taken the payment. Answered as a
  // failure, the payer would pay again under a new purchase id; answered as still settling,
  // its re-attempt under the same id resolves onto the payment if it exists.
  const unclassified: GatewayAnswer = { status: 500, body: { error: "upstream failure" } };
  await withGateway([unclassified, paidOut("completed")], async (gatewayUrl, submissions) => {
    const run = await payThroughGateway(4164, gatewayUrl);
    assert.equal(run.payerExitCode, 0, `payer exited non-zero:\n${run.payer}\n--- merchant ---\n${run.merchant}`);
    assert.equal(submissions.length, 2, `expected the unknown outcome and the re-attempt:\n${run.merchant}`);
    assert.match(
      run.merchant,
      /the submission's outcome is unknown \(ApiError, HTTP 500\); a payment may exist/,
      `the merchant must log the unknown outcome:\n${run.merchant}`,
    );
    assert.doesNotMatch(run.payer, /NEW purchase id/, `an unknown outcome must not read as terminal:\n${run.payer}`);
    assertNoGatewaySecret(run);
  });
});

test("real mode names the network error when the connection to the gateway drops", async () => {
  // A dropped connection reaches the merchant as a transport error with no HTTP status. Its
  // code tells a wrong host from a refused or reset connection; the URL stays out of the log.
  await withGateway(["drop", paidOut("completed")], async (gatewayUrl, submissions) => {
    const run = await payThroughGateway(4165, gatewayUrl);
    assert.equal(run.payerExitCode, 0, `payer exited non-zero:\n${run.payer}\n--- merchant ---\n${run.merchant}`);
    assert.equal(submissions.length, 2, `expected the dropped attempt and the re-attempt:\n${run.merchant}`);
    assert.match(
      run.merchant,
      /the submission's outcome is unknown \(\w+, ECONNRESET\); a payment may exist/,
      `the merchant must name the network error:\n${run.merchant}`,
    );
    assertNoGatewaySecret(run);
  });
});
