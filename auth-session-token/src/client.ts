/*
 * Copyright (c) 2026 Atum Labs, Inc.
 * SPDX-License-Identifier: MIT
 */

import "dotenv/config";
import { readFileSync } from "node:fs";
import { ethers } from "ethers";
import { PaymentGatewayClient } from "@atumlabs/payment-gateway-client";
import { SessionTokenError, signerFromEthersWallet } from "@atumlabs/payment-gateway-client/signing";
import { SessionTokens } from "./session.js";
import { startStubAuth, stubCredential } from "./stub-auth.js";
import { banner, detail, line, style, successBanner } from "./display.js";

const USE_STUB_AUTH = (process.env.USE_STUB_AUTH ?? "true") !== "false";

const {
  PRIVATE_KEY,
  CREDENTIAL_FILE,
  AUTH_URL = "https://auth.production-testnet.atum.xyz",
  GATEWAY_URL = "https://payment-gw.production-testnet.atum.xyz",
} = process.env;

// A real session needs the wallet a Known to Atum credential was issued to, and that credential.
// Neither can be generated here: the credential comes from Atum's onboarding, and a throwaway
// wallet is one no credential names.
if (!USE_STUB_AUTH && (!PRIVATE_KEY || !CREDENTIAL_FILE)) {
  console.error(
    "Error: PRIVATE_KEY and CREDENTIAL_FILE are required in .env when USE_STUB_AUTH=false: the wallet " +
      "your Known to Atum credential is issued to, and the credential itself.",
  );
  process.exit(1);
}

const wallet = new ethers.Wallet(PRIVATE_KEY || ethers.Wallet.createRandom().privateKey);
const stub = USE_STUB_AUTH ? await startStubAuth() : undefined;
const authUrl = stub?.url ?? AUTH_URL;
const gatewayUrl = stub?.url ?? GATEWAY_URL;
const credentials = stub
  ? [stubCredential(wallet.address)]
  : [JSON.parse(readFileSync(CREDENTIAL_FILE as string, "utf8")) as unknown];

banner("Session token", USE_STUB_AUTH ? "stub" : new URL(authUrl).host);
line("👛", `Holder   ${wallet.address}`);

const sessions = new SessionTokens({
  authUrl,
  credentials,
  signer: signerFromEthersWallet(wallet),
});

try {
  // Fetches a nonce, signs a presentation of the credential that answers it, and exchanges the
  // presentation for a token. The key signs locally and never leaves this process.
  await sessions.current();
} catch (error) {
  await stub?.close();
  if (error instanceof SessionTokenError) {
    console.error(`\nThe session was refused: ${error.status} ${error.code ?? ""}`.trimEnd());
    console.error(`  ${error.message}`);
    if (error.retryAfterSeconds !== undefined) {
      console.error(`  Try again in ${error.retryAfterSeconds}s. A retry starts a new session with a fresh nonce.`);
    }
    process.exit(1);
  }
  throw error;
}

const token = sessions.token!;
line("🔑", `Session token, valid for ${Math.round(token.expiresIn / 60)} minutes (until ${token.expiresAt.toISOString()})`);
// A bearer token is a credential in its own right: anyone holding it is treated as this wallet until
// it expires, so it is shortened here rather than printed.
detail(style.dim(`${token.accessToken.slice(0, 10)}… treat it as a secret, and its contents as opaque`));

// Every call this client makes now sends Authorization: Bearer <token>. TOKEN is a function, so the
// client asks for the current token on each call and SessionTokens renews it shortly before expiry:
// there is no refresh, so a long-running process starts a new session instead.
const gateway = new PaymentGatewayClient({ BASE: gatewayUrl, TOKEN: () => sessions.current() });
const defaults = await gateway.chainDefaults.getDefaults({ chainId: "eip155:84532" });
line("📡", `GET /v1/defaults sent with the token (${"chain_id" in defaults ? defaults.chain_id : "every chain"})`);

if (stub) {
  const sent = stub.gatewayAuthorization.at(-1);
  detail(style.dim(`the stub gateway received: ${sent ? `${sent.slice(0, 17)}…` : "no Authorization header"}`));
  await stub.close();
}

successBanner("Session established.");
