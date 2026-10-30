/*
 * Copyright (c) 2026 Atum Labs, Inc.
 * SPDX-License-Identifier: MIT
 */

import "dotenv/config";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { ethers } from "ethers";
import {
  PaymentGatewayClient,
  createSenderSigner,
  signPaymentRequest,
  ensureSourceApproval,
  getErrorResponse,
  isApiError,
  isGatewayTimeoutError,
  isTerminalStatus,
  assetChainId,
  defaultGateway,
  type PaymentTransactions,
} from "@atumlabs/payment-gateway-client";
import {
  SessionTokenError,
  createSessionTokenSource,
  signerFromEthersWallet,
} from "@atumlabs/payment-gateway-client/signing";
import { collectPayment } from "./purchase.js";
import { STUB_OUTCOMES, startStubGateway } from "./stub-gateway.js";
import { startStubAuth, stubCredential, type StubAuth } from "./stub-auth.js";
import { assetName, banner, corridorLabel, detail, formatAmount, line, logArrival, settledAfter } from "./display.js";

const USE_STUB_GATEWAY = (process.env.USE_STUB_GATEWAY ?? "true") !== "false";

// Opt-in: request a Platform Authentication session token and send it on every gateway call.
const USE_SESSION_TOKEN = process.env.USE_SESSION_TOKEN === "true";

const {
  PRIVATE_KEY,
  RPC_URL,
  REQUEST_ID,
  DEST_ADDRESS: RAW_DEST_ADDRESS = "",
  GATEWAY_URL,
  SOURCE_NETWORK = "eip155:84532",
  SOURCE_ASSET = "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  DEST_NETWORK = "eip155:42431",
  DEST_ASSET = "0x20c0000000000000000000000000000000000000",
  FULFILLMENT_AMOUNT = "50000",
  AUTH_URL = "https://auth.production-testnet.atum.xyz",
  CREDENTIAL_FILE,
} = process.env;

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

const CORRIDOR_LABEL = corridorLabel(SOURCE_NETWORK, SOURCE_ASSET, DEST_NETWORK, DEST_ASSET);

// A stub run needs a well-formed key, not a funded one: the payment is signed offline
// and never touches a chain. So rather than stop a first run to go and produce a key,
// generate a throwaway one when none is set.
//
// RPC_URL is what separates that from a real settlement — it is only set when there
// is a chain to approve on. There a generated key would mean an unfunded address, and
// the first thing to notice would be a failed transaction rather than the missing
// config behind it, so keep refusing.
if (!PRIVATE_KEY && (RPC_URL || !USE_STUB_GATEWAY)) {
  console.error(
    "Error: PRIVATE_KEY is required in .env for real settlement (RPC_URL is set or USE_STUB_GATEWAY=false).",
  );
  process.exit(1);
}

// A real session needs the Known to Atum credential issued to the payer's wallet. It comes from
// Atum's onboarding, so unlike a stub key it cannot be generated here.
if (USE_SESSION_TOKEN && !USE_STUB_GATEWAY && !CREDENTIAL_FILE) {
  console.error(
    "Error: CREDENTIAL_FILE is required when USE_SESSION_TOKEN=true and USE_STUB_GATEWAY=false: " +
      "the Known to Atum credential issued to the wallet in PRIVATE_KEY.",
  );
  process.exit(1);
}

if (!USE_STUB_GATEWAY && !ADDRESS_RE.test(RAW_DEST_ADDRESS)) {
  console.error("Error: DEST_ADDRESS is required in .env for real settlement (a 0x-prefixed 20-byte address).");
  process.exit(1);
}

