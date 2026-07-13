import "dotenv/config";
import express, { Request, Response } from "express";

const PORT = Number(process.env.PORT ?? 4020);
const FACILITATOR_URL = process.env.FACILITATOR_URL ?? "http://localhost:8091";

// ---------------------------------------------------------------------------
// Types — shapes match the x402 Facilitator API (atum-escrow scheme)
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

interface FacilitatorRequest {
  x402Version: 2;
  paymentPayload: unknown;       // AtumEscrowPayload — signed by the payer
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
  amount: process.env.AMOUNT ?? "10000000",
  maxTimeoutSeconds: 60,
  extra: {
    atum: {
      destination: {
        network: process.env.DEST_NETWORK ?? "eip155:42161",
        asset: process.env.DEST_ASSET ?? "0x52e52f345139e57b87d288c9ea794bb3fbe591c3",
        address: process.env.DEST_ADDRESS ?? "0x0000000000000000000000000000000000000002",
      },
      fulfillmentAmount: process.env.FULFILLMENT_AMOUNT ?? "10000000",
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
// Facilitator calls
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
  const paymentHeader = req.headers["x-payment"] as string | undefined;

  // No payment credential — return 402 with what we accept.
  if (!paymentHeader) {
    res.status(402).json({
      x402Version: 2,
      accepts: [PAYMENT_REQUIREMENTS],
    });
    return;
  }

  // Parse the payment credential from the header.
  let paymentPayload: unknown;
  try {
    paymentPayload = JSON.parse(Buffer.from(paymentHeader, "base64").toString("utf8"));
  } catch {
    res.status(400).json({ error: "Invalid X-Payment header — expected base64-encoded JSON." });
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
    res.status(402).json({
      x402Version: 2,
      error: verified.invalidReason ?? "Payment credential is not valid.",
      accepts: [PAYMENT_REQUIREMENTS],
    });
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
    res.status(402).json({
      x402Version: 2,
      error: settled.errorReason ?? "Settlement failed.",
      accepts: [PAYMENT_REQUIREMENTS],
    });
    return;
  }

  // Payment confirmed — return the protected resource.
  res.setHeader("X-Payment-Response", JSON.stringify({
    x402Version: 2,
    transaction: settled.transaction,
    network: settled.network,
  }));
  res.json({ message: "Access granted.", data: "Your premium content here." });
});

app.listen(PORT, () => {
  console.log(`Merchant listening on http://localhost:${PORT}`);
  console.log(`Facilitator: ${FACILITATOR_URL}`);
});
