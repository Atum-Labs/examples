/*
 * Copyright (c) 2026 Atum Labs, Inc. All rights reserved.
 * Proprietary reference implementation; not open source.
 * Access and use are governed by the LICENSE file at the root of this repository.
 * Do not remove, alter, or obscure this notice.
 */

import * as http from "node:http";
import { createHash, randomUUID } from "node:crypto";
import "dotenv/config";
import { Receipt } from "mppx";
import { Mppx } from "mppx/server";
import {
  registerServer,
  buildChargeChallenge,
  corridorFromDefaults,
  type AtumEscrowCorridor,
  type AtumEscrowReceipt,
  type PaymentSubmitter,
  type FulfillmentConfirmation,
  type PaymentRequest,
} from "@atumlabs/mppx-atum-escrow/server";
import { PaymentLedger } from "./payments.js";

const PORT = Number(process.env.PORT ?? 4030);

// The purchase being paid for is part of the resource: GET /paid/<purchase id>.
//
// MPP needs a per-purchase identifier stamped into the 402 challenge — the payer derives
// the payment's identity from it, and refuses to sign a challenge without one. The
// merchant must therefore know which purchase a request is for BEFORE any payment exists,
// and the request is all it has to go on.
//
// A real merchant's route almost always carries this already — /invoices/4711/pdf,
// /orders/4711/download, /jobs/abc123/result — so integrating means pointing `intentId` at
// a value you have, not adding anything to your API.
const RESOURCE_PREFIX = "/paid";

// mppx HMAC-binds the challenge to this key, so verify() can trust the challenge
// terms without re-deriving them. It must be at least 32 bytes; use a real secret
// in production. The placeholder below is public (it's committed in this repo), so
// it must never protect real settlement — see the guard in main() below.
const DEFAULT_SECRET_KEY = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
const REALM = process.env.REALM ?? "mpp.example.com";
const SECRET_KEY = process.env.MPP_SECRET_KEY ?? DEFAULT_SECRET_KEY;

// Exact amount the merchant receives on the destination chain (atomic units).
const FULFILLMENT_AMOUNT = process.env.FULFILLMENT_AMOUNT ?? "50000"; // 0.05 (6-decimal token)

// The stub submitter runs the full flow locally with no gateway and no funds. Set
// USE_STUB_SUBMITTER=false to settle through a real Atum Payment Gateway instead.
const USE_STUB_SUBMITTER = (process.env.USE_STUB_SUBMITTER ?? "true") !== "false";
const GATEWAY_URL = process.env.GATEWAY_URL ?? "https://payment-gw.production-testnet.atum.xyz";

// The public placeholder secret is fine for the stub flow (nothing of value is at
// stake), but would let anyone who's read this repo forge a trusted challenge
// against a real gateway. Refuse to settle real money with it.
if (!USE_STUB_SUBMITTER && SECRET_KEY === DEFAULT_SECRET_KEY) {
  console.error(
    "Refusing to start: MPP_SECRET_KEY is still the public placeholder from .env.example, " +
      "and USE_STUB_SUBMITTER=false means real settlement is enabled. Set a real, private " +
      "MPP_SECRET_KEY before accepting real payments.",
  );
  process.exit(1);
}

// What the merchant receives, the source it accepts, and the pricing/deadline budgets.
// The corridor's contract addresses (escrow, reserver, releaser, fulfillment proxy,
// verifier) are NOT configured here: against a real gateway they're fetched from
// `/defaults` by `corridorFromDefaults`; the offline stub uses built-in placeholders.
const DEST_NETWORK = process.env.DEST_NETWORK ?? "eip155:42431"; // Tempo Moderato
const DEST_ASSET = process.env.DEST_ASSET ?? "0x20c0000000000000000000000000000000000000"; // Tempo pathUSD
// Where the merchant gets paid on the destination chain. Use DEST_ADDRESS when it's a
// valid address; otherwise fall back to a throwaway so the stub demo runs with no .env
// edits. That fallback is safe only for the stub (nothing actually settles) — the guard
// below rejects it in real mode, so real funds can never be paid to a dead address.
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const RAW_DEST_ADDRESS = process.env.DEST_ADDRESS ?? "";
const DEST_ACCOUNT = ADDRESS_RE.test(RAW_DEST_ADDRESS)
  ? RAW_DEST_ADDRESS
  : "0x000000000000000000000000000000000000dEaD";

