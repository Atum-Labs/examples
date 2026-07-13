/**
 * ⚠️  FOR LOCAL DEVELOPMENT ONLY
 *
 * This is a mock x402 facilitator that always approves and "settles" payments
 * without touching any blockchain. It exists so you can run the full request
 * flow locally before you have an Atum-provided facilitator URL.
 *
 * Replace FACILITATOR_URL in your .env with the real URL when you're ready
 * to test against testnet or mainnet.
 */

import "dotenv/config";
import express, { Request, Response } from "express";

const PORT = Number(process.env.MOCK_FACILITATOR_PORT ?? 8091);

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
    network: "eip155:42161",
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
        network: "eip155:8453",
        extra: {
          tokens: ["0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"],
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
