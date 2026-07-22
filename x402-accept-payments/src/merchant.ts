/**
 * Example x402 merchant (resource server) for the atum-escrow scheme.
 *
 * The Atum package does the protocol work: `paymentMiddleware` gates the route,
 * `registerAtumEscrowScheme` teaches the x402 resource server how to build the
 * atum-escrow `402`, and `HTTPFacilitatorClient` delegates verify/settle to the
 * facilitator. This file is just configuration + the protected route — you never
 * hand-build a `402` or call `/verify` / `/settle` yourself.
 *
 * The corridor's contract addresses (escrow, fulfillment proxy, verifier, roles)
 * are Atum-network facts, so the merchant reads them from the payment gateway's
 * `/defaults` at startup rather than hardcoding them. Set GATEWAY_URL to enable
 * that; leave it unset to run locally against the mock facilitator, where the
 * addresses are inert placeholders.
 */

import "dotenv/config";
import express from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { HTTPFacilitatorClient } from "@x402/core/server";
import {
  registerAtumEscrowScheme,
  type AtumEscrowServerConfig,
} from "@atumlabs/x402-atum-escrow/server";

const PORT = Number(process.env.PORT ?? 4020);

// Where verify/settle are delegated. Point at the mock facilitator locally, or an
// Atum-hosted facilitator for real settlement.
const FACILITATOR_URL = process.env.FACILITATOR_URL ?? "http://localhost:8091";

// Payment gateway base URL. When set, corridor contract addresses are read from
// `${GATEWAY_URL}/defaults`. Unset → local mock mode with placeholder addresses.
const GATEWAY_URL = process.env.GATEWAY_URL;

// Inert for atum-escrow (the source cap is fulfillmentAmount + markup, not this
// route price) but the x402 route type requires a price string.
const PRICE = process.env.PRICE ?? "$0.10";

// --- Corridor business config — the only values you own locally ---
// Source: the chain + token the payer pays FROM.
const SOURCE_NETWORK = process.env.SOURCE_NETWORK ?? "eip155:84532";
const SOURCE_ASSET =
  process.env.SOURCE_ASSET ?? "0x036CbD53842c5426634e7929541eC2318f3dCF7e"; // Base Sepolia USDC
// Destination: the chain + token + address you RECEIVE on.
const DEST_NETWORK = process.env.DEST_NETWORK ?? "eip155:42431";
const DEST_ASSET =
  process.env.DEST_ASSET ?? "0x20C0000000000000000000000000000000000000"; // Tempo Moderato pathUSD
const DEST_ADDRESS =
  process.env.DEST_ADDRESS ?? "0x0000000000000000000000000000000000000002";
// Exact amount you receive on the destination chain, in atomic units (100000 = 0.1 pathUSD at 6 decimals).
const FULFILLMENT_AMOUNT = process.env.FULFILLMENT_AMOUNT ?? "100000";
// Markup over FULFILLMENT_AMOUNT, in basis points (100 = 1%), covering fees/conversion. 0 = like-for-like.
const MARKUP_BPS = Number(process.env.MARKUP_BPS ?? "0");
// Keep this short: a quote-deadline budget that's too long is rejected by the
// corridor (20s was observed to fail; 5s settles synchronously).
const QUOTE_DEADLINE_SECONDS = Number(process.env.QUOTE_DEADLINE_SECONDS ?? "5");
const FULFILLMENT_DEADLINE_SECONDS = Number(process.env.FULFILLMENT_DEADLINE_SECONDS ?? "300");

// ---------------------------------------------------------------------------
// Corridor contracts — read from the gateway /defaults, never hand-copied.
// ---------------------------------------------------------------------------

interface GatewayDefaults {
  escrow_contract?: string;
  fulfillment_proxy?: string;
  quote_selector?: string;
  fulfillment_verifier?: { account: string; endpoint: string };
  error?: string;
}

interface Corridor {
  escrow: string; // source escrow_contract — where the payer's funds lock
  fulfillmentProxy: string; // destination fulfillment_proxy
  reserver: string; // source quote_selector
  releaser: string; // source fulfillment_verifier.account
  fulfillmentVerifierEndpoint: string; // source fulfillment_verifier.endpoint
}

