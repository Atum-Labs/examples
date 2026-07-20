import "dotenv/config";
import { ethers } from "ethers";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { registerAtumEscrowScheme } from "@atumlabs/x402-atum-escrow/client";

const { PRIVATE_KEY, MERCHANT_URL = "http://localhost:4020/paid", RPC_URL } = process.env;

if (!PRIVATE_KEY) {
  console.error("Error: PRIVATE_KEY is required in .env");
  process.exit(1);
}

const wallet = new ethers.Wallet(PRIVATE_KEY);
const client = new x402Client();

registerAtumEscrowScheme(client, { signer: wallet });

// Optional: preflight Permit2 allowance before signing so a missing
// approve() fails fast here instead of reverting on-chain at settle.
if (RPC_URL) {
  const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const owner = await wallet.getAddress();

  client.onBeforePaymentCreation(async ({ selectedRequirements }) => {
    const erc20 = new ethers.Contract(
      selectedRequirements.asset,
      ["function allowance(address,address) view returns (uint256)"],
      provider,
    );
    const allowance = (await erc20.allowance(owner, PERMIT2)) as bigint;
    if (allowance < BigInt(selectedRequirements.amount)) {
      return {
        abort: true,
        reason: `Insufficient Permit2 allowance on ${selectedRequirements.asset}. Run approve(Permit2) on your source token first.`,
      };
    }
  });
}

const fetchWithPayment = wrapFetchWithPayment(fetch, client);

console.log(`Requesting ${MERCHANT_URL} …`);
const response = await fetchWithPayment(MERCHANT_URL);
const body = await response.json().catch(() => response.text());

console.log(`Status: ${response.status}`);
console.log(JSON.stringify(body, null, 2));
