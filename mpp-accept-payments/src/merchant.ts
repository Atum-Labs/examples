import * as http from "node:http";
import { randomUUID } from "node:crypto";
import "dotenv/config";
import { Mppx } from "mppx/server";
import {
  registerServer,
  buildChargeRequest,
  corridorFromDefaults,
  type AtumEscrowCorridor,
  type PaymentSubmitter,
  type FulfillmentConfirmation,
  type PaymentRequest,
} from "@atum-labs/mppx-atum-escrow/server";

const PORT = Number(process.env.PORT ?? 4030);
const RESOURCE_PATH = "/paid";

// mppx HMAC-binds the challenge to this key, so verify() can trust the challenge
// terms without re-deriving them. It must be at least 32 bytes; use a real secret
// in production. The placeholder below is public (it's committed in this repo), so
// it must never protect real settlement — see the guard in main() below.
const DEFAULT_SECRET_KEY = "dev-only-change-me-mpp-atum-escrow-secret-0123456789";
const REALM = process.env.REALM ?? "mpp.example.com";
const SECRET_KEY = process.env.MPP_SECRET_KEY ?? DEFAULT_SECRET_KEY;

// Exact amount the merchant receives on the destination chain (atomic units).
const FULFILLMENT_AMOUNT = process.env.FULFILLMENT_AMOUNT ?? "100000"; // 0.10 (6-decimal token)

// The stub submitter runs the full flow locally with no gateway and no funds. Set
// USE_STUB_SUBMITTER=false to settle through a real Atum Payment Gateway instead.
const USE_STUB_SUBMITTER = (process.env.USE_STUB_SUBMITTER ?? "true") !== "false";
const GATEWAY_URL = process.env.GATEWAY_URL ?? "https://payment-gateway-testnet.atumlabs.xyz";

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
const DEST_NETWORK = process.env.DEST_NETWORK ?? "eip155:11142220"; // Celo Sepolia
const DEST_ASSET = process.env.DEST_ASSET ?? "0x0000000000000000000000000000000000000002";
const DEST_ACCOUNT = process.env.DEST_ADDRESS ?? "0x0000000000000000000000000000000000000003";
const SOURCE_NETWORK = process.env.SOURCE_NETWORK ?? "eip155:421614"; // Arbitrum Sepolia
const SOURCE_ASSET = process.env.SOURCE_ASSET ?? "0x0000000000000000000000000000000000000001";
// Markup over the fulfillment amount to derive the source spend cap (300 = 3%).
const MARKUP_BPS = Number(process.env.MARKUP_BPS ?? "300");
const QUOTE_DEADLINE_SECONDS = Number(process.env.QUOTE_DEADLINE_SECONDS ?? "60");
const FULFILLMENT_DEADLINE_SECONDS = Number(process.env.FULFILLMENT_DEADLINE_SECONDS ?? "600");

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

// Local stub: returns a canned confirmation so the full 402 → pay → 200 flow runs
// without a gateway or on-chain funds. It settles nothing.
function stubSubmitter(corridor: AtumEscrowCorridor): PaymentSubmitter {
  return {
    async submit(request: PaymentRequest) {
      const confirmation: FulfillmentConfirmation = {
        payment_id: "pay_stub_00000000000000000000000000000000",
        request_id: request.request_id ?? "req_stub",
        fulfillment_timestamp: new Date().toISOString(),
        source_chain_id: corridor.sources[0].network,
        destination_chain_id: corridor.destination.network,
        source_tx_hash: `0x${"11".repeat(32)}`,
        destination_tx_hash: `0x${"22".repeat(32)}`,
      };
      return { payment_id: confirmation.payment_id, fulfillment_confirmation: confirmation };
    },
  };
}

// How often to re-check a payment that is still settling past the gateway's
// synchronous window. The overall cap is the corridor's own fulfillment deadline
// (see the poll loop in the real submitter below).
const POLL_INTERVAL_MS = 3000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Resolve the corridor and the submitter for the chosen mode. MPP has no separate
// facilitator: the merchant verifies in-process and submits through the submitter.
async function setup(): Promise<{ corridor: AtumEscrowCorridor; submitter: PaymentSubmitter }> {
  if (USE_STUB_SUBMITTER) {
    const corridor = stubCorridor();
    return { corridor, submitter: stubSubmitter(corridor) };
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
  const submitter: PaymentSubmitter = {
    async submit(request) {
      // The gateway holds the connection synchronously for up to ~30s. If settlement
      // finishes in that window, submitPayment returns the FulfillmentConfirmation.
      const res = await gateway.payments.submitPayment({ requestBody: request as never });
      if (res.fulfillment_confirmation) {
        return {
          payment_id: res.payment_id,
          fulfillment_confirmation: res.fulfillment_confirmation as FulfillmentConfirmation,
        };
      }

      // Past the synchronous window the payment is still settling — NOT failed.
      // Poll GET /payments/{id}/status until it is terminal (never /timeline).
      const paymentId = res.payment_id;
      if (!paymentId) {
        throw new Error("atum-escrow: gateway returned no payment_id to poll for settlement");
      }
      console.log(`  settlement exceeded the ~30s sync window; polling status for ${paymentId} …`);
      const deadline = Date.now() + FULFILLMENT_DEADLINE_SECONDS * 1000;
      while (Date.now() < deadline) {
        await sleep(POLL_INTERVAL_MS);
        const st = await gateway.payments.getPaymentStatus({ paymentId });
        if (st.status === "completed") {
          return {
            payment_id: paymentId,
            fulfillment_confirmation: st.fulfillment_confirmation as FulfillmentConfirmation | undefined,
          };
        }
        if (st.status === "failed" || st.status === "cancelled") {
          throw new Error(
            `atum-escrow: payment ${st.status}` + (st.error ? `: ${JSON.stringify(st.error)}` : ""),
          );
        }
        console.log(`  … settling (status: ${st.status ?? "pending"})`);
      }
      throw new Error("atum-escrow: settlement did not complete before the fulfillment deadline");
    },
  };
  return { corridor, submitter };
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

async function main() {
  const { corridor, submitter } = await setup();
  const source = corridor.sources[0];

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
    { network: source.network, asset: source.assets[0] },
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
    // A per-HTTP-request id for log correlation only — unrelated to MPP's own
    // request_id/payment_id (those live inside the credential, not visible until
    // mppx has parsed it). Lets you grep one request's lifecycle out of the logs.
    const reqId = randomUUID().slice(0, 8);
    try {
      const result = await route(req, res);
      if (result.status === 402) {
        console.log(`[${reqId}] → 402: challenge issued`);
        return; // toNodeListener already wrote the challenge
      }
      // Paid: mppx set the Payment-Receipt header; return the protected resource.
      console.log(`[${reqId}] → 200: settled, serving resource`);
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ message: "Access granted.", data: "Your premium content here." }));
    } catch (err) {
      console.error(`[${reqId}] merchant route error:`, (err as Error).message);
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
