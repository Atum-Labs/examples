/*
 * Copyright (c) 2026 Atum Labs, Inc.
 * SPDX-License-Identifier: MIT
 */

import * as http from "node:http";
import { createHash, randomUUID } from "node:crypto";
import "dotenv/config";
import { Receipt } from "mppx";
import { Mppx } from "mppx/server";
import {
  registerServer,
  buildChargeChallenge,
  buildChargeRequest,
  corridorFromDefaults,
  type AtumEscrowCorridor,
  type AtumEscrowReceipt,
  type PaymentSubmitter,
  type FulfillmentConfirmation,
  type PaymentRequest,
} from "@atumlabs/mppx-atum-escrow/server";
import type { PaymentGatewayClient } from "@atumlabs/payment-gateway-client";
import { PaymentLedger } from "./payments.js";
import { assetName, banner, corridorLabel, formatAmount, logArrival } from "./display.js";

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
//
// This does NOT scale itself to the destination asset: the corridor is configurable
// below, and pointing DEST_ASSET at an 18-decimal token leaves 50000 meaning 5e-14 —
// dust, paid without complaint. Set FULFILLMENT_AMOUNT for that token's decimals.
const FULFILLMENT_AMOUNT = process.env.FULFILLMENT_AMOUNT ?? "50000"; // 0.05 (6-decimal token)

// The stub submitter runs the full flow locally with no gateway and no funds. Set
// USE_STUB_SUBMITTER=false to settle through a real Atum Payment Gateway instead.
const USE_STUB_SUBMITTER = (process.env.USE_STUB_SUBMITTER ?? "true") !== "false";
const GATEWAY_URL = process.env.GATEWAY_URL ?? "https://payment-gw.production-testnet.atum.xyz";
// Logs and errors name the gateway by origin only: a gateway URL can carry a credential in
// its path, and these lines end up in logs and CI output.
const GATEWAY_ORIGIN = urlOrigin(GATEWAY_URL);
const GATEWAY_LABEL = GATEWAY_ORIGIN ?? "(GATEWAY_URL is not a valid URL)";