// The spend cap the payer signs into the Permit2: the most the escrow may take from the source,
// in the source token's smallest units. The default pairs with the default FULFILLMENT_AMOUNT
// (50000 plus 2 bps). This example never derives a cap from another amount, because that needs
// both tokens' decimals and a price; change one and you must state the other.
const DEFAULT_MAX_SOURCE_AMOUNT = "50010";
if (process.env.FULFILLMENT_AMOUNT !== undefined && process.env.MAX_SOURCE_AMOUNT === undefined) {
  console.error(
    "Error: MAX_SOURCE_AMOUNT is required when FULFILLMENT_AMOUNT is set: the most the payer authorizes " +
      "from the source, in the source token's smallest units.",
  );
  process.exit(1);
}
const MAX_SOURCE_AMOUNT = process.env.MAX_SOURCE_AMOUNT ?? DEFAULT_MAX_SOURCE_AMOUNT;
if (!/^[1-9][0-9]*$/.test(MAX_SOURCE_AMOUNT)) {
  console.error(
    `Error: MAX_SOURCE_AMOUNT must be a positive integer in the source token's smallest units, got "${MAX_SOURCE_AMOUNT}".`,
  );
  process.exit(1);
}

const privateKey = PRIVATE_KEY || ethers.Wallet.createRandom().privateKey;

// Names the payment this run is submitting. The SDK requires it — it seeds the
// on-chain deposit nonce and is the idempotency key the gateway dedups on — and
// will not invent one, because a generated fallback would look reusable while
// making every retry a second payment.
//
// This identifies ONE PAYMENT, not an order. An order can outlive several
// payments: if a payment fails terminally its identifier is spent for good, and
// charging for the same goods again means a new identifier. So a real integration
// derives this from both — e.g. `${order.id}-${order.paymentAttempts}`.
//
// A fresh id per run is the safe default. Set REQUEST_ID to resume one that was
// interrupted while it was still settling:
//
//   REQUEST_ID=<the id printed below> npm run pay
//
// Don't put REQUEST_ID in .env: a value left set there would make every run
// re-attempt the same payment.
const requestId = REQUEST_ID || `pmt_${randomBytes(10).toString("hex")}`;

const wallet = new ethers.Wallet(privateKey);
const depositor = wallet.address;
const destinationAccount = ADDRESS_RE.test(RAW_DEST_ADDRESS)
  ? RAW_DEST_ADDRESS
  : "0x000000000000000000000000000000000000dEaD";

const sourceAsset = `${SOURCE_NETWORK}/erc20:${SOURCE_ASSET}`;
const destinationAsset = `${DEST_NETWORK}/erc20:${DEST_ASSET}`;

banner("Payment Gateway client", USE_STUB_GATEWAY ? "stub  ·  no funds" : "real settlement");

if (!PRIVATE_KEY) {
  line("🔑", `No PRIVATE_KEY set — signing this stub run with a throwaway key (${depositor}).`);
}

/**
 * Refuse to approve on a different chain than the one the payment names.
 *
 * The corridor is configurable (SOURCE_NETWORK vs RPC_URL) independently — so
 * "I repointed the corridor but not the RPC" is the natural mistake, and an
 * on-chain revert is otherwise the first thing that notices.
 */
async function assertSignerOnNetwork(provider: ethers.Provider, caip2: string): Promise<void> {
  const [namespace, reference] = caip2.split(":");
  if (namespace !== "eip155" || !reference) return;
  const expected = BigInt(reference);
  const actual = (await provider.getNetwork()).chainId;
  if (actual !== expected) {
    throw new Error(
      `RPC_URL is chain ${actual}, but this payment settles on ${caip2} (chain ${expected}). ` +
        `Point RPC_URL at that chain: approving on the wrong one lets the escrow deposit ` +
        `revert at settlement, which is a terminal failure that spends this request id.`,
    );
  }
}

async function maybeApproveSource(): Promise<void> {
  if (!RPC_URL) return;
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const signer = new ethers.Wallet(privateKey, provider);
  await assertSignerOnNetwork(provider, SOURCE_NETWORK);
  const result = await ensureSourceApproval({
    network: SOURCE_NETWORK,
    token: SOURCE_ASSET,
    owner: depositor,
    signer,
    // The escrow can pull up to the cap, not just the fulfillment amount.
    requiredAllowance: BigInt(MAX_SOURCE_AMOUNT),
  });
  console.log(
    result.alreadySufficient
      ? "✅  Source token already approved."
      : `✍️  Approved source token (tx ${result.txHash}).`,
  );
}