// Real settlement pays out to DEST_ACCOUNT. The .env.example placeholder is not a real
// address, and the code fallback above is a throwaway — so refuse to start real
// settlement until DEST_ADDRESS is set to a valid address. Otherwise a config slip would
// settle real funds to an address nobody controls (mirrors x402-accept).
if (!USE_STUB_SUBMITTER && !ADDRESS_RE.test(RAW_DEST_ADDRESS)) {
  console.error(
    "Refusing to start: USE_STUB_SUBMITTER=false enables real settlement, but DEST_ADDRESS " +
      "is not a valid address. Set DEST_ADDRESS in .env to your receiving address on the " +
      "destination chain before accepting real payments.",
  );
  process.exit(1);
}
const SOURCE_NETWORK = process.env.SOURCE_NETWORK ?? "eip155:84532"; // Base Sepolia
const SOURCE_ASSET = process.env.SOURCE_ASSET ?? "0x036CbD53842c5426634e7929541eC2318f3dCF7e"; // Base Sepolia USDC
// Markup over the fulfillment amount to derive the source spend cap (300 = 3%).
const MARKUP_BPS = Number(process.env.MARKUP_BPS ?? "300");
const QUOTE_DEADLINE_SECONDS = Number(process.env.QUOTE_DEADLINE_SECONDS ?? "5");
const FULFILLMENT_DEADLINE_SECONDS = Number(process.env.FULFILLMENT_DEADLINE_SECONDS ?? "120");

const destination = { network: DEST_NETWORK, asset: DEST_ASSET, account: DEST_ACCOUNT };
const budgets = {
  markupBps: MARKUP_BPS,
  quoteDeadlineSeconds: QUOTE_DEADLINE_SECONDS,
  fulfillmentDeadlineSeconds: FULFILLMENT_DEADLINE_SECONDS,
};

// A static corridor for the offline demo. The escrow/role/proxy/verifier values are
// placeholders the stub submitter accepts — real ones come from the gateway (see setup()).
function stubCorridor(): AtumEscrowCorridor {
  return {
    destination,
    fulfillmentProxy: "0x0000000000000000000000000000000000000007",
    ...budgets,
    sources: [
      {
        network: SOURCE_NETWORK,
        assets: [SOURCE_ASSET],
        escrow: "0x0000000000000000000000000000000000000004",
        reserver: "0x0000000000000000000000000000000000000005",
        releaser: "0x0000000000000000000000000000000000000006",
        fulfillmentVerifierEndpoint: "https://verifier.example/verify",
      },
    ],
  };
}

// How many attempts at a purchase the STUB reports as still settling before it settles.
// The default of 0 settles on the first attempt. Set it to 2 or 3 to watch the payer's
// re-attempt resolve a slow cross-chain settlement, with no gateway and no funds:
//
//   STUB_PENDING_ATTEMPTS=2 npm run dev
//
// This is a demo knob for the stub only. Nothing on the real path reads it.
const STUB_PENDING_ATTEMPTS = Number(process.env.STUB_PENDING_ATTEMPTS ?? "0");

// Local stub: returns a canned confirmation so the full 402 → pay → 200 flow runs
// without a gateway or on-chain funds. It settles nothing.
function stubSubmitter(corridor: AtumEscrowCorridor): PaymentSubmitter {
  const attemptsByPayment = new Map<string, number>();
  return {
    async submit(request: PaymentRequest) {
      // Key on request_id, the gateway's own dedup key, so every attempt at one purchase
      // reports the SAME payment — as the gateway does when it resolves a retry onto the
      // original payment.
      const requestId = request.request_id ?? "req_stub";
      const paymentId = `pay_stub_${createHash("sha256").update(requestId).digest("hex").slice(0, 32)}`;
      const attempt = (attemptsByPayment.get(requestId) ?? 0) + 1;
      attemptsByPayment.set(requestId, attempt);

      if (attempt <= STUB_PENDING_ATTEMPTS) {
        return { payment_id: paymentId, status: "pending" };
      }

      const confirmation: FulfillmentConfirmation = {
        payment_id: paymentId,
        request_id: requestId,
        fulfillment_timestamp: new Date().toISOString(),
        source_chain_id: corridor.sources[0].network,
        destination_chain_id: corridor.destination.network,
        source_tx_hash: `0x${"11".repeat(32)}`,
        destination_tx_hash: `0x${"22".repeat(32)}`,
      };
      return { payment_id: paymentId, status: "completed", fulfillment_confirmation: confirmation };
    },
  };
}