function urlOrigin(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

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
// `/v1/defaults` by `corridorFromDefaults`; the offline stub uses built-in placeholders.
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
// Bidding closes this many seconds after the payer builds the payment, so the window also
// covers signing, the hops to the gateway and any payer clock lag (x402: add your route
// handler's run time). Too short fails with no quote, or is refused as stale.
// Must be less than FULFILLMENT_DEADLINE_SECONDS.
const QUOTE_DEADLINE_SECONDS = Number(process.env.QUOTE_DEADLINE_SECONDS ?? "3");
const FULFILLMENT_DEADLINE_SECONDS = Number(process.env.FULFILLMENT_DEADLINE_SECONDS ?? "120");

// Every corridor token also declares its ticker and decimals. Payers price the spend cap with
// what their trust source reports for the token, so the merchant takes the same values from
// the same place: the gateway's `/v1/defaults` in real mode (see setup()), the stub's table
// offline.
type TokenMetadata = { symbol: string; decimals: number };

const destination = { network: DEST_NETWORK, asset: DEST_ASSET, account: DEST_ACCOUNT };
const budgets = {
  markupBps: MARKUP_BPS,
  quoteDeadlineSeconds: QUOTE_DEADLINE_SECONDS,
  fulfillmentDeadlineSeconds: FULFILLMENT_DEADLINE_SECONDS,
};

// A static corridor for the offline demo. The escrow/role/proxy/verifier values are
// placeholders the stub submitter accepts — real ones come from the gateway (see setup()).
function stubCorridor(): AtumEscrowCorridor {
  const sourceToken = stubTokenMetadata(SOURCE_NETWORK, SOURCE_ASSET);
  const destToken = stubTokenMetadata(DEST_NETWORK, DEST_ASSET);
  return {
    destination: { ...destination, ...destToken },
    fulfillmentProxy: "0x0000000000000000000000000000000000000007",
    ...budgets,
    sources: [
      {
        network: SOURCE_NETWORK,
        assets: [{ address: SOURCE_ASSET, ...sourceToken }],
        escrow: "0x0000000000000000000000000000000000000004",
        reserver: "0x0000000000000000000000000000000000000005",
        releaser: "0x0000000000000000000000000000000000000006",
        fulfillmentVerifierEndpoint: "https://verifier.example/verify",
      },
    ],
  };
}

// A payer checks the escrow and roles in a challenge against an Atum gateway it trusts
// before it signs. Offline there is no gateway, so in stub mode this merchant answers that
// question for its placeholder corridor itself, in the gateway's GET /v1/defaults shape.
// A real merchant never does: the payer's trust source must not be the party being paid.
//
// Token metadata is looked up by address, so a token keeps its own symbol and decimals in
// whichever direction the corridor runs. A token missing here stops the stub at startup, as
// an unlisted token stops real mode: there are no decimals to price its spend cap with. Add
// a token here to run the stub against it.
interface StubChainDefaults {
  chain_id: string;
  escrow_contract: string;
  quote_selector: string;
  fulfillment_proxy: string;
  fulfillment_verifier: { account: string; endpoint: string };
  tokens: { symbol: string; address: string; decimals: number }[];
}

const STUB_KNOWN_TOKENS = new Map<string, { symbol: string; decimals: number }>([
  ["0x036cbd53842c5426634e7929541ec2318f3dcf7e", { symbol: "USDC", decimals: 6 }], // Base Sepolia
  ["0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", { symbol: "USDC", decimals: 6 }], // Base
  ["0x20c0000000000000000000000000000000000000", { symbol: "pathUSD", decimals: 6 }], // Tempo
]);

function stubToken(address: string): StubChainDefaults["tokens"][number] | undefined {
  const known = STUB_KNOWN_TOKENS.get(address.toLowerCase());
  return known && { ...known, address };
}

function stubTokenMetadata(network: string, address: string): TokenMetadata {
  const known = STUB_KNOWN_TOKENS.get(address.toLowerCase());
  if (!known) {
    throw new Error(
      `stub mode doesn't know token ${address} on ${network}; add it to STUB_KNOWN_TOKENS in ` +
        `src/merchant.ts to run the stub against it`,
    );
  }
  return known;
}

// Built from the same corridor the challenge advertises, so the two cannot disagree.
function stubChainDefaults(
  corridor: AtumEscrowCorridor,
  chainId: string,
): StubChainDefaults | undefined {
  const source = corridor.sources[0];
  if (!source || (chainId !== source.network && chainId !== corridor.destination.network)) {
    return undefined;
  }
  const assets = [
    ...(chainId === source.network ? source.assets.map((asset) => asset.address) : []),
    ...(chainId === corridor.destination.network ? [corridor.destination.asset] : []),
  ];
  return {
    chain_id: chainId,
    escrow_contract: source.escrow,
    quote_selector: source.reserver,
    fulfillment_proxy: corridor.fulfillmentProxy,
    fulfillment_verifier: {
      account: source.releaser,
      endpoint: source.fulfillmentVerifierEndpoint,
    },
    tokens: assets.flatMap((asset) => stubToken(asset) ?? []),
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

// Where the money moved: destination arrival (same line stub or real), plus tx links when real.
function logSettlement(confirmation: FulfillmentConfirmation | undefined): void {
  if (!confirmation) return;
  logArrival({
    destNetwork: confirmation.destination_chain_id ?? DEST_NETWORK,
    destAsset: DEST_ASSET,
    destHash: confirmation.destination_tx_hash,
    sourceNetwork: confirmation.source_chain_id,
    sourceHash: confirmation.source_tx_hash,
    stub: USE_STUB_SUBMITTER,
  });
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
      } else if (result.status === "failed") {
        console.log(
          `  ⚠️  payment ${result.payment_id} ${result.status} — terminal; paying for the same ` +
            `goods again needs a NEW purchase id`,
        );
      } else {
        console.log(`⏳  → 402: still settling (payment ${result.payment_id})`);
      }
      return result;
    },
  };
}