/**
 * Keeps a session token current for the gateway client. The presentation that earns it is signed
 * by the wallet the credential is issued to: here, the payer.
 *
 * A failed renewal never fails a payment. The source keeps sending the token it holds while it
 * is valid, and once none is valid the calls go without one, as an anonymous caller.
 */
function sessionTokens(stubAuth: StubAuth | undefined) {
  const credentials = stubAuth
    ? [stubCredential(depositor)]
    : [JSON.parse(readFileSync(CREDENTIAL_FILE as string, "utf8")) as unknown];
  return createSessionTokenSource({
    authUrl: stubAuth?.url ?? AUTH_URL,
    credentials,
    signer: signerFromEthersWallet(wallet),
    onError: (error) => {
      const why =
        error instanceof SessionTokenError
          ? `${error.status}${error.code ? ` ${error.code}` : ""}`
          : (error as Error).message;
      line("⚠️", `No session token (${why}): gateway calls go without one until a renewal succeeds.`);
    },
  });
}

async function main(): Promise<void> {
  const stub = USE_STUB_GATEWAY
    ? await startStubGateway({
        pendingAttempts: Number(process.env.STUB_PENDING_ATTEMPTS ?? 0),
        finalizingChecks: Number(process.env.STUB_FINALIZING_CHECKS ?? 0),
        settleAs: STUB_OUTCOMES.find((o) => o === process.env.STUB_SETTLE_AS) ?? "completed",
      })
    : undefined;
  // Comes from the published client so a host change is not a second literal here.
  const gatewayUrl = stub?.url ?? (GATEWAY_URL || defaultGateway);
  // A stub run pairs the stub gateway with a stub authorization service and credential.
  const stubAuth =
    USE_SESSION_TOKEN && USE_STUB_GATEWAY
      ? await startStubAuth({ refuse: process.env.STUB_AUTH_REFUSE === "true" })
      : undefined;
  const session = USE_SESSION_TOKEN ? sessionTokens(stubAuth) : undefined;
  // TOKEN is asked for on every call, so prepare, submit and each status check send the current
  // token. An empty answer sends no Authorization header.
  const client = new PaymentGatewayClient({
    BASE: gatewayUrl,
    ...(session ? { TOKEN: () => session.token() } : {}),
  });

  try {
    await maybeApproveSource();

    if (session) {
      // Requested up front so the first gateway call already carries it.
      const token = await session.token();
      if (token) line("🎫", `Session token for ${depositor}, sent on every gateway call`);
    }

    line("🎯", `Request ${requestId}`);
    line("🛣️", `${formatAmount(FULFILLMENT_AMOUNT)} ${assetName(DEST_ASSET)}  ·  ${CORRIDOR_LABEL}`);
    line("📡", `Requesting payment via ${USE_STUB_GATEWAY ? "stub gateway" : gatewayUrl}`);

    // Corridor contract addresses come from GET /v1/defaults. Supplying them here
    // would let them drift from the gateway; the SDK fetches what we omit.
    const paymentRequest = await client.preparePaymentRequest({
      depositor,
      fulfillmentAmount: FULFILLMENT_AMOUNT,
      maxSourceAmount: MAX_SOURCE_AMOUNT,
      sourceAsset,
      destinationAccount,
      destinationAsset,
      requestId,
    });

    const signer = createSenderSigner(assetChainId(sourceAsset), {
      provider: "raw",
      privateKey,
      pinnedAddress: depositor,
    });
    await signPaymentRequest(paymentRequest, signer);

    let submitted;
    try {
      submitted = await client.payments.submitPayment({ requestBody: paymentRequest });
    } catch (error) {
      // A thrown error does not mean no payment was created — a request that
      // timed out may still have been accepted. The request_id is the handle
      // that survives that gap; never recover by starting a new one.
      if (isGatewayTimeoutError(error)) {
        throw new Error(
          `submit timed out; the payment may still have been accepted. ` +
            `Re-run under REQUEST_ID=${requestId} to collect it.`,
          { cause: error },
        );
      }
      const gwError = getErrorResponse(error);
      if (gwError?.code === "IDEMPOTENCY_TERMS_MISMATCH") {
        throw new Error(
          `request id ${requestId} already identifies a payment with different economics. ` +
            `Re-submitting cannot amend that payment; a genuinely different one needs a new id.`,
          { cause: error },
        );
      }
      if (gwError) {
        throw new Error(`${gwError.code}: ${gwError.message}`, { cause: error });
      }
      if (isApiError(error)) {
        throw new Error(`HTTP ${error.status} ${error.statusText}`, { cause: error });
      }
      throw error;
    }

    if (submitted.idempotent_replay) {
      console.log(`  ♻️  handed back existing payment ${submitted.payment_id} — nothing additional was charged`);
    }

    // The deposit and payout are shown as soon as the payout is on chain (`finalizing`), not
    // only once it is final: the payout hash is known then, and on a chain slow to finalize
    // `completed` comes minutes later. Shown once, from whichever answer names it first.
    let payoutShown = false;
    const showPayout = (snapshot: { status?: string; transactions?: PaymentTransactions }): void => {
      if (payoutShown) return;
      payoutShown = true;
      const { deposit, fulfillment } = snapshot.transactions ?? {};
      console.log(settledAfter(1, `— payment ${submitted.payment_id}`));
      logArrival({
        destNetwork: fulfillment?.chain_id ?? DEST_NETWORK,
        destAsset: DEST_ASSET,
        destHash: fulfillment?.transaction_hash,
        sourceNetwork: deposit?.chain_id,
        sourceHash: deposit?.transaction_hash,
        stub: USE_STUB_GATEWAY,
      });
      if (snapshot.status === "finalizing") detail("payout on chain, not yet final (finalizing)");
    };

    if (submitted.status === "finalizing") showPayout(submitted);
    const outcome = isTerminalStatus(submitted.status)
      ? { status: submitted.status, snapshot: submitted }
      : await collectPayment(() => client.payments.getPaymentStatus({ paymentId: submitted.payment_id }), {
          onPayout: showPayout,
        });

    if (outcome.status !== "completed" && outcome.status !== "finalizing") {
      throw new Error(
        `payment ${submitted.payment_id} ${outcome.status} and nothing was delivered. ` +
          `That request id now resolves to this payment for good — start another under a NEW id.`,
      );
    }

    showPayout(outcome.snapshot);
    console.log(`Status: ${outcome.status}`);
    if (stub && session) {
      const calls = stub.calls();
      const carried = calls.filter((c) => c.authorization?.startsWith("Bearer ")).length;
      detail(`${carried} of ${calls.length} gateway calls carried the session token`);
    }
    if (outcome.status === "finalizing") {
      // Paid on chain, but the wait ended before its chain made the payout final. It normally
      // becomes completed; exit 5 says so, as send-payment does, without reporting a failure.
      console.log(
        `Payment ${submitted.payment_id} is paid on chain but not yet final. Check it with ` +
          `\`npx payment-status ${submitted.payment_id}\`, or re-run with REQUEST_ID=${requestId} to wait again.`,
      );
      process.exitCode = 5;
    }
  } finally {
    await stubAuth?.close();
    try {
      await stub?.close();
    } catch (closeErr) {
      console.warn(`(stub gateway close failed: ${(closeErr as Error).message})`);
    }
  }
}

main().catch((err: unknown) => {
  console.error(`Request ${requestId} did not complete: ${(err as Error).message}`);
  process.exit(1);
});
