/*
 * Copyright (c) 2026 Atum Labs, Inc. All rights reserved.
 * Proprietary reference implementation; not open source.
 * Access and use are governed by the LICENSE file at the root of this repository.
 * Do not remove, alter, or obscure this notice.
 */

import "dotenv/config";
import { randomBytes } from "node:crypto";
import { ethers } from "ethers";
import { x402Client } from "@x402/fetch";
import { registerAtumEscrowScheme, ensureSourceApproval } from "@atumlabs/x402-atum-escrow/client";
import { wrapFetchWithAtumPayment } from "@atumlabs/x402-atum-escrow/fetch";
import { payPurchase } from "./purchase.js";

const { PRIVATE_KEY, MERCHANT_URL = "http://localhost:4020/paid", RPC_URL, PURCHASE_ID } = process.env;

if (!PRIVATE_KEY) {
  console.error("Error: PRIVATE_KEY is required in .env");
  process.exit(1);
}

// Names the purchase this run is paying for. The client derives the payment's identity
// from it, so Atum resolves a re-attempt onto the original payment instead of taking a
// second one.
//
// This identifies ONE PAYMENT, not an order. An order can outlive several payments: if a
// payment fails terminally its identifier is spent for good, and charging for the same
// goods again means a new identifier. So a real merchant derives this from both — e.g.
// `${order.id}-${order.paymentAttempts}` → "books-123-2". See the README.
//
// A fresh id per run is the safe default: each run is a new payment. Set PURCHASE_ID to
// resume one that was interrupted while it was still settling:
//
//   PURCHASE_ID=<the id printed below> npm run pay
//
// Don't put PURCHASE_ID in .env: a value left set there would make every run re-attempt
// the same payment, and later runs would be served without paying.
const purchaseId = PURCHASE_ID || `order_${randomBytes(10).toString("hex")}`;

const wallet = new ethers.Wallet(PRIVATE_KEY);
const client = new x402Client();
registerAtumEscrowScheme(client, { signer: wallet });

/**
 * Refuse to approve on a different chain than the one the payment names.
 *
 * The corridor is configurable on both sides (the merchant's SOURCE_NETWORK, this
 * client's RPC_URL), and the two are set independently — so "I repointed the corridor
 * but not the RPC" is the natural mistake, and on-chain revert is otherwise the first
 * thing that notices.
 */
async function assertSignerOnNetwork(provider: ethers.Provider, caip2: string): Promise<void> {
  // Networks are CAIP-2 `namespace:reference`. `eip155` is the namespace for every EVM
  // chain (named after EIP-155, which introduced chain ids), and the reference is the
  // chain id itself — so "eip155:84532" is Base Sepolia.
  const [namespace, reference] = caip2.split(":");
  // Only EVM sources are checkable here: a chain id and an ethers provider are
  // EVM-specific, and a non-EVM source (e.g. `solana:…`) never reaches this client
  // anyway — the scheme is registered for `eip155:*` only.
  if (namespace !== "eip155" || !reference) return;
  const expected = BigInt(reference);
  const actual = (await provider.getNetwork()).chainId;
  if (actual !== expected) {
    throw new Error(
      `RPC_URL is chain ${actual}, but this payment settles on ${caip2} (chain ${expected}). ` +
        `Point RPC_URL at that chain: approving on the wrong one lets the escrow deposit ` +
        `revert at settlement, which is a terminal failure that spends this purchase id.`,
    );
  }
}

// Optional: when RPC_URL is set, approve the source token (Permit2) before signing so the
// escrow deposit does not revert at settlement. The token, chain, and exact amount come
// from the 402, and this handler is awaited before the payment is built. `ensureSourceApproval`
// reads the current allowance and only sends a transaction if it falls short, so it is a
// no-op once approved. Leave RPC_URL unset against the stub merchant — there is no real
// chain to approve on.
//
// Worth getting right up front: a deposit that reverts on-chain is a *terminal* settlement
// failure, and a terminal failure spends that purchase identifier for good.
if (RPC_URL) {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const signer = new ethers.Wallet(PRIVATE_KEY, provider);
  const owner = await wallet.getAddress();

  client.onBeforePaymentCreation(async ({ selectedRequirements }) => {
    // The 402 names the chain the payment settles on; RPC_URL names the chain this
    // signer is bound to. Nothing links the two, so a mismatch is silent — and it is
    // not harmless: the approval lands on the wrong chain, the escrow deposit reverts
    // at settlement, and a terminal failure spends this purchase identifier for good.
    // Check here, while it is still a config error rather than a lost payment.
    await assertSignerOnNetwork(provider, selectedRequirements.network);

    const result = await ensureSourceApproval({
      network: selectedRequirements.network,
      token: selectedRequirements.asset,
      owner,
      signer,
      requiredAllowance: BigInt(selectedRequirements.amount),
    });
    console.log(
      result.alreadySufficient
        ? "Source token already approved."
        : `Approved source token (tx ${result.txHash}).`,
    );
  });
}

// The client is built once and reused; the purchase is named per call, so one client can
// pay for any number of distinct purchases without their identities colliding.
const pay = wrapFetchWithAtumPayment(fetch, client);

console.log(`Requesting ${MERCHANT_URL} …`);
console.log(`Purchase ${purchaseId} — to re-attempt it: PURCHASE_ID=${purchaseId} npm run pay`);

try {
  // Re-attempts while settlement is still in flight. Cross-chain settlement can outrun
  // the gateway's ~30s synchronous window; the re-attempt is what collects the outcome.
  const response = await payPurchase(() => pay(MERCHANT_URL, {}, { paymentIdentifier: purchaseId }));
  const body = await response.json().catch(() => response.text());

  console.log(`Status: ${response.status}`);
  console.log(JSON.stringify(body, null, 2));
  if (!response.ok) process.exit(1);
} catch (err) {
  console.error(`Purchase ${purchaseId} did not complete: ${(err as Error).message}`);
  process.exit(1);
}
