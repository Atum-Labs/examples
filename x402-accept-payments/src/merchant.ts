/*
 * Copyright (c) 2026 Atum Labs, Inc. All rights reserved.
 * Proprietary reference implementation; not open source.
 * Access and use are governed by the LICENSE file at the root of this repository.
 * Do not remove, alter, or obscure this notice.
 */

import "dotenv/config";
import { createHash } from "node:crypto";
import express, { Request, Response } from "express";
import { PaymentLedger } from "./payments.js";

const PORT = Number(process.env.PORT ?? 4020);

// Settlement mode (mirrors mpp-accept-payments' USE_STUB_SUBMITTER).
//   true  — local stub: verify/settle are short-circuited in-process with a canned
//           success, so the full 402 → pay → 200 flow runs with no facilitator,
//           no gateway, and no funds (default).
//   false — settle through a real Atum x402 facilitator. Needs a funded payer, and
//           the corridor's contract addresses are read from the gateway (see below).
const USE_STUB_FACILITATOR = (process.env.USE_STUB_FACILITATOR ?? "true") !== "false";

// Where the merchant sends /verify and /settle in real mode — Atum's hosted x402
// facilitator. Ignored by the stub.
const FACILITATOR_URL =
  process.env.FACILITATOR_URL ?? "https://x402-facilitator.production-testnet.atum.xyz";

// Payment Gateway base URL. In real mode the merchant READS its corridor's contract
// addresses (escrow, proxy, reserver, releaser, verifier) from GET /defaults here at
// startup, rather than hardcoding them — they are Atum-network facts, not merchant
// config. The stub uses built-in placeholders and contacts no gateway.
const GATEWAY_URL = process.env.GATEWAY_URL ?? "https://payment-gw.production-testnet.atum.xyz";

// The exact amount the merchant receives on the destination chain (atomic units).
// Default 50000 = 0.05 of a 6-decimal token (e.g. Tempo pathUSD).
//
// This does NOT scale itself to the destination asset: the corridor is configurable
// below, and pointing DEST_ASSET at an 18-decimal token leaves 50000 meaning 5e-14 —
// dust, paid without complaint. Set FULFILLMENT_AMOUNT for that token's decimals.
const FULFILLMENT_AMOUNT = process.env.FULFILLMENT_AMOUNT ?? "50000";

// Markup over FULFILLMENT_AMOUNT, in basis points (100 bps = 1%). Added on top of
// the fulfillment amount to derive the source-chain spend cap, and covers settlement
// fees and cross-chain conversion.
const MARKUP_BPS = BigInt(process.env.MARKUP_BPS || "300");

// The maximum the payer authorizes on the source chain = fulfillment amount +
// markup. Atum converts this to the exact FULFILLMENT_AMOUNT on the destination
// chain; anything above the fulfillment amount covers fees.
const SOURCE_MAX_AMOUNT = (
  (BigInt(FULFILLMENT_AMOUNT) * (10000n + MARKUP_BPS)) /
  10000n
).toString();

// Business config — the merchant's own decisions (not network facts). Defaults are
// the verified testnet corridor: Base Sepolia USDC → Tempo (Moderato) pathUSD.
const SOURCE_NETWORK = process.env.SOURCE_NETWORK ?? "eip155:84532"; // Base Sepolia
const SOURCE_ASSET = process.env.SOURCE_ASSET ?? "0x036CbD53842c5426634e7929541eC2318f3dCF7e"; // Base Sepolia USDC
const DEST_NETWORK = process.env.DEST_NETWORK ?? "eip155:42431"; // Tempo Moderato
const DEST_ASSET = process.env.DEST_ASSET ?? "0x20c0000000000000000000000000000000000000"; // Tempo pathUSD
// The receiving address on the destination chain. In real mode it must be a valid
// address (the guard in main() enforces it). In stub mode we fall back to a valid
// throwaway so the demo's 402 challenge passes the client SDK's address validation
// without you editing .env.
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const RAW_DEST_ADDRESS = process.env.DEST_ADDRESS ?? "";
const DEST_ADDRESS = ADDRESS_RE.test(RAW_DEST_ADDRESS)
  ? RAW_DEST_ADDRESS
  : "0x000000000000000000000000000000000000dEaD";
