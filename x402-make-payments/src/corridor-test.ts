/**
 * Optional live-corridor test.
 *
 * Runs the same payment flow as `src/client.ts`, but asserts the outcome so it
 * can be used as a pass/fail check against a REAL Atum facilitator (not the
 * mock). It exits non-zero unless the merchant returns 200 with a settlement
 * receipt on the expected destination network.
 *
 * This is opt-in: it needs a funded source wallet with an approve(Permit2)
 * allowance on the source token. It is intentionally NOT part of the default
 * `npm test` / CI, because it moves real testnet funds.
 *
 * Environment:
 *   PRIVATE_KEY     (required) source-wallet key, 0x-prefixed 32-byte hex
 *   MERCHANT_URL    (required) the x402-gated resource, e.g. http://localhost:4020/paid
 *   EXPECT_NETWORK  (required) destination CAIP-2 the receipt must report, e.g. eip155:42431
 *   RPC_URL         (optional) source-chain RPC; preflights the Permit2 allowance
 */

import "dotenv/config";
import { ethers } from "ethers";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { registerAtumEscrowScheme } from "@atumlabs/x402-atum-escrow/client";

const { PRIVATE_KEY, MERCHANT_URL = "http://localhost:4020/paid", EXPECT_NETWORK, RPC_URL } =
  process.env;

function fail(message: string): never {
  console.error(`✗ ${message}`);
  process.exit(1);
}

if (!PRIVATE_KEY) fail("PRIVATE_KEY is required in .env");
if (!EXPECT_NETWORK) fail("EXPECT_NETWORK is required (destination CAIP-2, e.g. eip155:42431)");

const wallet = new ethers.Wallet(PRIVATE_KEY);
const client = new x402Client();
registerAtumEscrowScheme(client, { signer: wallet });

// Same allowance preflight as client.ts — fail fast on a missing approve(Permit2)
// instead of reverting on-chain at settlement.
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

const fetchWithPayment = wrapFetchWithPayment(fetch, client);

console.log(`→ paying ${MERCHANT_URL} (expecting settlement on ${EXPECT_NETWORK}) …`);
const response = await fetchWithPayment(MERCHANT_URL);

if (response.status !== 200) {
  const detail = await response.text().catch(() => "");
  fail(`expected 200, got ${response.status}. ${detail}`);
}

// The merchant returns the settlement receipt in the PAYMENT-RESPONSE header
// (base64(JSON)); v1 servers use X-PAYMENT-RESPONSE.
const receiptHeader =
  response.headers.get("payment-response") ?? response.headers.get("x-payment-response");
if (!receiptHeader) fail("200 OK but no PAYMENT-RESPONSE header — cannot confirm settlement.");

let receipt: {
  success?: boolean;
  transaction?: string;
  network?: string;
  payer?: string;
  fulfillmentConfirmation?: { mock?: boolean };
};
try {
  receipt = JSON.parse(Buffer.from(receiptHeader, "base64").toString("utf8"));
} catch {
  fail("PAYMENT-RESPONSE header is not base64-encoded JSON.");
}

// Guard against a false pass: the mock facilitator returns success without moving
// funds. A corridor test only means something against a real Atum facilitator.
if (receipt.fulfillmentConfirmation?.mock) {
  fail(
    "settlement came from the MOCK facilitator — point FACILITATOR_URL at a real Atum facilitator and set GATEWAY_URL on the merchant.",
  );
}

if (receipt.success !== true) fail(`settlement did not succeed: ${JSON.stringify(receipt)}`);
if (receipt.network !== EXPECT_NETWORK) {
  fail(`settled on ${receipt.network}, expected ${EXPECT_NETWORK}.`);
}

console.log("✓ corridor settled synchronously");
console.log(`  network:     ${receipt.network}`);
console.log(`  transaction: ${receipt.transaction}`);
console.log(`  payer:       ${receipt.payer}`);
process.exit(0);
