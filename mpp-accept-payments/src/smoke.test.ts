import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { randomBytes } from "node:crypto";

// Boots the real merchant (stub mode — no gateway, no funds) and the real client
// as separate processes, exactly as a developer would run them by hand, and checks
// the documented outcome: 402 -> pay -> 200 with a Payment-Receipt header. This
// exists to catch the example's own wiring breaking (e.g. an import path or an
// mppx/SDK version bump) — the protocol logic itself is covered by the SDK's tests.
//
// Each test gets its own port and its own merchant process — not because concurrent
// requests are expected to interfere (each challenge gets its own `expires`, and the
// deposit nonce is scoped to the payer account — see the multi-client test below),
// but so the tests themselves stay independent of one another and can be run in
// any order or in parallel without port clashes.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MERCHANT_DIR = path.resolve(HERE, "..");
const CLIENT_DIR = path.resolve(HERE, "../../mpp-make-payments");

// The merchant and client both `import "dotenv/config"`, which loads the .env in
// their working directory. Every spawned process below is pointed at a path that
// does not exist, so dotenv loads nothing and the tests stay hermetic. Otherwise a
// developer's real .env (real MPP_SECRET_KEY, USE_STUB_SUBMITTER=false, a live
// gateway) leaks into the child and, e.g., defeats the placeholder-secret guard the
// refuse-to-start test relies on — booting the merchant in real mode so it never exits.
const NO_DOTENV = path.join(HERE, "no-such.env");

function tsxBin(dir: string): string {
  return path.join(dir, "node_modules", ".bin", "tsx");
}

function randomPrivateKey(): string {
  return `0x${randomBytes(32).toString("hex")}`;
}

function waitForStdout(
  child: ChildProcessWithoutNullStreams,
  match: string,
  timeoutMs = 10_000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timed out waiting for merchant output to include "${match}"`)),
      timeoutMs,
    );
    child.stdout.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes(match)) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`merchant exited early (code ${code}) before printing "${match}"`));
    });
  });
}

function runClient(env: Record<string, string>): Promise<{ exitCode: number; output: string }> {
  return new Promise((resolve, reject) => {
    const client = spawn(tsxBin(CLIENT_DIR), ["src/client.ts"], {
      cwd: CLIENT_DIR,
      env: { ...process.env, DOTENV_CONFIG_PATH: NO_DOTENV, ...env },
    });
    let output = "";
    client.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    client.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
    client.once("error", reject);
    client.once("exit", (code) => resolve({ exitCode: code ?? 1, output }));
  });
}

async function withMerchant(port: number, fn: (merchantUrl: string) => Promise<void>): Promise<void> {
  const merchant = spawn(tsxBin(MERCHANT_DIR), ["src/merchant.ts"], {
    cwd: MERCHANT_DIR,
    env: { ...process.env, DOTENV_CONFIG_PATH: NO_DOTENV, PORT: String(port), USE_STUB_SUBMITTER: "true" },
  });
  merchant.stderr.on("data", () => {}); // drained so a slow reader can't back-pressure the child

  try {
    await waitForStdout(merchant, "MPP merchant listening");
    await fn(`http://localhost:${port}/paid`);
  } finally {
    merchant.kill();
  }
}

function assertPaid(result: { exitCode: number; output: string }, label: string): void {
  assert.equal(result.exitCode, 0, `${label} exited non-zero:\n${result.output}`);
  assert.match(result.output, /Status: 200/, `${label} expected a 200 response:\n${result.output}`);
  assert.match(
    result.output,
    /Payment-Receipt header: present/,
    `${label} expected a Payment-Receipt header:\n${result.output}`,
  );
}

test("stub flow: 402 -> pay -> 200 with a receipt", async () => {
  await withMerchant(4098, async (merchantUrl) => {
    const result = await runClient({
      PRIVATE_KEY: randomPrivateKey(),
      MERCHANT_URL: merchantUrl,
      RPC_URL: "",
    });
    assertPaid(result, "client");
  });
});

test("concurrent payments from different wallets all succeed", async () => {
  await withMerchant(4097, async (merchantUrl) => {
    const CLIENT_COUNT = 5;
    const results = await Promise.all(
      Array.from({ length: CLIENT_COUNT }, () =>
        runClient({ PRIVATE_KEY: randomPrivateKey(), MERCHANT_URL: merchantUrl, RPC_URL: "" }),
      ),
    );
    results.forEach((result, i) => assertPaid(result, `client ${i}`));
  });
});

test("the same wallet can complete multiple independent payments in sequence", async () => {
  await withMerchant(4096, async (merchantUrl) => {
    const key = randomPrivateKey();
    for (let i = 0; i < 3; i++) {
      const result = await runClient({ PRIVATE_KEY: key, MERCHANT_URL: merchantUrl, RPC_URL: "" });
      assertPaid(result, `payment ${i + 1}`);
    }
  });
});

test("refuses to start in real-settlement mode with the default placeholder secret", async () => {
  // MPP_SECRET_KEY is deleted (not just omitted) so this test doesn't depend on
  // whatever happens to be set in the environment it runs in.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DOTENV_CONFIG_PATH: NO_DOTENV,
    PORT: "4095",
    USE_STUB_SUBMITTER: "false",
  };
  delete env.MPP_SECRET_KEY;

  const merchant = spawn(tsxBin(MERCHANT_DIR), ["src/merchant.ts"], { cwd: MERCHANT_DIR, env });
  let output = "";
  merchant.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
  merchant.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));

  const exitCode: number = await new Promise((resolve) =>
    merchant.once("exit", (code) => resolve(code ?? 1)),
  );

  assert.notEqual(exitCode, 0, `expected the merchant to refuse to start:\n${output}`);
  assert.match(output, /Refusing to start/, `expected the placeholder-secret guard to fire:\n${output}`);
});