// Auction window for settlers to quote. 5s matches the SDK's DEFAULT_QUOTE_DEADLINE_SECONDS
// (and the MPP example); must be strictly less than FULFILLMENT_DEADLINE_SECONDS.
const QUOTE_DEADLINE_SECONDS = Number(process.env.QUOTE_DEADLINE_SECONDS ?? 5);
const FULFILLMENT_DEADLINE_SECONDS = Number(process.env.FULFILLMENT_DEADLINE_SECONDS ?? 120);

// ---------------------------------------------------------------------------
// x402 v2 header names. Each value is base64(JSON) — standard base64, no prefix.
//   PAYMENT-REQUIRED  — response header on the 402 challenge (server → client)
//   PAYMENT-SIGNATURE — request header on the paid retry     (client → server)
//   PAYMENT-RESPONSE  — response header on the 200           (server → client)
// The deprecated x402 v1 names (X-PAYMENT / X-PAYMENT-RESPONSE) are still read
// on the request for backwards compatibility.
// ---------------------------------------------------------------------------

const HEADER_PAYMENT_REQUIRED = "PAYMENT-REQUIRED";
const HEADER_PAYMENT_SIGNATURE = "PAYMENT-SIGNATURE";
const HEADER_PAYMENT_RESPONSE = "PAYMENT-RESPONSE";

const encodeHeader = (value: unknown): string =>
  Buffer.from(JSON.stringify(value), "utf8").toString("base64");

const decodeHeader = <T>(value: string): T =>
  JSON.parse(Buffer.from(value, "base64").toString("utf8")) as T;

// ---------------------------------------------------------------------------
// Types — shapes match x402 v2 and the Facilitator API (atum-escrow scheme).
// ---------------------------------------------------------------------------

interface PaymentRequirements {
  scheme: "atum-escrow";
  network: string; // CAIP-2 source chain (e.g. "eip155:84532")
  asset: string; // Source token contract address
  payTo: string; // Source-chain escrow contract address
  amount: string; // Source spend cap in atomic units
  maxTimeoutSeconds: number;
  extra: {
    atum: {
      destination: { network: string; asset: string; address: string };
      fulfillmentAmount: string;
      escrow: string;
      fulfillmentProxy: string;
      reserver: string;
      releaser: string;
      fulfillmentVerifierEndpoint: string;
      quoteDeadlineSeconds: number;
      fulfillmentDeadlineSeconds: number;
    };
  };
}

interface ResourceInfo {
  url: string;
  description?: string;
  mimeType?: string;
}

// Encoded into the PAYMENT-REQUIRED header on the 402.
interface PaymentRequired {
  x402Version: 2;
  resource: ResourceInfo; // required by the spec — describes the gated resource
  accepts: PaymentRequirements[]; // one entry per payment option offered
  extensions?: Record<string, unknown>; // see PAYMENT_IDENTIFIER below
  error?: string;
}

// Decoded from the PAYMENT-SIGNATURE header on the retry. The signed Atum
// PaymentRequest lives at `payload.paymentRequest`; `extensions` carries the payer's
// echo of the purchase identifier, which travels to the facilitator untouched.
interface PaymentPayload {
  x402Version: 2;
  accepted: PaymentRequirements;
  payload: { paymentRequest: unknown };
  extensions?: Record<string, unknown>;
  resource?: ResourceInfo;
}

interface FacilitatorRequest {
  x402Version: 2;
  paymentPayload: PaymentPayload;
  paymentRequirements: PaymentRequirements;
}

interface VerifyResponse {
  isValid: boolean;
  payer?: string;
  invalidReason?: string;
}

interface SettleResponse {
  success: boolean;
  transaction: string;
  network: string;
  payer?: string;
  /** Machine-readable outcome when `success` is false — see SETTLEMENT_* below. */
  errorReason?: string;
  errorMessage?: string;
  /** The Atum payment this outcome belongs to. Absent only when nothing was accepted. */
  extensions?: { atum?: { paymentId?: string; state?: string; statusUrl?: string } };
  fulfillmentConfirmation?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Naming the purchase — the x402 `payment-identifier` extension.
//
// Every retry re-fetches the resource and gets a fresh 402, so nothing about the rebuilt
// payment is byte-identical to the last attempt. The identifier the payer gives the
// purchase is what stays fixed: the payer's client derives the payment's `request_id`
// from it and Atum de-duplicates on that, so a re-attempt resolves to the ORIGINAL
// payment instead of taking a second one.
//
// This merchant declares that an identifier is required and never sees the value — the
// payer names the purchase inside the payment. Accepting x402 therefore costs your API
// nothing: no new endpoint, parameter, or header. To name the purchase yourself instead
// (you already have an order id), add `id: <your order id>` to `info` below; it must be
// 16-128 chars of letters, digits, hyphen or underscore, and a payer may add to your
// declaration but never overwrite it.
//
// The extension is part of the x402 specification, not an Atum addition:
// https://github.com/coinbase/x402/blob/main/specs/extensions/payment_identifier.md
// ---------------------------------------------------------------------------

const PAYMENT_IDENTIFIER = "payment-identifier";

// The schema travels with the declaration so a payer can validate what it is being asked
// for without knowing this scheme.
const PAYMENT_IDENTIFIER_DECLARATION = {
  info: { required: true },
  schema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: {
      required: { type: "boolean" },
      id: { type: "string", minLength: 16, maxLength: 128, pattern: "^[a-zA-Z0-9_-]+$" },
    },
    required: ["required"],
  },
} as const;