// A token's ticker and decimals, as the gateway lists them in GET /v1/defaults. Refusing a
// token the gateway does not list is deliberate: payers price the cap with that same list,
// so a guessed value would only surface later as payments they refuse.
async function gatewayTokenMetadata(
  gateway: Pick<PaymentGatewayClient, "chainDefaults">,
  network: string,
  address: string,
): Promise<TokenMetadata> {
  const lookup = `GET /v1/defaults?chain_id=${network} on the gateway at ${GATEWAY_LABEL}`;
  // Typed by the client, but it is still another service's answer: read it as unknown and
  // check its shape, so a wrong GATEWAY_URL fails with a message instead of a TypeError.
  let answer: unknown;
  try {
    answer = await gateway.chainDefaults.getDefaults({ chainId: network });
  } catch (err) {
    // Only the status is kept: the client's own error quotes the full request URL, which
    // would print whatever credential GATEWAY_URL carries.
    const status = (err as { status?: unknown } | null)?.status;
    const detail = typeof status === "number" ? ` with HTTP ${status}` : "";
    throw new Error(`${lookup} failed${detail}; check GATEWAY_URL`);
  }
  const chain = chainDefaultsFor(answer, network);
  if (!chain) {
    throw new Error(
      `${lookup} did not answer with that chain's defaults; check that GATEWAY_URL points at an ` +
        `Atum payment gateway`,
    );
  }
  if (chain.tokens !== undefined && !Array.isArray(chain.tokens)) {
    throw new Error(`${lookup} answered with a token list that is not a list; check GATEWAY_URL`);
  }
  // EVM addresses are hex, so letter case carries no meaning; elsewhere (e.g. base58) it does.
  const same = network.startsWith("eip155:")
    ? (a: string) => a.toLowerCase() === address.toLowerCase()
    : (a: string) => a === address;
  const token = (chain.tokens ?? []).find(
    (t): t is { address: string; symbol?: unknown; decimals?: unknown } =>
      typeof t === "object" && t !== null && typeof (t as { address?: unknown }).address === "string"
        ? same((t as { address: string }).address)
        : false,
  );
  if (!token) {
    throw new Error(
      `the gateway at ${GATEWAY_LABEL} lists no token ${address} on ${network}, so its symbol and ` +
        `decimals are unknown; check SOURCE_ASSET / DEST_ASSET against GET /v1/defaults`,
    );
  }
  // Checked here rather than left to the SDK, so the error names the gateway the values came
  // from; the SDK still enforces the 0–77 decimals range.
  const { symbol, decimals } = token;
  if (typeof symbol !== "string" || symbol === "" || typeof decimals !== "number" || !Number.isInteger(decimals)) {
    throw new Error(
      `${lookup} lists token ${address} with an unusable symbol or decimals (symbol ` +
        `${JSON.stringify(symbol)}, decimals ${JSON.stringify(decimals)}); check GATEWAY_URL`,
    );
  }
  return { symbol, decimals };
}

// One chain's defaults from a /v1/defaults answer. Asked for one chain, the gateway answers
// with that chain; anything else (including the every-chain map, which the client refuses in
// corridorFromDefaults anyway) is not an answer this merchant can use.
function chainDefaultsFor(answer: unknown, network: string): { tokens?: unknown } | undefined {
  if (typeof answer !== "object" || answer === null) return undefined;
  return (answer as { chain_id?: unknown }).chain_id === network ? (answer as { tokens?: unknown }) : undefined;
}

// This merchant charges one fixed price, so it can build that charge once before serving.
// The SDK would otherwise refuse a bad corridor or price on every request, after the merchant
// reported ready: incompatible tokens, unusable metadata from the gateway, a price whose cap
// rounds below it, or an amount the chain cannot hold.
function assertChargeable(corridor: AtumEscrowCorridor): void {
  buildChargeRequest(corridor, { network: SOURCE_NETWORK, asset: SOURCE_ASSET }, FULFILLMENT_AMOUNT);
}

