import * as http from "node:http";
import "dotenv/config";
import { Mppx } from "mppx/server";
import {
  registerServer,
  buildChargeRequest,
  type AtumEscrowCorridor,
  type PaymentSubmitter,
  type FulfillmentConfirmation,
  type PaymentRequest,
} from "@atum-labs/mppx-atum-escrow/server";

const PORT = Number(process.env.PORT ?? 4030);
const RESOURCE_PATH = "/paid-resource";

// mppx HMAC-binds the challenge to this key, so verify() can trust the challenge
// terms without re-deriving them. It must be at least 32 bytes; use a real secret
// in production.
const REALM = process.env.REALM ?? "mpp.example.com";
const SECRET_KEY = process.env.MPP_SECRET_KEY ?? "dev-only-change-me-mpp-atum-escrow-secret-0123456789";

// Exact amount the merchant receives on the destination chain (atomic units).
const FULFILLMENT_AMOUNT = process.env.FULFILLMENT_AMOUNT ?? "100000"; // 0.10 (6-decimal token)

// The stub submitter runs the full flow locally with no gateway and no funds. Set
// USE_STUB_SUBMITTER=false to settle through a real Atum Payment Gateway instead.
const USE_STUB_SUBMITTER = (process.env.USE_STUB_SUBMITTER ?? "true") !== "false";
const GATEWAY_URL = process.env.GATEWAY_URL ?? "https://payment-gateway-testnet.atumlabs.xyz";

// ---------------------------------------------------------------------------
// Corridor — what the merchant receives and which source it accepts payment from.
// Replace the placeholder addresses with the values Atum provides for your corridor,
// or build it from the gateway at startup with `corridorFromDefaults(gateway, {...})`.
// ---------------------------------------------------------------------------

const corridor: AtumEscrowCorridor = {
  destination: {
    network: process.env.DEST_NETWORK ?? "eip155:11142220", // Celo Sepolia
    asset: process.env.DEST_ASSET ?? "0x0000000000000000000000000000000000000002",
    account: process.env.DEST_ADDRESS ?? "0x0000000000000000000000000000000000000003",
  },
  fulfillmentProxy: process.env.FULFILLMENT_PROXY ?? "0x0000000000000000000000000000000000000007",
  // Markup over the fulfillment amount to derive the source spend cap (300 = 3%).
  markupBps: Number(process.env.MARKUP_BPS ?? "300"),
  quoteDeadlineSeconds: Number(process.env.QUOTE_DEADLINE_SECONDS ?? "60"),
  fulfillmentDeadlineSeconds: Number(process.env.FULFILLMENT_DEADLINE_SECONDS ?? "600"),
  sources: [
    {
      network: process.env.SOURCE_NETWORK ?? "eip155:421614", // Arbitrum Sepolia
      asset: process.env.SOURCE_ASSET ?? "0x0000000000000000000000000000000000000001",
      escrow: process.env.ESCROW ?? "0x0000000000000000000000000000000000000004",
      reserver: process.env.RESERVER ?? "0x0000000000000000000000000000000000000005",
      releaser: process.env.RELEASER ?? "0x0000000000000000000000000000000000000006",
      fulfillmentVerifierEndpoint: process.env.VERIFIER_ENDPOINT ?? "https://verifier.example/verify",
    },
  ],
};
const source = corridor.sources[0];

// ---------------------------------------------------------------------------
// PaymentSubmitter — hands the verified PaymentRequest to Atum for settlement.
// MPP has no separate facilitator: the merchant server verifies the credential
// in-process, then submits it here.
// ---------------------------------------------------------------------------

// Local stub: returns a canned confirmation so the full 402 → pay → 200 flow runs
// without a gateway or on-chain funds. It settles nothing — it only lets you see the
// protocol end to end locally.
const stubSubmitter: PaymentSubmitter = {
  async submit(request: PaymentRequest) {
    const confirmation: FulfillmentConfirmation = {
      payment_id: "pay_stub_00000000000000000000000000000000",
      request_id: request.request_id ?? "req_stub",
      fulfillment_timestamp: new Date().toISOString(),
      source_chain_id: source.network,
      destination_chain_id: corridor.destination.network,
      source_tx_hash: `0x${"11".repeat(32)}`,
      destination_tx_hash: `0x${"22".repeat(32)}`,
    };
    return { payment_id: confirmation.payment_id, fulfillment_confirmation: confirmation };
  },
};

// Real settlement: forward the request to an Atum Payment Gateway. Needs a funded,
// Permit2-approved payer and a live corridor. `submitPayment` blocks on the gateway's
// synchronous settlement window; production servers may need to poll `getPaymentStatus`
// when the confirmation is not ready yet (see the SDK guide).
async function createRealSubmitter(): Promise<PaymentSubmitter> {
  const { PaymentGatewayClient } = await import("@atumlabs/payment-gateway-client");
  const gateway = new PaymentGatewayClient({ BASE: GATEWAY_URL });
  return {
    async submit(request) {
      const res = await gateway.payments.submitPayment({ requestBody: request as never });
      return {
        payment_id: res.payment_id,
        fulfillment_confirmation: res.fulfillment_confirmation as FulfillmentConfirmation | undefined,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

async function main() {
  const submitter = USE_STUB_SUBMITTER ? stubSubmitter : await createRealSubmitter();

  // registerServer takes no corridor: it trusts the HMAC-bound challenge that mppx
  // verifies before verify() runs. One registration serves every corridor you advertise.
  const mppx = Mppx.create({
    realm: REALM,
    secretKey: SECRET_KEY,
    methods: [registerServer({ submitter })],
  });

  // The challenge for our single source option. buildChargeRequest turns the corridor
  // and chosen source into the `atum-escrow` charge request mppx emits on the 402.
  const request = buildChargeRequest(
    corridor,
    { network: source.network, asset: source.asset },
    FULFILLMENT_AMOUNT,
  );

  const route = Mppx.toNodeListener(async (input) =>
    mppx.compose(["atum-escrow/charge", request])(input),
  );

  const server = http.createServer(async (req, res) => {
    if (!req.url || req.url.split("?")[0] !== RESOURCE_PATH) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found." }));
      return;
    }
    try {
      const result = await route(req, res);
      if (result.status === 402) {
        console.log("→ 402: challenge issued");
        return; // toNodeListener already wrote the challenge
      }
      // Paid: mppx set the Payment-Receipt header; return the protected resource.
      console.log("→ 200: settled, serving resource");
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ message: "Access granted.", data: "Your premium content here." }));
    } catch (err) {
      console.error("merchant route error:", (err as Error).message);
      if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Payment verification or settlement failed." }));
    }
  });

  server.listen(PORT, () => {
    console.log(`MPP merchant listening on http://localhost:${PORT}${RESOURCE_PATH}`);
    console.log(`Submitter: ${USE_STUB_SUBMITTER ? "stub (local, no funds)" : `real gateway ${GATEWAY_URL}`}`);
  });
}

main().catch((err) => {
  console.error("failed to start merchant:", err);
  process.exit(1);
});