/** The purchase a payment names, read from either side's `extensions` map. */
function paymentIdentifierOf(extensions: Record<string, unknown> | undefined): string | undefined {
  const entry = extensions?.[PAYMENT_IDENTIFIER] as { info?: { id?: unknown } } | undefined;
  return typeof entry?.info?.id === "string" ? entry.info.id : undefined;
}

// ---------------------------------------------------------------------------
// Settlement outcomes.
//
// x402 models settlement as a boolean, so everything short of settled arrives as
// `success: false`. Three situations hide behind that flag, and `errorReason` separates
// them — pending and failed call for OPPOSITE actions, so never collapse them into one
// "payment failed":
//
//   settlement_pending  accepted, still settling  -> re-attempt the SAME purchase
//   settlement_failed   terminal                  -> a fresh attempt needs a NEW identifier
//   a gateway code      refused, nothing charged  -> fix the request, pay the same purchase
// ---------------------------------------------------------------------------

const SETTLEMENT_PENDING = "settlement_pending";
const SETTLEMENT_FAILED = "settlement_failed";

// ---------------------------------------------------------------------------
// Corridor contract addresses.
//
// These are Atum-network facts, not merchant business config — so in real mode the
// merchant READS them from the payment gateway's GET /defaults?chain_id=... at
// startup (mirroring the reference merchant in atum-core), rather than making you
// paste five addresses into .env by hand. The source chain supplies the escrow, the
// reserver (quote_selector), and the releaser + verifier endpoint (fulfillment_verifier);
// the destination chain supplies the fulfillment proxy.
//
// The stub never checks these, so stub mode uses inert placeholders and contacts no gateway.
// ---------------------------------------------------------------------------

interface CorridorContracts {
  escrow: string;
  fulfillmentProxy: string;
  reserver: string;
  releaser: string;
  fulfillmentVerifierEndpoint: string;
}

// The subset of GET /defaults this example reads.
interface ChainDefaults {
  escrow_contract: string;
  fulfillment_proxy: string;
  quote_selector: string;
  fulfillment_verifier: { account: string; endpoint: string };
}