async function fetchDefaults(chainId: string): Promise<GatewayDefaults> {
  const url = `${GATEWAY_URL}/defaults?chain_id=${encodeURIComponent(chainId)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} failed: ${res.status}`);
  const d = (await res.json()) as GatewayDefaults;
  if (d.error || !d.escrow_contract || !d.fulfillment_verifier) {
    throw new Error(`gateway has no corridor for ${chainId}: ${JSON.stringify(d)}`);
  }
  return d;
}

async function resolveCorridor(): Promise<Corridor> {
  if (!GATEWAY_URL) {
    // Local mock mode — the mock facilitator never inspects these, so inert
    // (but validly-shaped) placeholders are fine.
    return {
      escrow: "0x0000000000000000000000000000000000000001",
      fulfillmentProxy: "0x0000000000000000000000000000000000000003",
      reserver: "0x0000000000000000000000000000000000000004",
      releaser: "0x0000000000000000000000000000000000000005",
      fulfillmentVerifierEndpoint: "http://localhost:8080/veri-fill",
    };
  }

  // Source chain supplies the escrow, the roles, and the verifier endpoint;
  // the destination chain supplies the fulfillment proxy.
  const [source, dest] = await Promise.all([
    fetchDefaults(SOURCE_NETWORK),
    fetchDefaults(DEST_NETWORK),
  ]);

  return {
    escrow: source.escrow_contract!,
    fulfillmentProxy: dest.fulfillment_proxy!,
    reserver: source.quote_selector!,
    releaser: source.fulfillment_verifier!.account,
    fulfillmentVerifierEndpoint: source.fulfillment_verifier!.endpoint,
  };
}

async function main(): Promise<void> {
  const corridor = await resolveCorridor();

  const config: AtumEscrowServerConfig = {
    destination: { network: DEST_NETWORK, asset: DEST_ASSET, address: DEST_ADDRESS },
    fulfillmentAmount: FULFILLMENT_AMOUNT,
    markupBps: MARKUP_BPS,
    fulfillmentProxy: corridor.fulfillmentProxy,
    reserver: corridor.reserver,
    releaser: corridor.releaser,
    fulfillmentVerifierEndpoint: corridor.fulfillmentVerifierEndpoint,
    quoteDeadlineSeconds: QUOTE_DEADLINE_SECONDS,
    fulfillmentDeadlineSeconds: FULFILLMENT_DEADLINE_SECONDS,
    sources: { [SOURCE_NETWORK]: { asset: SOURCE_ASSET, escrow: corridor.escrow } },
  };

  // Delegate verify/settle to the facilitator; register the scheme for the source
  // network(s) this merchant offers. Construction validates the config (fail-loud).
  const server = registerAtumEscrowScheme(
    new x402ResourceServer(new HTTPFacilitatorClient({ url: FACILITATOR_URL })),
    config,
    Object.keys(config.sources) as `${string}:${string}`[],
  );

  // One accepts[] entry per source option, derived from the same config.
  const accepts = Object.entries(config.sources).map(([network, src]) => ({
    scheme: "atum-escrow",
    network: network as `${string}:${string}`,
    payTo: src.escrow,
    price: PRICE,
    maxTimeoutSeconds: 60,
  }));

  const app = express();

  // paymentMiddleware gates the route: it returns the 402 challenge when no
  // credential is present, and verifies + settles through the facilitator when
  // one is. The handler below runs only after payment is confirmed.
  app.use(
    paymentMiddleware(
      { "GET /paid": { accepts, description: "Example premium resource", mimeType: "application/json" } },
      server,
    ),
  );

  app.get("/paid", (_req, res) => {
    res.json({ message: "Access granted.", data: "Your premium content here." });
  });

  app.listen(PORT, () => {
    console.log(`Merchant listening on http://localhost:${PORT}`);
    console.log(`Facilitator: ${FACILITATOR_URL}`);
    if (GATEWAY_URL) {
      console.log(`Corridor:    ${SOURCE_NETWORK} → ${DEST_NETWORK} (contracts from ${GATEWAY_URL}/defaults)`);
    } else {
      console.log("Corridor:    local mock mode — no GATEWAY_URL set, using placeholder contracts");
    }
  });
}

main().catch((err: unknown) => {
  console.error("Failed to start merchant:", err);
  process.exit(1);
});
