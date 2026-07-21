import "dotenv/config";
import { ethers } from "ethers";
import { Mppx } from "mppx/client";
import { registerClient, ensureSourceApproval, type AtumEscrowChallenge } from "@atum-labs/mppx-atum-escrow/client";

const { PRIVATE_KEY, MERCHANT_URL = "http://localhost:4030/paid", RPC_URL } = process.env;

if (!PRIVATE_KEY) {
  console.error("Error: PRIVATE_KEY is required in .env");
  process.exit(1);
}

// The source-chain account is derived from the key. The server rejects a credential
// whose deposit signature does not recover to this account, so the two must match.
const account = new ethers.Wallet(PRIVATE_KEY).address;

// Register `atum-escrow` on the mppx client. The private key is bound to the
// challenge's source chain automatically, so one registration pays any supported source.
const method = registerClient({ signer: { privateKey: PRIVATE_KEY }, account });
const mppx = Mppx.create({ methods: [method] });

// Optional: when RPC_URL is set, approve the source token (Permit2) before paying so the
// escrow deposit does not revert at settlement. The token, chain, and exact amount come
// from the 402 challenge, and this handler is awaited before the signed retry. Leave
// RPC_URL unset against the default stub merchant — there is no real chain to approve on.
if (RPC_URL) {
  const signer = new ethers.Wallet(PRIVATE_KEY, new ethers.JsonRpcProvider(RPC_URL));
  mppx.onChallengeReceived(async ({ challenge }) => {
    const { source } = (challenge as AtumEscrowChallenge).request;
    const result = await ensureSourceApproval({
      network: source.network,
      token: source.asset,
      owner: account,
      signer,
      requiredAllowance: BigInt(source.amount),
    });
    console.log(
      result.alreadySufficient
        ? "Source token already approved."
        : `Approved source token (tx ${result.txHash}).`,
    );
    // Return nothing: this handler only approves as a side effect. Returning a string
    // here would override mppx's credential creation, which we don't want.
    return undefined;
  });
}

// A single call: mppx handles the 402, builds and signs the credential, and retries.
console.log(`Requesting ${MERCHANT_URL} …`);
const res = await mppx.fetch(MERCHANT_URL);
const receipt = res.headers.get("payment-receipt");
const body = await res.json().catch(() => res.text());

console.log(`Status: ${res.status}`);
console.log(`Payment-Receipt header: ${receipt ? "present" : "(none)"}`);
console.log(JSON.stringify(body, null, 2));
