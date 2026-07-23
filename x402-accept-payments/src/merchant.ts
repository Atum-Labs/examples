import "dotenv/config";
import express, { Request, Response } from "express";

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
const FULFILLMENT_DEADLINE_SECONDS = Number(process.env.FULFILLMENT_DEADLINE_SECONDS ?? 300);

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
  error?: string;
}

// Decoded from the PAYMENT-SIGNATURE header on the retry. The signed Atum
// PaymentRequest lives at `payload.paymentRequest`.
interface PaymentPayload {
  x402Version: 2;
  accepted: PaymentRequirements;
  payload: { paymentRequest: unknown };
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
  errorReason?: string;
  fulfillmentConfirmation?: Record<string, unknown>;
}

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

// Local stub: approves and "settles" without a facilitator, gateway, or chain.
const stubFacilitator: Facilitator = {
  async verify() {
    return { isValid: true, payer: "0x0000000000000000000000000000000000000000" };
  },
  async settle() {
    return {
      success: true,
      transaction: `0x${"11".repeat(32)}`,
      network: SOURCE_NETWORK,
      payer: "0x0000000000000000000000000000000000000000",
      fulfillmentConfirmation: { stub: true, note: "stub settlement — no funds were moved" },
    };
  },
};

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

const facilitator: Facilitator = USE_STUB_FACILITATOR ? stubFacilitator : httpFacilitator;

// The x402 v1 facilitator returns this when cross-chain settlement outruns the
// gateway's synchronous window (~30s). It means "submitted, still settling
// asynchronously" — NOT a failed payment. See the async-tail handling below.
const ASYNC_TAIL_RE = /async tail is not supported|did not complete synchronously/i;

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

function buildApp(requirements: PaymentRequirements): express.Express {
  const app = express();
  app.use(express.json());

  app.get("/paid", async (req: Request, res: Response) => {
    // Express lower-cases header names. Read the v2 header, then fall back to v1.
    const paymentHeader = (req.headers["payment-signature"] ??
      req.headers["x-payment"]) as string | undefined;

    const resource: ResourceInfo = {
      url: `${req.protocol}://${req.get("host") ?? `localhost:${PORT}`}${req.originalUrl}`,
      description: "Example premium resource",
    };

    // No payment credential — issue the 402 challenge with what we accept.
    if (!paymentHeader) {
      const challenge: PaymentRequired = {
        x402Version: 2,
        resource,
        accepts: [requirements],
      };
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
      const challenge: PaymentRequired = {
        x402Version: 2,
        resource,
        accepts: [requirements],
        error: verified.invalidReason ?? "Payment credential is not valid.",
      };
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

    if (!settled.success) {
      const reason = settled.errorReason ?? "Settlement failed.";

      // Async tail: the payment was submitted and is settling asynchronously — it did
      // NOT fail. x402 v1 just can't confirm a settlement that outruns the gateway's
      // synchronous window. Do not present this as a failure; flag it as pending and
      // steer operators away from slow cross-chain corridors.
      if (ASYNC_TAIL_RE.test(reason)) {
        console.warn(
          `⚠ settlement pending (NOT failed): the payment was submitted but cross-chain settlement ` +
            `outran the facilitator's ~30s synchronous window, so x402 v1 cannot confirm it here. ` +
            `It may still complete. Prefer faster corridors, or verify settlement on-chain / via the gateway.`,
        );
        const pending: PaymentRequired = {
          x402Version: 2,
          resource,
          accepts: [requirements],
          error:
            "Settlement is still in progress (submitted, not yet confirmed). This is NOT a failure: " +
            "x402 cannot confirm a settlement that outruns the facilitator's synchronous window, and " +
            "the payment may still complete. Avoid slow cross-chain corridors. " +
            `(facilitator: ${reason})`,
        };
        console.log(`→ 402: settlement pending (async, not confirmed) — see warning above`);
        res
          .status(402)
          .set(HEADER_PAYMENT_REQUIRED, encodeHeader(pending))
          .json(pending);
        return;
      }

      const challenge: PaymentRequired = {
        x402Version: 2,
        resource,
        accepts: [requirements],
        error: reason,
      };
      console.log(`→ 402: settle failed (${reason})`);
      res
        .status(402)
        .set(HEADER_PAYMENT_REQUIRED, encodeHeader(challenge))
        .json(challenge);
      return;
    }

    // Payment confirmed — attach the settlement receipt and return the resource.
    console.log(
      USE_STUB_FACILITATOR
        ? `→ 200: settled (stub — no funds moved, tx ${settled.transaction})`
        : `→ 200: settled (tx ${settled.transaction})`,
    );
    res.setHeader(HEADER_PAYMENT_RESPONSE, encodeHeader(settled));
    res.json({ message: "Access granted.", data: "Your premium content here." });
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
