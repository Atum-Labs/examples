/*
 * Copyright (c) 2026 Atum Labs, Inc.
 * SPDX-License-Identifier: MIT
 */

import "dotenv/config";
import { randomBytes } from "node:crypto";
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
  type FulfillmentConfirmation,
} from "@atumlabs/payment-gateway-client";
import { collectPayment } from "./purchase.js";
import { startStubGateway } from "./stub-gateway.js";

const USE_STUB_GATEWAY = (process.env.USE_STUB_GATEWAY ?? "true") !== "false";

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
} = process.env;

// Same hosted testnet gateway as mpp-accept-payments and x402-accept-payments.
const DEFAULT_GATEWAY = "https://payment-gw.production-testnet.atum.xyz";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

// Same explorer/name maps as mpp-accept-payments and x402-accept-payments' real-settlement
// reports (src/smoke.test.ts / src/merchant.ts) — kept in sync by hand, same as those two —
// so a real PGC run reads the same way as a real MPP or x402 run.
const TX_EXPLORERS: Record<string, string> = {
  "eip155:84532": "https://sepolia.basescan.org/tx/", // Base Sepolia
  "eip155:42431": "https://explore.testnet.tempo.xyz/tx/", // Tempo Moderato
};
function txLink(chainId: string | undefined, hash: string | undefined): string {
  if (!hash) return "(none)";
  const base = chainId ? TX_EXPLORERS[chainId] : undefined;
  return base ? `${base}${hash}` : `${hash}${chainId ? ` (${chainId})` : ""}`;
}
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
const CORRIDOR_LABEL = `${endpointLabel(SOURCE_NETWORK, SOURCE_ASSET)} → ${endpointLabel(DEST_NETWORK, DEST_ASSET)}`;

/** Only called for a real settlement (never the stub) — matches MPP/x402's
 * "✅ ... SETTLED" real-settlement report so all three apps read the same way. */
function printSettlementReport(
  paymentId: string,
  settledSynchronously: boolean,
  confirmation: FulfillmentConfirmation | undefined,
): void {
  const bar = "─".repeat(72);
  console.log(
    `\n${bar}\n` +
      `  ✅ PGC — SETTLED\n` +
      `     payment id:          ${paymentId}\n` +
      `     corridor:            ${CORRIDOR_LABEL}\n` +
      `     attempts:            ${
        settledSynchronously
          ? "1 (settled inside the gateway's synchronous window)"
          : "collected by waiting for a terminal status (PGC has no purchase re-attempt — see src/purchase.ts)"
      }\n` +
      `     amount:              ${FULFILLMENT_AMOUNT} (atomic) paid to ${destinationAccount}\n` +
      `     source deposit:      ${txLink(confirmation?.source_chain_id, confirmation?.source_tx_hash)}\n` +
      `     destination payout:  ${txLink(confirmation?.destination_chain_id, confirmation?.destination_tx_hash)}\n` +
      `${bar}\n`,
  );
}

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

if (!USE_STUB_GATEWAY && !ADDRESS_RE.test(RAW_DEST_ADDRESS)) {
  console.error("Error: DEST_ADDRESS is required in .env for real settlement (a 0x-prefixed 20-byte address).");
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

if (!PRIVATE_KEY) {
  console.log(`No PRIVATE_KEY set — signing this stub run with a throwaway key (${depositor}).`);
  console.log("It holds no funds and is discarded on exit. Set PRIVATE_KEY in .env to settle for real.");
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
    requiredAllowance: BigInt(FULFILLMENT_AMOUNT),
  });
  console.log(
    result.alreadySufficient
      ? "Source token already approved."
      : `Approved source token (tx ${result.txHash}).`,
  );
}

async function main(): Promise<void> {
  const stub = USE_STUB_GATEWAY
    ? await startStubGateway({
        pendingAttempts: Number(process.env.STUB_PENDING_ATTEMPTS ?? 0),
        settleAs: process.env.STUB_SETTLE_AS === "failed" ? "failed" : "completed",
      })
    : undefined;
  const gatewayUrl = stub?.url ?? (GATEWAY_URL || DEFAULT_GATEWAY);
  const client = new PaymentGatewayClient({ BASE: gatewayUrl });

  try {
    await maybeApproveSource();

    console.log(`Preparing ${sourceAsset} → ${destinationAsset} via ${gatewayUrl} …`);
    console.log(`Request ${requestId} — to re-attempt it: REQUEST_ID=${requestId} npm run pay`);

    // Corridor contract addresses come from GET /v1/defaults. Supplying them here
    // would let them drift from the gateway; the SDK fetches what we omit.
    const paymentRequest = await client.preparePaymentRequest({
      depositor,
      fulfillmentAmount: FULFILLMENT_AMOUNT,
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
      console.log(`  handed back existing payment ${submitted.payment_id} — nothing additional was charged`);
    }

    const outcome = isTerminalStatus(submitted.status)
      ? { status: submitted.status, snapshot: submitted }
      : await collectPayment(() => client.payments.getPaymentStatus({ paymentId: submitted.payment_id }));

    if (outcome.status !== "completed") {
      throw new Error(
        `payment ${submitted.payment_id} ${outcome.status} and nothing was delivered. ` +
          `That request id now resolves to this payment for good — start another under a NEW id.`,
      );
    }

    const confirmation =
      "fulfillment_confirmation" in outcome.snapshot
        ? outcome.snapshot.fulfillment_confirmation
        : undefined;
    console.log(`  settled — payment ${submitted.payment_id}`);
    console.log(JSON.stringify({ payment_id: submitted.payment_id, status: outcome.status, confirmation }, null, 2));
    if (!USE_STUB_GATEWAY) {
      printSettlementReport(submitted.payment_id, isTerminalStatus(submitted.status), confirmation);
    }
  } finally {
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
