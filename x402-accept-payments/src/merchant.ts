import "dotenv/config";
import express, { Request, Response } from "express";

const PORT = Number(process.env.PORT ?? 4020);
const FACILITATOR_URL = process.env.FACILITATOR_URL ?? "http://localhost:8091";

// The exact amount the merchant receives on the destination chain (atomic units).
const FULFILLMENT_AMOUNT = process.env.FULFILLMENT_AMOUNT ?? "10000000";

// Markup over FULFILLMENT_AMOUNT, in basis points (100 bps = 1%). It is added on
// top of the fulfillment amount to derive the source-chain spend cap, and covers
// settlement fees and cross-chain conversion. Default 0 for a like-for-like demo.
const MARKUP_BPS = BigInt(process.env.MARKUP_BPS || "0");

// The maximum the payer authorizes on the source chain = fulfillment amount +
// markup. Atum converts this to the exact FULFILLMENT_AMOUNT on the destination
// chain; anything above the fulfillment amount covers fees.
const SOURCE_MAX_AMOUNT = (
  (BigInt(FULFILLMENT_AMOUNT) * (10000n + MARKUP_BPS)) / 10000n
).toString();

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
  network: string;       // CAIP-2 source chain (e.g. "eip155:8453")
  asset: string;         // Source token contract address
  payTo: string;         // Source-chain escrow contract address
  amount: string;        // Source spend cap in atomic units
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
  resource: ResourceInfo;             // required by the spec — describes the gated resource
  accepts: PaymentRequirements[];     // one entry per payment option offered
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
// Payment requirements advertised in the 402 response.
// Replace these values with your real corridor configuration.
// ---------------------------------------------------------------------------

const PAYMENT_REQUIREMENTS: PaymentRequirements = {
  scheme: "atum-escrow",
  network: process.env.SOURCE_NETWORK ?? "eip155:8453",
  asset: process.env.SOURCE_ASSET ?? "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  payTo: process.env.ESCROW_CONTRACT ?? "0x0000000000000000000000000000000000000001",
  amount: SOURCE_MAX_AMOUNT,
  maxTimeoutSeconds: 60,
  extra: {
    atum: {
      destination: {
        network: process.env.DEST_NETWORK ?? "eip155:42161",
        asset: process.env.DEST_ASSET ?? "0x52e52f345139e57b87d288c9ea794bb3fbe591c3",
        address: process.env.DEST_ADDRESS ?? "0x0000000000000000000000000000000000000002",
      },
      fulfillmentAmount: FULFILLMENT_AMOUNT,
      escrow: process.env.ESCROW_CONTRACT ?? "0x0000000000000000000000000000000000000001",
      fulfillmentProxy: process.env.FULFILLMENT_PROXY ?? "0x0000000000000000000000000000000000000003",
      reserver: process.env.RESERVER ?? "0x0000000000000000000000000000000000000004",
      releaser: process.env.RELEASER ?? "0x0000000000000000000000000000000000000005",
      fulfillmentVerifierEndpoint: process.env.VERIFIER_ENDPOINT ?? "http://localhost:8080/veri-fill",
      quoteDeadlineSeconds: 20,
      fulfillmentDeadlineSeconds: 300,
    },
  },
};

// ---------------------------------------------------------------------------
// Facilitator calls (JSON over HTTP — unaffected by the x402 wire headers).
// ---------------------------------------------------------------------------

async function verify(body: FacilitatorRequest): Promise<VerifyResponse> {
  const res = await fetch(`${FACILITATOR_URL}/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`/verify failed: ${res.status}`);
  return res.json() as Promise<VerifyResponse>;
}

async function settle(body: FacilitatorRequest): Promise<SettleResponse> {
  const res = await fetch(`${FACILITATOR_URL}/settle`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`/settle failed: ${res.status}`);
  return res.json() as Promise<SettleResponse>;
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

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
    const challenge: PaymentRequired = { x402Version: 2, resource, accepts: [PAYMENT_REQUIREMENTS] };
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
    paymentRequirements: PAYMENT_REQUIREMENTS,
  };

  // Verify the credential — does not move funds.
  let verified: VerifyResponse;
  try {
    verified = await verify(facilitatorRequest);
  } catch (err) {
    res.status(502).json({ error: "Facilitator /verify unreachable.", detail: String(err) });
    return;
  }

  if (!verified.isValid) {
    const challenge: PaymentRequired = {
      x402Version: 2,
      resource,
      accepts: [PAYMENT_REQUIREMENTS],
      error: verified.invalidReason ?? "Payment credential is not valid.",
    };
    console.log(`→ 402: verify rejected (${challenge.error})`);
    res.status(402).set(HEADER_PAYMENT_REQUIRED, encodeHeader(challenge)).json(challenge);
    return;
  }

  // Settle — moves funds.
  let settled: SettleResponse;
  try {
    settled = await settle(facilitatorRequest);
  } catch (err) {
    res.status(502).json({ error: "Facilitator /settle unreachable.", detail: String(err) });
    return;
  }

  if (!settled.success) {
    const challenge: PaymentRequired = {
      x402Version: 2,
      resource,
      accepts: [PAYMENT_REQUIREMENTS],
      error: settled.errorReason ?? "Settlement failed.",
    };
    console.log(`→ 402: settle failed (${challenge.error})`);
    res.status(402).set(HEADER_PAYMENT_REQUIRED, encodeHeader(challenge)).json(challenge);
    return;
  }

  // Payment confirmed — attach the settlement receipt and return the resource.
  console.log(`→ 200: settled (tx ${settled.transaction})`);
  res.setHeader(HEADER_PAYMENT_RESPONSE, encodeHeader(settled));
  res.json({ message: "Access granted.", data: "Your premium content here." });
});

app.listen(PORT, () => {
  console.log(`Merchant listening on http://localhost:${PORT}`);
  console.log(`Facilitator: ${FACILITATOR_URL}`);
});