async function fetchDefaults(chainId: string): Promise<ChainDefaults> {
  const res = await fetch(`${GATEWAY_URL}/defaults?chain_id=${encodeURIComponent(chainId)}`);
  if (!res.ok) {
    throw new Error(`GET /defaults for ${chainId} failed: ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as ChainDefaults;
}

// Inert placeholders for the stub flow — the stub facilitator ignores them.
const STUB_CORRIDOR: CorridorContracts = {
  escrow: "0x0000000000000000000000000000000000000001",
  fulfillmentProxy: "0x0000000000000000000000000000000000000003",
  reserver: "0x0000000000000000000000000000000000000004",
  releaser: "0x0000000000000000000000000000000000000005",
  fulfillmentVerifierEndpoint: "http://localhost:8080/veri-fill",
};

async function resolveCorridor(): Promise<CorridorContracts> {
  if (USE_STUB_FACILITATOR) return STUB_CORRIDOR;

  // Real settlement: the source chain supplies escrow + roles + verifier; the
  // destination chain supplies the fulfillment proxy.
  const [source, dest] = await Promise.all([
    fetchDefaults(SOURCE_NETWORK),
    fetchDefaults(DEST_NETWORK),
  ]);
  return {
    escrow: source.escrow_contract,
    fulfillmentProxy: dest.fulfillment_proxy,
    reserver: source.quote_selector,
    releaser: source.fulfillment_verifier.account,
    fulfillmentVerifierEndpoint: source.fulfillment_verifier.endpoint,
  };
}

// The 402's accepted payment option, built from business config + the resolved corridor.
function buildRequirements(corridor: CorridorContracts): PaymentRequirements {
  return {
    scheme: "atum-escrow",
    network: SOURCE_NETWORK,
    asset: SOURCE_ASSET,
    payTo: corridor.escrow,
    amount: SOURCE_MAX_AMOUNT,
    maxTimeoutSeconds: 60,
    extra: {
      atum: {
        destination: { network: DEST_NETWORK, asset: DEST_ASSET, address: DEST_ADDRESS },
        fulfillmentAmount: FULFILLMENT_AMOUNT,
        escrow: corridor.escrow,
        fulfillmentProxy: corridor.fulfillmentProxy,
        reserver: corridor.reserver,
        releaser: corridor.releaser,
        fulfillmentVerifierEndpoint: corridor.fulfillmentVerifierEndpoint,
        quoteDeadlineSeconds: QUOTE_DEADLINE_SECONDS,
        fulfillmentDeadlineSeconds: FULFILLMENT_DEADLINE_SECONDS,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Facilitator — verify (no funds move) then settle (funds move). x402 delegates
// both to a facilitator service; MPP does the equivalent in-process. The stub below
// is the x402 counterpart of mpp-accept-payments' stubSubmitter: it runs the full
// flow locally, settling nothing.
// ---------------------------------------------------------------------------

interface Facilitator {
  verify(body: FacilitatorRequest): Promise<VerifyResponse>;
  settle(body: FacilitatorRequest): Promise<SettleResponse>;
}

// How many attempts at a purchase the stub reports as still settling before it settles.
// The default of 0 settles on the first attempt. Set it to 2 or 3 to watch the retry that
// resolves a slow cross-chain settlement, with no facilitator, no gateway, and no funds:
//
//   STUB_PENDING_ATTEMPTS=2 npm run dev
//
// This is a demo knob for the stub only. Nothing on the real path reads it.
const STUB_PENDING_ATTEMPTS = Number(process.env.STUB_PENDING_ATTEMPTS ?? "0");

// A stable fake payment id per purchase, so a retried purchase reports the SAME payment
// across attempts — exactly as the gateway does when it resolves a retry onto the
// original payment.
function stubPaymentId(purchase: string): string {
  return `pay_stub_${createHash("sha256").update(purchase).digest("hex").slice(0, 32)}`;
}

// Local stub: approves and "settles" without a facilitator, gateway, or chain.
function stubFacilitator(): Facilitator {
  const attemptsByPurchase = new Map<string, number>();
  return {
    async verify() {
      return { isValid: true, payer: "0x0000000000000000000000000000000000000000" };
    },
    async settle(body) {
      const purchase = paymentIdentifierOf(body.paymentPayload.extensions) ?? "(unnamed)";
      const paymentId = stubPaymentId(purchase);
      const attempt = (attemptsByPurchase.get(purchase) ?? 0) + 1;
      attemptsByPurchase.set(purchase, attempt);

      if (attempt <= STUB_PENDING_ATTEMPTS) {
        return {
          success: false,
          transaction: "",
          network: SOURCE_NETWORK,
          payer: "0x0000000000000000000000000000000000000000",
          errorReason: SETTLEMENT_PENDING,
          errorMessage:
            "the payment was accepted and is still settling; re-attempt the purchase under " +
            "the SAME identifier to collect the result",
          extensions: { atum: { paymentId, state: "pending" } },
        };
      }

      return {
        success: true,
        transaction: `0x${"11".repeat(32)}`,
        network: SOURCE_NETWORK,
        payer: "0x0000000000000000000000000000000000000000",
        extensions: { atum: { paymentId, state: "completed" } },
        fulfillmentConfirmation: { stub: true, note: "stub settlement — no funds were moved" },
      };
    },
  };
}

// Real facilitator: JSON over HTTP (unaffected by the x402 wire headers).
const httpFacilitator: Facilitator = {
  async verify(body) {
    const res = await fetch(`${FACILITATOR_URL}/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`/verify failed: ${res.status}`);
    return res.json() as Promise<VerifyResponse>;
  },
  async settle(body) {
    const res = await fetch(`${FACILITATOR_URL}/settle`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`/settle failed: ${res.status}`);
    return res.json() as Promise<SettleResponse>;
  },
};

const facilitator: Facilitator = USE_STUB_FACILITATOR ? stubFacilitator() : httpFacilitator;