// Block explorers for the chains this corridor uses, so settlement logs print
// clickable tx links instead of bare hashes. Any chain not listed falls back to
// the raw hash plus its CAIP-2 id.
const TX_EXPLORERS: Record<string, string> = {
  "eip155:84532": "https://sepolia.basescan.org/tx/", // Base Sepolia
  "eip155:42431": "https://explore.testnet.tempo.xyz/tx/", // Tempo Moderato
};

function txLink(chainId: string | undefined, hash: string | undefined): string {
  if (!hash) return "(none)";
  const base = chainId ? TX_EXPLORERS[chainId] : undefined;
  return base ? `${base}${hash}` : `${hash}${chainId ? ` (${chainId})` : ""}`;
}

// Where the money moved: the source-chain escrow deposit and the destination payout.
function logSettlement(confirmation: FulfillmentConfirmation | undefined): void {
  if (!confirmation) return;
  console.log(`  settled payment ${confirmation.payment_id}`);
  console.log(`    source deposit:     ${txLink(confirmation.source_chain_id, confirmation.source_tx_hash)}`);
  console.log(`    destination payout: ${txLink(confirmation.destination_chain_id, confirmation.destination_tx_hash)}`);
}

// Wrap a submitter so every outcome is legible in the merchant's log: the on-chain tx
// hashes on success (the one-glance "did the funds move?" check), and otherwise which of
// the two non-settled outcomes it was — they call for opposite things from the payer.
function withSettlementLog(submitter: PaymentSubmitter): PaymentSubmitter {
  return {
    async submit(request) {
      const result = await submitter.submit(request);
      if (result.fulfillment_confirmation) {
        logSettlement(result.fulfillment_confirmation);
      } else if (result.status === "failed" || result.status === "cancelled") {
        console.log(
          `  payment ${result.payment_id} ${result.status} — terminal; paying for the same ` +
            `goods again needs a NEW purchase id`,
        );
      } else {
        console.log(
          `  payment ${result.payment_id} accepted, still settling — the payer's re-attempt ` +
            `at this purchase will collect the outcome`,
        );
      }
      return result;
    },
  };
}