// Resolve the corridor and the submitter for the chosen mode. MPP has no separate
// facilitator: the merchant verifies in-process and submits through the submitter.
async function setup(): Promise<{ corridor: AtumEscrowCorridor; submitter: PaymentSubmitter }> {
  if (USE_STUB_SUBMITTER) {
    const corridor = stubCorridor();
    assertChargeable(corridor);
    return { corridor, submitter: withSettlementLog(stubSubmitter(corridor)) };
  }

  // Real settlement: one gateway client both discovers the corridor addresses and
  // submits the payment.
  const { PaymentGatewayClient } = await import("@atumlabs/payment-gateway-client");
  const gateway = new PaymentGatewayClient({ BASE: GATEWAY_URL });
  const [destToken, sourceToken] = await Promise.all([
    gatewayTokenMetadata(gateway, DEST_NETWORK, DEST_ASSET),
    gatewayTokenMetadata(gateway, SOURCE_NETWORK, SOURCE_ASSET),
  ]);
  const corridor = await corridorFromDefaults(gateway, {
    destination: { ...destination, ...destToken },
    sources: [{ network: SOURCE_NETWORK, assets: [{ address: SOURCE_ASSET, ...sourceToken }] }],
    ...budgets,
  });
  assertChargeable(corridor);
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
const RESOURCE_BODY = {
  status: "fulfilled",
  message: "Payment received. Report delivered.",
  report: {
    id: "rpt_acme_q3_2026",
    title: "ACME Q3 treasury operations brief",
    format: "application/pdf",
    pages: 14,
    url: "/reports/rpt_acme_q3_2026",
  },
};

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
  // in real mode, setup()'s live gateway /v1/defaults call are the slow part of boot,
  // and until this line nothing was logged until both finished — so a slow boot and
  // a dead process looked identical to the smoke tests ("merchant output: <empty>").
  banner("MPP merchant", USE_STUB_SUBMITTER ? "stub  ·  no funds" : "real settlement");
  console.log(
    `MPP merchant starting (${USE_STUB_SUBMITTER ? "stub (local, no funds)" : `real gateway ${GATEWAY_LABEL}`})`,
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
    if (USE_STUB_SUBMITTER && path === "/v1/defaults") {
      const chainId = new URL(req.url ?? "", "http://stub").searchParams.get("chain_id");
      const defaults = chainId ? stubChainDefaults(corridor, chainId) : undefined;
      res.writeHead(defaults ? 200 : 404, { "Content-Type": "application/json" });
      res.end(JSON.stringify(defaults ?? { error: "this stub serves only its own corridor's chains" }));
      return;
    }
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
        { network: source.network, asset: source.assets[0].address },
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
        if (!presentedPayment) {
          console.log(`🎫  → 402: requesting payment (purchase ${purchaseId})`);
        }
        return; // toNodeListener already wrote the response; pending is logged in withSettlementLog
      }

      // Paid. mppx has set the Payment-Receipt header; deliver against the PAYMENT it
      // names, not against this request — see ./payments.ts.
      res.setHeader("Content-Type", "application/json");
      const paymentId = paymentIdOf(res);
      if (paymentId) {
        const already = ledger.served(paymentId);
        if (already) {
          console.log(
            `♻️  → 200: payment ${paymentId} was already fulfilled — re-serving, not a new sale`,
          );
          res.end(JSON.stringify(already.result));
          return;
        }
        ledger.record(paymentId, RESOURCE_BODY);
      }
      console.log(
        USE_STUB_SUBMITTER
          ? `✅  → 200: settled (stub — no funds moved)${paymentId ? ` — payment ${paymentId}` : ""}`
          : `✅  → 200: settled${paymentId ? ` — payment ${paymentId}` : ""}`,
      );
      res.end(JSON.stringify(RESOURCE_BODY));
    } catch (err) {
      console.error(`[${reqId}] merchant route error:`, (err as Error).message);
      if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Payment verification or settlement failed." }));
    }
  });

  server.listen(PORT, () => {
    console.log(`📡  Merchant listening on http://localhost:${PORT}${RESOURCE_PREFIX}/<purchase id>`);
    console.log(
      `🛣️  ${formatAmount(FULFILLMENT_AMOUNT)} ${assetName(DEST_ASSET)}  ·  ${corridorLabel(SOURCE_NETWORK, SOURCE_ASSET, DEST_NETWORK, DEST_ASSET)}`,
    );
    console.log(`Submitter: ${USE_STUB_SUBMITTER ? "stub (local, no funds)" : `real gateway ${GATEWAY_LABEL}`}`);
    if (USE_STUB_SUBMITTER) {
      console.log(
        `Trust source for the stub demo only: GET http://localhost:${PORT}/v1/defaults answers ` +
          `for this placeholder corridor. A real merchant never answers it.`,
      );
    }
  });
}

main().catch((err) => {
  console.error("failed to start merchant:", err);
  process.exit(1);
});
