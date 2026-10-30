/*
 * Copyright (c) 2026 Atum Labs, Inc.
 * SPDX-License-Identifier: MIT
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { ethers } from "ethers";
import { startStubGateway } from "./stub-gateway.js";
import { startStubAuth, stubCredential } from "./stub-auth.js";

// Runs the real pgc-make-payments client as a separate process, exactly as a
// developer would, against its in-process stub gateway. This catches the
// example's own wiring breaking (an import path, an SDK version bump, the
// offline signing flow) without needing a hosted gateway, funds, or a key —
// the client signs a Permit2 authorization off-chain, so no chain interaction
// happens here.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_DIR = path.resolve(HERE, "..");

// The client `import "dotenv/config"`s, which loads the .env in its working
// directory. Point every spawned process at a path that does not exist so dotenv
// loads nothing and the test stays hermetic — a developer's real .env can't leak in.
const NO_DOTENV = path.join(HERE, "no-such.env");

function tsxBin(dir: string): string {
  return path.join(dir, "node_modules", ".bin", "tsx");
}

function randomPrivateKey(): string {
  return `0x${randomBytes(32).toString("hex")}`;
}

interface RunResult {
  exitCode: number;
  output: string;
}

// The amount settings are read from the environment, so a developer shell that exports
// either one would silently change what these cases test. Strip both from the inherited
// environment and set only the ones a case names — "unset" has to mean absent, not "".
const AMOUNT_VARS = ["FULFILLMENT_AMOUNT", "MAX_SOURCE_AMOUNT"] as const;
// Likewise the session settings: a shell that exports USE_SESSION_TOKEN would turn every case
// into a session run.
const SESSION_VARS = ["USE_SESSION_TOKEN", "AUTH_URL", "CREDENTIAL_FILE", "STUB_AUTH_REFUSE"] as const;

function runClient(env: Record<string, string>): Promise<RunResult> {
  const childEnv: NodeJS.ProcessEnv = { ...process.env, DOTENV_CONFIG_PATH: NO_DOTENV };
  for (const name of [...AMOUNT_VARS, ...SESSION_VARS]) delete childEnv[name];
  Object.assign(childEnv, env);
  return new Promise((resolve, reject) => {
    const client = spawn(tsxBin(CLIENT_DIR), ["src/client.ts"], {
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

const STUB_ENV = {
  USE_STUB_GATEWAY: "true",
  RPC_URL: "",
  DEST_ADDRESS: "",
  GATEWAY_URL: "",
};

test("stub flow: prepare -> sign -> submit -> completed", async () => {
  const result = await runClient({ ...STUB_ENV, PRIVATE_KEY: randomPrivateKey() });
  assert.equal(result.exitCode, 0, `client exited non-zero:\n${result.output}`);
  assert.match(result.output, /settled\. — payment pay_stub_/, `expected a settled payment:\n${result.output}`);
  assert.match(
    result.output,
    /Request pmt_[0-9a-f]{20}/,
    `expected a generated request id:\n${result.output}`,
  );
});

test("a still-settling payment is collected by waiting on the same request id", async () => {
  const result = await runClient({
    ...STUB_ENV,
    PRIVATE_KEY: randomPrivateKey(),
    STUB_PENDING_ATTEMPTS: "2",
  });
  assert.equal(result.exitCode, 0, `client exited non-zero:\n${result.output}`);
  assert.match(result.output, /still settling/, `expected the pending wait to be reported:\n${result.output}`);
  assert.match(result.output, /settled\. — payment pay_stub_/, `expected the wait to settle:\n${result.output}`);
});

// A payment can fail without ever being merely "pending" — the gateway settles it
// terminally and there is nothing to deliver. Previously untested: client.ts's
// `outcome.status !== "completed"` branch, which is exactly what a real user hits
// when a payment actually fails.
test("a payment that settles as failed surfaces as a terminal error, not a silent success", async () => {
  const result = await runClient({
    ...STUB_ENV,
    PRIVATE_KEY: randomPrivateKey(),
    STUB_SETTLE_AS: "failed",
  });
  assert.notEqual(result.exitCode, 0, `expected a non-zero exit for a failed settlement:\n${result.output}`);
  assert.match(
    result.output,
    /failed and nothing was delivered/,
    `expected the terminal-failure error naming what happened:\n${result.output}`,
  );
});

// The payout is shown as soon as it is on chain (finalizing), once, and the run still ends on
// the final status. The submit answers pending, so the finalizing answers arrive during the wait.
test("shows the payout while it is finalizing, then reports completed", async () => {
  const result = await runClient({
    ...STUB_ENV,
    PRIVATE_KEY: randomPrivateKey(),
    STUB_PENDING_ATTEMPTS: "1",
    STUB_FINALIZING_CHECKS: "2",
  });
  assert.equal(result.exitCode, 0, `client exited non-zero:\n${result.output}`);
  const notFinal = result.output.indexOf("payout on chain, not yet final (finalizing)");
  const completed = result.output.indexOf("Status: completed");
  assert.ok(notFinal !== -1, `expected the payout while finalizing:\n${result.output}`);
  assert.ok(completed > notFinal, `expected Status: completed after the payout:\n${result.output}`);
  assert.equal(result.output.match(/Payment settled\./g)?.length, 1, `the payout is shown once:\n${result.output}`);
});

// A payment waiting on its refund is not final: a late delivery can still complete it. The
// payer must be told not to pay again, and how to reach the refund, by the payment's id.
test("a payment waiting on its refund names the payment and says not to pay again", async () => {
  const result = await runClient({
    ...STUB_ENV,
    PRIVATE_KEY: randomPrivateKey(),
    STUB_SETTLE_AS: "refund_available",
  });
  assert.notEqual(result.exitCode, 0, `a refund is not a delivery:\n${result.output}`);
  assert.match(result.output, /payment pay_stub_\w+ is refund_available/, `expected the payment id:\n${result.output}`);
  assert.match(result.output, /Do not pay again/, `expected the warning:\n${result.output}`);
  assert.match(result.output, /npx payment-status pay_stub_\w+/, `expected how to read the refund:\n${result.output}`);
  assert.doesNotMatch(result.output, /Status: completed/, `must not report completion:\n${result.output}`);
});

test("a refunded payment surfaces as terminal, not as a success", async () => {
  const result = await runClient({
    ...STUB_ENV,
    PRIVATE_KEY: randomPrivateKey(),
    STUB_SETTLE_AS: "refunded",
  });
  assert.notEqual(result.exitCode, 0, `a refund is not a delivery:\n${result.output}`);
  assert.match(result.output, /refunded and nothing was delivered/, `expected the terminal error:\n${result.output}`);
  assert.doesNotMatch(result.output, /Status: completed/, `must not report completion:\n${result.output}`);
});

test("resuming a payment reuses its request id instead of generating a new one", async () => {
  const requestId = "pmt_resumed_0123456789";
  const result = await runClient({
    ...STUB_ENV,
    PRIVATE_KEY: randomPrivateKey(),
    REQUEST_ID: requestId,
  });
  assert.equal(result.exitCode, 0, `client exited non-zero:\n${result.output}`);
  assert.match(
    result.output,
    new RegExp(`Request ${requestId}`),
    `REQUEST_ID must name the payment verbatim:\n${result.output}`,
  );
});

// The test above only proves the client READS REQUEST_ID into the outgoing request — it
// spawns one client against its own private, per-process stub, so it cannot prove the
// gateway actually treats a resumed payment idempotently. This test proves that: it starts
// ONE stub gateway shared by two separate client processes (mirroring how a real gateway
// is shared across runs), submits under a request id, kills that process the moment its
// own submission is confirmed accepted (simulating a crash mid-poll, not a slow payment),
// then reruns under the SAME request id against the SAME still-running stub and asserts the
// gateway hands back the original payment (`idempotent_replay: true`) instead of the client
// silently creating a second one.
test("a payment interrupted mid-poll is resumed via REQUEST_ID and hands back the original payment, not a second charge", async () => {
  // pendingAttempts: 1 — the first status check (which prints "still settling", our kill
  // signal) leaves the payment just short of terminal. By the time the second run resubmits,
  // that one check already used up the only pending attempt, so the resubmission itself
  // resolves as terminal immediately — no arbitrary sleep needed to make this test fast.
  const stub = await startStubGateway({ pendingAttempts: 1 });
  try {
    const requestId = `pmt_resume_${randomBytes(6).toString("hex")}`;
    const sharedEnv = {
      USE_STUB_GATEWAY: "false", // so the client points at OUR shared stub instead of spinning its own
      GATEWAY_URL: stub.url,
      RPC_URL: "",
      DEST_ADDRESS: "0x0000000000000000000000000000000000000001",
      PRIVATE_KEY: randomPrivateKey(),
      REQUEST_ID: requestId,
    };

    const firstEnv: NodeJS.ProcessEnv = { ...process.env, DOTENV_CONFIG_PATH: NO_DOTENV };
    for (const name of AMOUNT_VARS) delete firstEnv[name];
    Object.assign(firstEnv, sharedEnv);

    let firstOutput = "";
    await new Promise<void>((resolve, reject) => {
      // detached: true puts the child in its own process group, so we can kill that
      // WHOLE group below — tsx runs the client as a subprocess of this immediate
      // child, and a plain firstRun.kill() only reaches the tsx launcher, leaving the
      // real client process (mid-poll, holding a connection to our stub gateway)
      // running for up to its full 120s wait budget after our own "kill" returns.
      const firstRun = spawn(tsxBin(CLIENT_DIR), ["src/client.ts"], {
        cwd: CLIENT_DIR,
        env: firstEnv,
        detached: true,
      });
      const onChunk = (chunk: Buffer) => {
        firstOutput += chunk.toString();
        // The exact moment the payment is confirmed accepted server-side, and before it
        // could possibly reach a terminal outcome — killing here is the "process died
        // mid-settlement" this test exists to simulate, not "the payment finished".
        if (firstOutput.includes("still settling") && firstRun.pid) {
          try {
            process.kill(-firstRun.pid, "SIGKILL");
          } catch {
            firstRun.kill("SIGKILL"); // process already gone, or no permission to signal the group
          }
        }
      };
      firstRun.stdout.on("data", onChunk);
      firstRun.stderr.on("data", onChunk);
      firstRun.once("error", reject);
      firstRun.once("exit", () => resolve());
    });

    assert.deepEqual(
      stub.submitted(),
      [requestId],
      `expected exactly one submission before the simulated crash:\n${firstOutput}`,
    );

    const resumed = await runClient(sharedEnv);
    assert.equal(resumed.exitCode, 0, `resumed run exited non-zero:\n${resumed.output}`);
    assert.match(
      resumed.output,
      /handed back existing payment .* — nothing additional was charged/,
      `expected the gateway's idempotent replay to be reported, not a fresh charge:\n${resumed.output}`,
    );
    assert.match(resumed.output, /settled\. — payment pay_stub_/, `expected the resumed run to settle:\n${resumed.output}`);
    assert.deepEqual(
      stub.submitted(),
      [requestId, requestId],
      "expected the SAME request id on both submissions — a different one would mean this paid twice",
    );
  } finally {
    await stub.close();
  }
});

// A stub run signs offline and never touches a chain, so it needs a well-formed key
// rather than a funded one. Generating one keeps `npm run pay` working on a first
// run instead of stopping it to go and produce a key by hand.
test("stub run with no PRIVATE_KEY signs with a generated throwaway key", async () => {
  const result = await runClient({ ...STUB_ENV, PRIVATE_KEY: "" });
  assert.equal(result.exitCode, 0, `client exited non-zero:\n${result.output}`);
  assert.match(result.output, /settled\. — payment pay_stub_/, `expected a settled payment:\n${result.output}`);
  assert.match(
    result.output,
    /No PRIVATE_KEY set — signing this stub run with a throwaway key \(0x[0-9a-fA-F]{40}\)/,
    `expected the generated-key notice naming the address:\n${result.output}`,
  );
});

// Real settlement is the case where a generated key is the wrong answer: it would be
// an unfunded address, and the failure would surface as a reverted transaction rather
// than the missing config that caused it. RPC_URL (or USE_STUB_GATEWAY=false) is what
// marks the run as real.
test("exits with an error when PRIVATE_KEY is missing and RPC_URL is set", async () => {
  const result = await runClient({
    ...STUB_ENV,
    PRIVATE_KEY: "",
    RPC_URL: "http://127.0.0.1:1",
  });
  assert.notEqual(result.exitCode, 0, `expected a non-zero exit:\n${result.output}`);
  assert.match(
    result.output,
    /PRIVATE_KEY is required in \.env for real settlement/,
    `expected the missing-key error:\n${result.output}`,
  );
});

test("exits with an error when PRIVATE_KEY is missing and USE_STUB_GATEWAY=false", async () => {
  const result = await runClient({
    USE_STUB_GATEWAY: "false",
    PRIVATE_KEY: "",
    RPC_URL: "",
    DEST_ADDRESS: "0x0000000000000000000000000000000000000001",
  });
  assert.notEqual(result.exitCode, 0, `expected a non-zero exit:\n${result.output}`);
  assert.match(
    result.output,
    /PRIVATE_KEY is required in \.env for real settlement/,
    `expected the missing-key error:\n${result.output}`,
  );
});

function runStubWithAmounts(amounts: Partial<Record<(typeof AMOUNT_VARS)[number], string>>): Promise<RunResult> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DOTENV_CONFIG_PATH: NO_DOTENV,
    ...STUB_ENV,
    PRIVATE_KEY: randomPrivateKey(),
  };
  for (const name of AMOUNT_VARS) delete env[name];
  Object.assign(env, amounts);
  return new Promise((resolve, reject) => {
    const client = spawn(tsxBin(CLIENT_DIR), ["src/client.ts"], { cwd: CLIENT_DIR, env });
    let output = "";
    client.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    client.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
    client.once("error", reject);
    client.once("exit", (code) => resolve({ exitCode: code ?? 1, output }));
  });
}

const SETTLED = /settled\. — payment pay_stub_/;

// The spend cap is signed into the Permit2, so it must be a deliberate choice. Once the
// payer moves off the default fulfillment amount, any cap derived for them would be a
// guess about fees — refuse to run rather than sign one.
test("a custom FULFILLMENT_AMOUNT without MAX_SOURCE_AMOUNT is refused before anything is signed", async () => {
  const result = await runStubWithAmounts({ FULFILLMENT_AMOUNT: "60000" });
  assert.notEqual(result.exitCode, 0, `expected a non-zero exit:\n${result.output}`);
  assert.match(result.output, /MAX_SOURCE_AMOUNT/, `expected the error to name MAX_SOURCE_AMOUNT:\n${result.output}`);
  assert.doesNotMatch(result.output, SETTLED, `a refused payment must not settle:\n${result.output}`);
});

// This spawns its own stub inside the client, so it proves the explicit pair is accepted
// end to end; the verbatim test below checks the submitted body.
test("a custom FULFILLMENT_AMOUNT with an explicit MAX_SOURCE_AMOUNT settles", async () => {
  const result = await runStubWithAmounts({ FULFILLMENT_AMOUNT: "60000", MAX_SOURCE_AMOUNT: "60012" });
  assert.equal(result.exitCode, 0, `client exited non-zero:\n${result.output}`);
  assert.match(result.output, SETTLED, `expected a settled payment:\n${result.output}`);
});

// The cap is an integer count of the source token's smallest units. Zero authorizes
// nothing, a leading zero is ambiguous, and a decimal is a unit mix-up — each must be
// rejected up front rather than signed.
for (const malformed of ["abc", "0", "01", "1.5"]) {
  test(`a malformed MAX_SOURCE_AMOUNT (${JSON.stringify(malformed)}) is rejected`, async () => {
    const result = await runStubWithAmounts({ MAX_SOURCE_AMOUNT: malformed });
    assert.notEqual(result.exitCode, 0, `expected a non-zero exit:\n${result.output}`);
    assert.match(result.output, /MAX_SOURCE_AMOUNT/, `expected the error to name MAX_SOURCE_AMOUNT:\n${result.output}`);
  });
}

// The cap the payer names must be the cap the gateway is asked to settle under — not one
// the SDK re-derives on its own. 61000 is deliberately not what a fee-based derivation
// from 60000 would produce, so only a client that forwards MAX_SOURCE_AMOUNT verbatim can
// make the submitted body match. A shared stub is used because it is the only way to see
// the submitted body from the test process.
test("an explicit MAX_SOURCE_AMOUNT is submitted to the gateway verbatim as the spend cap", async () => {
  const stub = await startStubGateway();
  try {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      DOTENV_CONFIG_PATH: NO_DOTENV,
      USE_STUB_GATEWAY: "false", // so the client points at OUR shared stub instead of spinning its own
      GATEWAY_URL: stub.url,
      RPC_URL: "",
      DEST_ADDRESS: "0x0000000000000000000000000000000000000001",
      PRIVATE_KEY: randomPrivateKey(),
    };
    for (const name of AMOUNT_VARS) delete env[name];
    Object.assign(env, { FULFILLMENT_AMOUNT: "60000", MAX_SOURCE_AMOUNT: "61000" });

    const result = await new Promise<RunResult>((resolve, reject) => {
      const client = spawn(tsxBin(CLIENT_DIR), ["src/client.ts"], { cwd: CLIENT_DIR, env });
      let output = "";
      client.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
      client.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
      client.once("error", reject);
      client.once("exit", (code) => resolve({ exitCode: code ?? 1, output }));
    });

    assert.equal(result.exitCode, 0, `client exited non-zero:\n${result.output}`);
    assert.match(result.output, SETTLED, `expected a settled payment:\n${result.output}`);
    const requests = stub.submittedRequests();
    assert.equal(requests.length, 1, `expected exactly one submission:\n${result.output}`);
    assert.equal(requests[0].fulfillment_amount, "60000");
    assert.equal(requests[0].max_source_amount, "61000");
  } finally {
    await stub.close();
  }
});

// --- Session tokens (USE_SESSION_TOKEN=true) --------------------------------------
// These run the client against a stub gateway and a stub authorization service started here,
// so the test reads what each gateway call carried rather than what the client printed.

// The settings a run against our own stubs needs, with a credential issued to its payer.
function sessionRun(gatewayUrl: string, authUrl: string): Record<string, string> {
  const privateKey = randomPrivateKey();
  const file = path.join(mkdtempSync(path.join(tmpdir(), "pgc-session-")), "credential.json");
  writeFileSync(file, JSON.stringify(stubCredential(new ethers.Wallet(privateKey).address)));
  return {
    USE_STUB_GATEWAY: "false", // so the client points at OUR stubs instead of spinning its own
    GATEWAY_URL: gatewayUrl,
    RPC_URL: "",
    DEST_ADDRESS: "0x0000000000000000000000000000000000000001",
    PRIVATE_KEY: privateKey,
    USE_SESSION_TOKEN: "true",
    AUTH_URL: authUrl,
    CREDENTIAL_FILE: file,
  };
}

test("a session run sends the token on prepare, submit and every status check", async () => {
  const gateway = await startStubGateway({ pendingAttempts: 1 });
  const auth = await startStubAuth();
  try {
    const result = await runClient(sessionRun(gateway.url, auth.url));
    assert.equal(result.exitCode, 0, `client exited non-zero:\n${result.output}`);

    const calls = gateway.calls();
    assert.ok(calls.some((c) => c.call === "POST /v1/payments"), "expected a submit");
    assert.ok(calls.some((c) => /^GET \/v1\/payments\/.+\/status$/.test(c.call)), "expected a status check");
    assert.equal(auth.tokensIssued.length, 1, "one session covers the whole payment");
    for (const call of calls) {
      assert.equal(call.authorization, `Bearer ${auth.tokensIssued[0]}`, `${call.call} went without the token`);
    }
  } finally {
    await auth.close();
    await gateway.close();
  }
});

test("a refused session does not stop the payment: the calls go without a token", async () => {
  const gateway = await startStubGateway();
  const auth = await startStubAuth({ refuse: true });
  try {
    const result = await runClient(sessionRun(gateway.url, auth.url));
    assert.equal(result.exitCode, 0, `client exited non-zero:\n${result.output}`);
    assert.match(result.output, /No session token \(503 SERVICE_UNAVAILABLE\)/);
    assert.ok(gateway.submitted().length > 0, "expected the payment to be submitted");
    assert.deepEqual(
      gateway.calls().filter((c) => c.authorization !== undefined),
      [],
      "no call should carry a token",
    );
  } finally {
    await auth.close();
    await gateway.close();
  }
});

test("without USE_SESSION_TOKEN no gateway call carries a token", async () => {
  const gateway = await startStubGateway();
  try {
    const { USE_SESSION_TOKEN: _on, AUTH_URL: _auth, CREDENTIAL_FILE: _file, ...plain } = sessionRun(gateway.url, "");
    const result = await runClient(plain);
    assert.equal(result.exitCode, 0, `client exited non-zero:\n${result.output}`);
    assert.ok(gateway.calls().length > 0);
    assert.deepEqual(gateway.calls().filter((c) => c.authorization !== undefined), []);
  } finally {
    await gateway.close();
  }
});

test("a session run against a real gateway needs CREDENTIAL_FILE", async () => {
  const result = await runClient({
    USE_STUB_GATEWAY: "false",
    GATEWAY_URL: "http://127.0.0.1:9",
    RPC_URL: "",
    DEST_ADDRESS: "0x0000000000000000000000000000000000000001",
    PRIVATE_KEY: randomPrivateKey(),
    USE_SESSION_TOKEN: "true",
  });
  assert.equal(result.exitCode, 1);
  assert.match(result.output, /CREDENTIAL_FILE is required when USE_SESSION_TOKEN=true/);
});

test("a stub session run says every gateway call carried the token", async () => {
  const result = await runClient({ ...STUB_ENV, USE_SESSION_TOKEN: "true", STUB_PENDING_ATTEMPTS: "1" });
  assert.equal(result.exitCode, 0, `client exited non-zero:\n${result.output}`);
  assert.match(result.output, /Session token for 0x[0-9a-fA-F]{40}, sent on every gateway call/);
  assert.match(result.output, /(\d+) of \1 gateway calls carried the session token/);
});
