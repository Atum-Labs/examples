/**
 * ⚠️  FOR LOCAL DEVELOPMENT ONLY
 *
 * The **facilitator** is the hosted Atum service that verifies and settles x402
 * payments. This file is a throwaway local stand-in for it, so you can exercise
 * the full request flow with no funds and no network.
 *
 * It is NOT a replacement for the Atum x402 package: the merchant (`merchant.ts`)
 * still uses `@atumlabs/x402-atum-escrow/server` either way — this mock only
 * replaces the remote verify/settle service the package's HTTPFacilitatorClient
 * calls. Its `/verify` and `/settle` responses mirror the real facilitator's
 * contract, but always approve and never move funds.
 *
 * Every settlement it returns is tagged `mock: true` with a fake transaction
 * hash. For real settlement, point the merchant's FACILITATOR_URL at a hosted
 * Atum facilitator and set GATEWAY_URL so it reads live corridor addresses.
 */

import "dotenv/config";
import express, { Request, Response } from "express";

const PORT = Number(process.env.MOCK_FACILITATOR_PORT ?? 8091);

// Echo the merchant's configured source/destination so the mock stays coherent
// with whatever corridor you point it at.
const SOURCE_NETWORK = process.env.SOURCE_NETWORK ?? "eip155:84532";
const DEST_NETWORK = process.env.DEST_NETWORK ?? "eip155:42431";
const SOURCE_ASSET =
  process.env.SOURCE_ASSET ?? "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

const app = express();
app.use(express.json());

// POST /verify — always returns valid.
app.post("/verify", (_req: Request, res: Response) => {
  res.json({
    isValid: true,
    payer: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  });
});

// POST /settle — always returns success with a fake transaction hash.
app.post("/settle", (_req: Request, res: Response) => {
  res.json({
    success: true,
    transaction: "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
    network: DEST_NETWORK,
    payer: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    fulfillmentConfirmation: {
      mock: true,
      note: "This is a mock settlement — no funds were moved.",
    },
  });
});

// GET /supported — returns a minimal supported kinds list.
app.get("/supported", (_req: Request, res: Response) => {
  res.json({
    kinds: [
      {
        x402Version: 2,
        scheme: "atum-escrow",
        network: SOURCE_NETWORK,
        extra: {
          tokens: [SOURCE_ASSET],
        },
      },
    ],
    signers: {},
    extensions: [],
  });
});

app.listen(PORT, () => {
  console.log(`⚠️  Mock facilitator listening on http://localhost:${PORT}`);
  console.log("    /verify and /settle always succeed — no funds are moved.");
});