// ---------------------------------------------------------------------------
// Settlement logging — print clickable explorer links instead of bare hashes,
// the one-glance "did the funds move?" check (mirrors mpp-accept-payments).
// Any chain not listed falls back to the raw hash plus its CAIP-2 id.
// ---------------------------------------------------------------------------

const TX_EXPLORERS: Record<string, string> = {
  "eip155:84532": "https://sepolia.basescan.org/tx/", // Base Sepolia
  "eip155:42431": "https://explore.testnet.tempo.xyz/tx/", // Tempo Moderato
};

function txLink(chainId: string | undefined, hash: string | undefined): string {
  if (!hash) return "(none)";
  const base = chainId ? TX_EXPLORERS[chainId] : undefined;
  return base ? `${base}${hash}` : `${hash}${chainId ? ` (${chainId})` : ""}`;
}

// x402's /settle reports the *fulfillment* transaction (verified on-chain: a call to the
// destination chain's fulfillmentProxy), NOT the source escrow deposit. Only label a leg when
// the confirmation names it explicitly — otherwise print the tx without guessing the chain.
function logSettlement(settled: SettleResponse): void {
  const c = settled.fulfillmentConfirmation ?? {};
  const sourceChain = c.source_chain_id as string | undefined;
  const sourceHash = c.source_tx_hash as string | undefined;
  const destChain = c.destination_chain_id as string | undefined;
  const destHash = c.destination_tx_hash as string | undefined;
  if (sourceHash) console.log(`    source deposit:     ${txLink(sourceChain, sourceHash)}`);
  if (destHash) console.log(`    destination payout: ${txLink(destChain, destHash)}`);
  if (!sourceHash && !destHash) {
    console.log(`    settlement tx:      ${txLink(settled.network, settled.transaction)}`);
    console.log(`    (facilitator reported one leg only — verify the other on-chain)`);
  }
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

// What this merchant sells. Recorded against the payment that funded it, so the same
// payment is never delivered against twice.
const RESOURCE_BODY = { message: "Access granted.", data: "Your premium content here." };

function buildApp(requirements: PaymentRequirements): express.Express {
  const app = express();
  app.use(express.json());

  const ledger = new PaymentLedger<typeof RESOURCE_BODY>();

  app.get("/paid", async (req: Request, res: Response) => {
    // Express lower-cases header names. Read the v2 header, then fall back to v1.
    const paymentHeader = (req.headers["payment-signature"] ??
      req.headers["x-payment"]) as string | undefined;

    const resource: ResourceInfo = {
      url: `${req.protocol}://${req.get("host") ?? `localhost:${PORT}`}${req.originalUrl}`,
      description: "Example premium resource",
    };

    // Every 402 this merchant issues asks the payer to name the purchase, so a payer that
    // knows nothing else about this scheme still learns an identifier is mandatory.
    const challengeOf = (error?: string): PaymentRequired => ({
      x402Version: 2,
      resource,
      accepts: [requirements],
      extensions: { [PAYMENT_IDENTIFIER]: PAYMENT_IDENTIFIER_DECLARATION },
      ...(error !== undefined ? { error } : {}),
    });

    // No payment credential — issue the 402 challenge with what we accept.
    if (!paymentHeader) {
      const challenge = challengeOf();
      console.log("→ 402: no payment credential, issuing challenge");
      res
        .status(402)
        .set(HEADER_PAYMENT_REQUIRED, encodeHeader(challenge))
        .json(challenge); // body mirrors the header so `curl` shows the options
      return;
    }

    // Decode the signed payment payload from the header.
    let paymentPayload: PaymentPayload;
    try {
      paymentPayload = decodeHeader<PaymentPayload>(paymentHeader);
    } catch {
      res.status(400).json({
        error: `Invalid ${HEADER_PAYMENT_SIGNATURE} header — expected base64-encoded JSON.`,
      });
      return;
    }

    const facilitatorRequest: FacilitatorRequest = {
      x402Version: 2,
      paymentPayload,
      paymentRequirements: requirements,
    };

    // Verify the credential — does not move funds.
    let verified: VerifyResponse;
    try {
      verified = await facilitator.verify(facilitatorRequest);
    } catch (err) {
      res
        .status(502)
        .json({ error: "Facilitator /verify unreachable.", detail: String(err) });
      return;
    }

    if (!verified.isValid) {
      const challenge = challengeOf(verified.invalidReason ?? "Payment credential is not valid.");
      console.log(`→ 402: verify rejected (${challenge.error})`);
      res
        .status(402)
        .set(HEADER_PAYMENT_REQUIRED, encodeHeader(challenge))
        .json(challenge);
      return;
    }

    // Settle — moves funds (unless stubbed).
    let settled: SettleResponse;
    try {
      settled = await facilitator.settle(facilitatorRequest);
    } catch (err) {
      res
        .status(502)
        .json({ error: "Facilitator /settle unreachable.", detail: String(err) });
      return;
    }

    // The payer reads `errorReason` and the payment id off PAYMENT-RESPONSE to decide
    // whether to re-attempt, so it is set on unsettled outcomes too — not only on the 200.
    res.setHeader(HEADER_PAYMENT_RESPONSE, encodeHeader(settled));
    const paymentId = settled.extensions?.atum?.paymentId;

    if (!settled.success) {
      const reason = settled.errorReason ?? "Settlement failed.";
      const pending = reason === SETTLEMENT_PENDING;

      // Pending is not a failure — funds may already be moving — but the resource is
      // still withheld: goods must not be released against an unfinished payment.
      const error = pending
        ? `Settlement is still in progress (payment ${paymentId}). Re-attempt this purchase ` +
          `under the same identifier to collect the result; it resolves onto this payment ` +
          `and costs nothing. Do not pay again under a new identifier.`
        : reason === SETTLEMENT_FAILED
          ? `Settlement failed terminally (payment ${paymentId}). This purchase's identifier ` +
            `now resolves to a dead payment, so a fresh attempt needs a NEW identifier.`
          : `The payment was refused and nothing was charged: ${settled.errorMessage ?? reason}`;

      const challenge = challengeOf(error);
      console.log(
        pending
          ? `→ 402: still settling (payment ${paymentId}) — awaiting the payer's re-attempt`
          : `→ 402: not settled (${reason})`,
      );
      res
        .status(402)
        .set(HEADER_PAYMENT_REQUIRED, encodeHeader(challenge))
        .json(challenge);
      return;
    }

    // Settled. Deliver against the PAYMENT, not against the request: a payer that reused
    // one identifier for two purchases arrives here twice with the same payment id, and
    // must be served the first delivery rather than a second one. See ./payments.ts.
    if (paymentId) {
      const already = ledger.served(paymentId);
      if (already) {
        console.log(`→ 200: payment ${paymentId} was already fulfilled — re-serving, not a new sale`);
        res.json(already.result);
        return;
      }
      ledger.record(paymentId, RESOURCE_BODY);
    }

    console.log(
      USE_STUB_FACILITATOR
        ? `→ 200: settled (stub — no funds moved)${paymentId ? ` — payment ${paymentId}` : ""}`
        : `→ 200: settled${paymentId ? ` — payment ${paymentId}` : ""}`,
    );
    logSettlement(settled);
    res.json(RESOURCE_BODY);
  });

  return app;
}

async function main(): Promise<void> {
  // In real mode the placeholder DEST_ADDRESS from .env.example would pay settlement
  // out to an address nobody controls. Refuse to start until it is a real address.
  if (!USE_STUB_FACILITATOR && !ADDRESS_RE.test(RAW_DEST_ADDRESS)) {
    console.error(
      "Refusing to start: USE_STUB_FACILITATOR=false enables real settlement, but " +
        "DEST_ADDRESS is not a valid address. Set DEST_ADDRESS in .env to your receiving " +
        "address on the destination chain before accepting real payments.",
    );
    process.exit(1);
  }

  // See mpp-accept-payments: printed before the slow part of boot so the smoke
  // tests can tell "still starting" from "died silently".
  console.log(
    `x402 merchant starting (${
      USE_STUB_FACILITATOR
        ? "stub (local, no funds)"
        : `real ${FACILITATOR_URL} · corridor from ${GATEWAY_URL}/defaults`
    })`,
  );
  const corridor = await resolveCorridor();
  const requirements = buildRequirements(corridor);
  const app = buildApp(requirements);

  app.listen(PORT, () => {
    console.log(`Merchant listening on http://localhost:${PORT}`);
    console.log(
      USE_STUB_FACILITATOR
        ? "Facilitator: stub (local, no funds)"
        : `Facilitator: real ${FACILITATOR_URL} · corridor from ${GATEWAY_URL}/defaults`,
    );
  });
}

main().catch((err: unknown) => {
  console.error("failed to start merchant:", (err as Error).message);
  process.exit(1);
});