// Resolve the corridor and the submitter for the chosen mode. MPP has no separate
// facilitator: the merchant verifies in-process and submits through the submitter.
async function setup(): Promise<{ corridor: AtumEscrowCorridor; submitter: PaymentSubmitter }> {
  if (USE_STUB_SUBMITTER) {
    const corridor = stubCorridor();
    return { corridor, submitter: withSettlementLog(stubSubmitter(corridor)) };
  }

  // Real settlement: one gateway client both discovers the corridor addresses and
  // submits the payment.
  const { PaymentGatewayClient } = await import("@atumlabs/payment-gateway-client");
  const gateway = new PaymentGatewayClient({ BASE: GATEWAY_URL });
  const corridor = await corridorFromDefaults(gateway, {
    destination,
    sources: [{ network: SOURCE_NETWORK, assets: [SOURCE_ASSET] }],
    ...budgets,
  });
  // Submit and return what the gateway said — do NOT poll for completion here.
  //
  // The gateway holds the connection for up to ~30s waiting for settlement. If it finishes
  // in that window we get the FulfillmentConfirmation; if not, we get a payment id and a
  // `pending` status, and that is the honest answer to give back.
  //
  // Polling here instead would hold the payer's own HTTP request open for the whole
  // settlement window — the classic proxy and load-balancer timeout — and would hide the
  // pending state that makes the payer's re-attempt safe. Passing `status` through is what
  // lets verify() tell a payment still settling from one that failed; those two need
  // opposite responses from the payer.
  const submitter: PaymentSubmitter = {
    async submit(request) {
      const res = await gateway.payments.submitPayment({ requestBody: request as never });
      return {
        payment_id: res.payment_id,
        status: res.status,
        fulfillment_confirmation: res.fulfillment_confirmation as FulfillmentConfirmation | undefined,
      };
    },
  };
  return { corridor, submitter: withSettlementLog(submitter) };
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

// What this merchant sells. Recorded against the payment that funded it, so the same
// payment is never delivered against twice.
const RESOURCE_BODY = { message: "Access granted.", data: "Your premium content here." };

// The Atum payment a settled request was funded by, read back off the Payment-Receipt
// header mppx sets on the 200. That id — not the request, and not the purchase
// identifier — is what fulfilment is keyed on: two payers can name their purchases the
// same thing, and they are still two different payments.
function paymentIdOf(res: http.ServerResponse): string | undefined {
  const header = res.getHeader("payment-receipt");
  if (typeof header !== "string") return undefined;
  try {
    const receipt = Receipt.deserialize(header) as AtumEscrowReceipt;
    return receipt.fulfillmentConfirmation?.payment_id;
  } catch {
    return undefined;
  }
}

async function main() {
  // Print BEFORE setup(). The static SDK imports above (~800KB through tsx) and,
  // in real mode, setup()'s live gateway /defaults call are the slow part of boot,
  // and until this line nothing was logged until both finished — so a slow boot and
  // a dead process looked identical to the smoke tests ("merchant output: <empty>").
  console.log(
    `MPP merchant starting (${USE_STUB_SUBMITTER ? "stub (local, no funds)" : `real gateway ${GATEWAY_URL}`})`,
  );
  const { corridor, submitter } = await setup();
  const source = corridor.sources[0];

  // registerServer takes no corridor: it trusts the HMAC-bound challenge that mppx
  // verifies before verify() runs. One registration serves every corridor you advertise.
  const mppx = Mppx.create({
    realm: REALM,
    secretKey: SECRET_KEY,
    methods: [registerServer({ submitter })],
  });

  const ledger = new PaymentLedger<typeof RESOURCE_BODY>();

  const server = http.createServer(async (req, res) => {
    const path = (req.url ?? "").split("?")[0];
    if (path !== RESOURCE_PREFIX && !path.startsWith(`${RESOURCE_PREFIX}/`)) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found." }));
      return;
    }

    // Which purchase is this? Without it the challenge carries no identity, the payer's
    // client refuses to sign, and a retry could not be told from a second payment — so
    // refuse here, where the message can say what to do.
    const purchaseId = decodeURIComponent(path.slice(RESOURCE_PREFIX.length + 1));
    if (!purchaseId) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: `Name the purchase in the URL: GET ${RESOURCE_PREFIX}/<your order id>. Reuse the ` +
            `same value on every attempt at one payment, so a retry is never charged twice.`,
        }),
      );
      return;
    }

    // A per-HTTP-request id for log correlation only — unrelated to MPP's own
    // request_id/payment_id (those live inside the credential, not visible until
    // mppx has parsed it). Lets you grep one request's lifecycle out of the logs.
    const reqId = randomUUID().slice(0, 8);
    try {
      // buildChargeChallenge stamps the purchase identifier into the challenge metadata.
      // This is the only line that ties Atum to your route: point `intentId` at whatever
      // already identifies the purchase — an order id, an invoice number, a job id.
      const { request, meta } = buildChargeChallenge(
        corridor,
        { network: source.network, asset: source.assets[0] },
        FULFILLMENT_AMOUNT,
        { intentId: purchaseId },
      );
      const route = Mppx.toNodeListener(async (input) =>
        mppx.compose(["atum-escrow/charge", { ...request, meta }])(input),
      );

      // A request carrying a credential is a payment attempt; one without is asking for
      // the challenge. Both can answer 402, and they mean different things.
      const presentedPayment = Boolean(req.headers.authorization);

      const result = await route(req, res);
      if (result.status === 402) {
        console.log(
          presentedPayment
            ? `[${reqId}] → 402: not settled (purchase ${purchaseId}) — see the payment line above`
            : `[${reqId}] → 402: challenge issued (purchase ${purchaseId})`,
        );
        return; // toNodeListener already wrote the response
      }

      // Paid. mppx has set the Payment-Receipt header; deliver against the PAYMENT it
      // names, not against this request — see ./payments.ts.
      res.setHeader("Content-Type", "application/json");
      const paymentId = paymentIdOf(res);
      if (paymentId) {
        const already = ledger.served(paymentId);
        if (already) {
          console.log(
            `[${reqId}] → 200: payment ${paymentId} was already fulfilled — re-serving, not a new sale`,
          );
          res.end(JSON.stringify(already.result));
          return;
        }
        ledger.record(paymentId, RESOURCE_BODY);
      }
      console.log(`[${reqId}] → 200: settled, serving purchase ${purchaseId}`);
      res.end(JSON.stringify(RESOURCE_BODY));
    } catch (err) {
      console.error(`[${reqId}] merchant route error:`, (err as Error).message);
      if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Payment verification or settlement failed." }));
    }
  });

  server.listen(PORT, () => {
    console.log(`MPP merchant listening on http://localhost:${PORT}${RESOURCE_PREFIX}/<purchase id>`);
    console.log(`Submitter: ${USE_STUB_SUBMITTER ? "stub (local, no funds)" : `real gateway ${GATEWAY_URL}`}`);
  });
}

main().catch((err) => {
  console.error("failed to start merchant:", err);
  process.exit(1);
});
