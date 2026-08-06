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
import { registerAtumEscrowScheme } from "@atumlabs/x402-atum-escrow/client";
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

// Optional: preflight Permit2 allowance before signing so a missing
// approve() fails fast here instead of reverting on-chain at settle.
if (RPC_URL) {
  const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const owner = await wallet.getAddress();

  client.onBeforePaymentCreation(async ({ selectedRequirements }) => {
    const erc20 = new ethers.Contract(
      selectedRequirements.asset,
      ["function allowance(address,address) view returns (uint256)"],
      provider,
    );
    const allowance = (await erc20.allowance(owner, PERMIT2)) as bigint;
    if (allowance < BigInt(selectedRequirements.amount)) {
      return {
        abort: true,
        reason: `Insufficient Permit2 allowance on ${selectedRequirements.asset}. Run approve(Permit2) on your source token first.`,
      };
    }
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
