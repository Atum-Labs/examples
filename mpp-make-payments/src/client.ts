import "dotenv/config";
import { ethers } from "ethers";
import { Mppx } from "mppx/client";
import { registerClient } from "@atum-labs/mppx-atum-escrow/client";

const { PRIVATE_KEY, RESOURCE_URL = "http://localhost:4030/paid-resource" } = process.env;

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

// A single call: mppx handles the 402, builds and signs the credential, and retries.
console.log(`Requesting ${RESOURCE_URL} …`);
const res = await mppx.fetch(RESOURCE_URL);
const body = await res.text();
const receipt = res.headers.get("payment-receipt");

console.log(`Status: ${res.status}`);
console.log(`Payment-Receipt header: ${receipt ? "present" : "(none)"}`);
console.log(body);
