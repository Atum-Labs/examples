/*
 * Copyright (c) 2026 Atum Labs, Inc.
 * SPDX-License-Identifier: MIT
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { ethers } from "ethers";
import { PaymentGatewayClient } from "@atumlabs/payment-gateway-client";
import { SessionTokenError, signerFromEthersWallet } from "@atumlabs/payment-gateway-client/signing";
import { RENEW_BEFORE_MS, SessionTokens } from "./session.js";
import { STUB_TOKEN_LIFETIME_SECONDS, startStubAuth, stubCredential } from "./stub-auth.js";

// Runs the example's pieces, and the client itself as a separate process, against the in-process
// stub. This catches the example's own wiring breaking (an import path, an SDK version bump, the
// session flow) without a credential, a network or a key.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_DIR = path.resolve(HERE, "..");
// The client loads .env from its working directory; point it at nothing so the test is hermetic.
const NO_DOTENV = path.join(HERE, "no-such.env");

function runClient(env: Record<string, string>): Promise<{ exitCode: number; output: string }> {
  const childEnv: NodeJS.ProcessEnv = { ...process.env, DOTENV_CONFIG_PATH: NO_DOTENV };
  for (const name of ["PRIVATE_KEY", "CREDENTIAL_FILE", "AUTH_URL", "GATEWAY_URL"]) delete childEnv[name];
  Object.assign(childEnv, env);
  return new Promise((resolve, reject) => {
    const client = spawn(path.join(CLIENT_DIR, "node_modules", ".bin", "tsx"), ["src/client.ts"], {
      cwd: CLIENT_DIR,
      env: childEnv,
    });
    let output = "";
    client.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    client.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
    client.once("error", reject);
    client.once("exit", (code) => resolve({ exitCode: code ?? 1, output }));
  });
}

test("stub run: nonce -> signed presentation -> token -> a gateway call that carries it", async () => {
  const { exitCode, output } = await runClient({ USE_STUB_AUTH: "true" });
  assert.equal(exitCode, 0, output);
  assert.match(output, /Session token, valid for 60 minutes/);
  assert.match(output, /the stub gateway received: Bearer stub\./);
  assert.match(output, /Session established\./);
});

test("a real run without a wallet and credential refuses to start", async () => {
  const { exitCode, output } = await runClient({ USE_STUB_AUTH: "false" });
  assert.equal(exitCode, 1);
  assert.match(output, /PRIVATE_KEY and CREDENTIAL_FILE are required/);
});

test("the gateway client sends the session token as a bearer token", async () => {
  const stub = await startStubAuth();
  try {
    const wallet = ethers.Wallet.createRandom();
    const sessions = new SessionTokens({
      authUrl: stub.url,
      credentials: [stubCredential(wallet.address)],
      signer: signerFromEthersWallet(wallet),
    });
    const gateway = new PaymentGatewayClient({ BASE: stub.url, TOKEN: () => sessions.current() });

    await gateway.chainDefaults.getDefaults({ chainId: "eip155:84532" });

    assert.equal(stub.tokensIssued.length, 1);
    assert.deepEqual(stub.gatewayAuthorization, [`Bearer ${stub.tokensIssued[0]}`]);
  } finally {
    await stub.close();
  }
});

test("a token is reused until shortly before it expires, then replaced by a new session", async () => {
  const stub = await startStubAuth();
  try {
    const wallet = ethers.Wallet.createRandom();
    let now = Date.now();
    const sessions = new SessionTokens(
      { authUrl: stub.url, credentials: [stubCredential(wallet.address)], signer: signerFromEthersWallet(wallet) },
      () => now,
    );

    const first = await sessions.current();
    now += STUB_TOKEN_LIFETIME_SECONDS * 1000 - RENEW_BEFORE_MS - 5_000;
    assert.equal(await sessions.current(), first, "still well inside its lifetime");
    assert.equal(stub.noncesIssued, 1);

    now += 10_000;
    const second = await sessions.current();
    assert.notEqual(second, first, "renewed inside the margin before expiry");
    assert.equal(stub.noncesIssued, 2, "a renewal is a new session with a fresh nonce");
  } finally {
    await stub.close();
  }
});

test("concurrent callers share one renewal instead of each spending a nonce", async () => {
  const stub = await startStubAuth();
  try {
    const wallet = ethers.Wallet.createRandom();
    const sessions = new SessionTokens({
      authUrl: stub.url,
      credentials: [stubCredential(wallet.address)],
      signer: signerFromEthersWallet(wallet),
    });
    const tokens = await Promise.all([sessions.current(), sessions.current(), sessions.current()]);
    assert.equal(new Set(tokens).size, 1);
    assert.equal(stub.noncesIssued, 1);
  } finally {
    await stub.close();
  }
});

test("a refused exchange surfaces as SessionTokenError with the service's code", async () => {
  const stub = await startStubAuth();
  try {
    const wallet = ethers.Wallet.createRandom();
    const notKnownToAtum = { ...stubCredential(wallet.address), type: ["VerifiableCredential"] };
    const sessions = new SessionTokens({
      authUrl: stub.url,
      credentials: [notKnownToAtum],
      signer: signerFromEthersWallet(wallet),
    });
    await assert.rejects(sessions.current(), (error: unknown) => {
      assert.ok(error instanceof SessionTokenError);
      assert.equal(error.status, 403);
      assert.equal(error.code, "CREDENTIAL_MISSING");
      return true;
    });
  } finally {
    await stub.close();
  }
});

test("a credential issued to another wallet is refused before anything is sent", async () => {
  const stub = await startStubAuth();
  try {
    const sessions = new SessionTokens({
      authUrl: stub.url,
      credentials: [stubCredential(ethers.Wallet.createRandom().address)],
      signer: signerFromEthersWallet(ethers.Wallet.createRandom()),
    });
    await assert.rejects(sessions.current(), /sign with the wallet the credentials name/);
    assert.equal(stub.noncesIssued, 1, "only the nonce was requested; no presentation was sent");
    assert.equal(stub.tokensIssued.length, 0);
  } finally {
    await stub.close();
  }
});
