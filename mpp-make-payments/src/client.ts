/*
 * Copyright (c) 2026 Atum Labs, Inc.
 * SPDX-License-Identifier: MIT
 */

import "dotenv/config";
import { randomBytes } from "node:crypto";
import { ethers } from "ethers";
import { Mppx } from "mppx/client";
import { registerClient, ensureSourceApproval, type AtumEscrowChallenge } from "@atumlabs/mppx-atum-escrow/client";
import { payPurchase } from "./purchase.js";

const { PRIVATE_KEY, MERCHANT_URL = "http://localhost:4030/paid", RPC_URL, PURCHASE_ID } = process.env;

if (!PRIVATE_KEY) {
  console.error("Error: PRIVATE_KEY is required in .env");
  process.exit(1);
}

// Names the purchase this run is paying for. The merchant stamps it into the 402
// challenge, the client derives the payment's identity from it, and Atum resolves a
// re-attempt onto the original payment instead of taking a second one.
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

// The purchase is part of the resource, the way an invoice or job id already is in most
// merchant APIs (/invoices/4711/pdf). That is how the merchant knows which purchase to
// name in the challenge, before any payment exists.
const resourceUrl = `${MERCHANT_URL.replace(/\/$/, "")}/${encodeURIComponent(purchaseId)}`;

// The source-chain account is derived from the key. The server rejects a credential
// whose deposit signature does not recover to this account, so the two must match.
const account = new ethers.Wallet(PRIVATE_KEY).address;

// Register `atum-escrow` on the mppx client. The private key is bound to the
// challenge's source chain automatically, so one registration pays any supported source.
const method = registerClient({ signer: { privateKey: PRIVATE_KEY }, account });
const mppx = Mppx.create({ methods: [method] });

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
  // anyway — the signer registered above is an EVM key.
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

// Optional: when RPC_URL is set, approve the source token (Permit2) before paying so the
// escrow deposit does not revert at settlement. The token, chain, and exact amount come
// from the 402 challenge, and this handler is awaited before the signed retry. Leave
// RPC_URL unset against the default stub merchant — there is no real chain to approve on.
if (RPC_URL) {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const signer = new ethers.Wallet(PRIVATE_KEY, provider);
  mppx.onChallengeReceived(async ({ challenge }) => {
    const { source } = (challenge as AtumEscrowChallenge).request;
    // The challenge names the chain the payment settles on; RPC_URL names the chain
    // this signer is bound to. Nothing links the two, so a mismatch is silent — and it
    // is not harmless: the approval lands on the wrong chain, the escrow deposit
    // reverts at settlement, and a terminal failure spends this purchase identifier for
    // good. Check here, while it is still a config error rather than a lost payment.
    await assertSignerOnNetwork(provider, source.network);

    const result = await ensureSourceApproval({
      network: source.network,
      token: source.asset,
      owner: account,
      signer,
      requiredAllowance: BigInt(source.amount),
    });
    console.log(
      result.alreadySufficient
        ? "Source token already approved."
        : `Approved source token (tx ${result.txHash}).`,
    );
    // Return nothing: this handler only approves as a side effect. Returning a string
    // here would override mppx's credential creation, which we don't want.
    return undefined;
  });
}

/**
 * One attempt at the purchase: ask for the resource, sign a credential for the challenge
 * it answers with, and resubmit. `mppx.rawFetch` bypasses mppx's own automatic 402
 * handling so the re-attempt loop in ./purchase.ts drives the pacing.
 *
 * Every attempt signs a NEW credential, because the challenge's deadlines are absolute
 * timestamps. The purchase identifier is what stays fixed, and it comes from the URL.
 */
async function attemptPurchase(): Promise<Response> {
  const challengeResponse = await mppx.rawFetch(resourceUrl);
  if (challengeResponse.status !== 402) return challengeResponse;
  const credential = await mppx.createCredential(challengeResponse);
  return mppx.rawFetch(resourceUrl, { headers: { Authorization: credential } });
}

console.log(`Requesting ${resourceUrl} …`);
console.log(`Purchase ${purchaseId} — to re-attempt it: PURCHASE_ID=${purchaseId} npm run pay`);

try {
  // Re-attempts while settlement is still in flight. Cross-chain settlement can outrun
  // the gateway's ~30s synchronous window; the re-attempt is what collects the outcome.
  const response = await payPurchase(attemptPurchase);
  const receipt = response.headers.get("payment-receipt");
  const body = await response.json().catch(() => response.text());

  console.log(`Status: ${response.status}`);
  console.log(`Payment-Receipt header: ${receipt ? "present" : "(none)"}`);
  console.log(JSON.stringify(body, null, 2));
  if (!response.ok) process.exit(1);
} catch (err) {
  console.error(`Purchase ${purchaseId} did not complete: ${(err as Error).message}`);
  process.exit(1);
}
