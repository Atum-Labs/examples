# Atum Examples

Reference implementations for accepting and making payments over x402 and MPP. Licensed under MIT — see [License](#license).

## Early access? Start here

This repo is the fastest way to see an Atum payment work end-to-end — and during early access it's the **source of truth**: where anything else (the docs, an SDK default, an older guide) disagrees with these examples, follow the examples. They're pinned to the environment and corridor we actively test.

- **New here?** Start in stub mode (no funds) — see [First run (local stub)](#first-run-local-stub) — then move to real settlement under [Environments](#environments). The path we've hardened for this preview is [Base Sepolia ↔ Tempo](#hosted-testnet-production-testnet); other chains exist in the platform, but this corridor is the most predictable to test here.
- **`production-testnet` is real but still hardening.** Expect the occasional slow corridor. A settlement that outruns the gateway's ~30s synchronous window is not a failure — the payer re-attempts the same purchase and collects the outcome, and cannot be charged twice for it.
- **Hit a bump?** Email [support@atumlabs.xyz](mailto:support@atumlabs.xyz) and tell us the specific friction you ran into.

## Environments

The examples run against three environments. Every merchant example defaults to the local stub, so real settlement is always opt-in.

| Environment | Use it to | Settlement | Funds | Opt in with |
| --- | --- | --- | --- | --- |
| **Local (stub)** | Wire up and debug your integration | Simulated in-process | None | Default |
| **Hosted testnet** (`production-testnet`) | Validate a real end-to-end payment | Real, on testnet rails | Testnet funds | `USE_STUB_FACILITATOR=false` (x402) / `USE_STUB_SUBMITTER=false` (MPP) |
| **Mainnet** | Go live (where authorized by Atum) | Real, on mainnet rails | Real funds | Stub flag `false` + Atum-provided production URLs |

### Local (stub)

Both merchant examples default to stub mode. The full `402 → pay → 200` flow runs in-process with no gateway, facilitator, funds, or keys — when `PRIVATE_KEY` is unset the payer generates a throwaway key for the run. Start here to confirm your wiring before touching real settlement.

### Hosted testnet (`production-testnet`)

Set the stub flag to `false` to settle for real over Atum's hosted testnet. The apps ship pointed at:

| Service | URL |
| --- | --- |
| Payment Gateway (MPP settlement + x402 corridor defaults) | `https://payment-gw.production-testnet.atum.xyz` |
| x402 facilitator | `https://payment-gw.production-testnet.atum.xyz/x402/v1` |

Same host, two values: the gateway hosts the x402 facilitator under a `/x402/v1` prefix, and that prefix is part of `FACILITATOR_URL`.

Atum supports many corridors ([supported assets](https://docs.atum.xyz/get-started/reference/supported-assets)); the one these examples ship wired to — and are hardened against — is **Base Sepolia USDC → Tempo (Moderato) pathUSD**. Real testnet funds move, so the payer wallet must be funded on the chain it spends from (the payers handle the Permit2 approval themselves). See each app's `.env.example` and `src/merchant.ts` for the exact values (and how to repoint the corridor).

> **`production-testnet` is a testnet, and it is not yet hardened.**
>
> Expect occasional slow corridors. When settlement outruns the gateway's ~30s synchronous window the merchant reports the payment as still settling rather than holding the connection open, and the payer re-attempts the **same purchase** until it reaches a terminal outcome. The re-attempt resolves onto the original payment, so it costs nothing and cannot charge twice. Both protocols work this way.

### Mainnet

Where authorized by Atum, the same examples run against mainnet: set the stub flag to `false`, point the gateway and facilitator URLs at the production endpoints Atum provides, and set the corridor to Atum-authorized mainnet chains and tokens. Contact Atum for production access and URLs.

## First run (local stub)

Confirm the `402 → pay → 200` wiring locally before touching funded settlement. **Stub mode needs no gateway, facilitator, funds, or keys** — the payer signs offline, so when `PRIVATE_KEY` is unset it generates a throwaway key for the run and prints the address.

The examples install `@atumlabs/x402-atum-escrow`, `@atumlabs/mppx-atum-escrow`, and `@atumlabs/payment-gateway-client` from public npm — no org invite.

### Node.js

**Node.js 20+** is the floor; CI covers 20, 22, and 24. On Node 20, MPP installs print `EBADENGINE` for a couple of transitive deps that declare `engines.node >= 22` — install and stub runs still succeed, and Node 22+ silences it. The x402 apps are unaffected.

### Run it

1. Install all four apps:

```bash
npm run install:all
```

2. **Terminal 1** — x402 merchant (port 4020):

```bash
cd x402-accept-payments
cp .env.example .env
npm run dev
```

3. **Terminal 2** — x402 payer. No `.env` needed for a stub run:

```bash
cd x402-make-payments
npm run pay
```

You should see a generated payer address, then `Status: 200` and `Access granted`. MPP is the same pair on port **4030**: `mpp-accept-payments` + `mpp-make-payments`.

Set `PRIVATE_KEY` in `.env` (copied from `.env.example`) when you move to real settlement — see [Environments](#environments).

## Running the tests

Each example is a standalone project with its own tests, but the repo root has a thin orchestration `package.json` (scripts only, no dependencies) that runs them all together. Everything below runs from the repo root; the commands at a glance:

| Command | What it runs | Funds |
| --- | --- | --- |
| `npm run install:all` | `npm install` in all four apps | — |
| `npm test` | Smoke tests for all four apps (alias for `test:smoke`) | None |
| `npm run test:smoke:pending` | The same suites, with the stubs reporting settlement as still in flight — exercises the payer's re-attempt path | None |
| `npm run test:e2e` | Real, funded settlement for both protocols, **both directions** of the shipped corridor | Real testnet funds (both chains) |
| `npm run test:all` | Smoke, then the funded e2e | Real testnet funds |
| `npm run typecheck` | `tsc --noEmit` across all four apps | — |

### Step 1 - Install

```bash
npm run install:all
```

### Step 2 - Smoke test — no funds (start here)

```bash
npm test
```

Hermetic: the full `402 → pay → 200` flow runs in-process against a stub — no gateway, no facilitator, no funds, no key required. It's the fast "is the wiring intact?" check; the funded e2e tests auto-skip.

### Step 3 - Funded settlement — real testnet funds

Settles real payments over the hosted testnet, for both protocols and in **both directions** of the corridor, so one run proves it settles either way.

**1. Bring your own testnet wallet.** The examples never ship or fund a key — you supply one you control. A single EOA is enough: it has the same address on every EVM chain, so one key pays on both sides of the corridor. Fund it on each chain it spends from. For the shipped **Base Sepolia ↔ Tempo** corridor:

- **Base Sepolia** — testnet USDC from [Circle's faucet](https://faucet.circle.com) to spend, plus a little ETH for gas from any Base Sepolia faucet.
- **Tempo (Moderato)** — pathUSD, which also covers gas (Tempo has no native gas token). Fund it from the faucet:

```bash
cast rpc tempo_fundAddress 0xYourWallet --rpc-url https://rpc.moderato.tempo.xyz   # mints 1M pathUSD
```

**2. Approve Permit2 — handled for you.** Real settlement pulls your funds through Permit2, so each source token needs an `approve(Permit2)` per chain. Both payers do this themselves via `ensureSourceApproval` when `RPC_URL` is set: they read the current allowance and send an approval only if it falls short, so it happens once and is a no-op thereafter. The wallet just needs gas on the source chain.

**3. Export your key and receiving address.**

```bash
export PRIVATE_KEY=0xYourOwnTestnetKey  # the wallet you funded above
export DEST_ADDRESS=0xYourReceivingEOA  # your receiving address; used on whichever chain is the destination
```

**4. Run it.**

```bash
npm run test:e2e
```

Each `accept` app spawns the **real** `make` client against the hosted facilitator/gateway, so this exercises both sides (payer *and* merchant) of each protocol, each direction — four real settlements. Each prints a heartbeat (`⏳ … still settling — Ns elapsed`) while it settles (typically 25–40s per leg) and, on success, a direction-tagged summary with the corridor, amount, and on-chain transaction links. See the [settlement proof](docs/settlement-proof.md) to verify the result on-chain.

**Options.** Set `SKIP_REVERSE=1` to run the forward leg only (a quick check, or a wallet funded on just one chain). A slow corridor needs no special handling — the payer re-attempts the purchase until it settles. To run one app alone, `cd` into it and `npm test` (add `RUN_REAL_E2E=1` for the funded legs).

`.env` configures the apps you start **by hand** (`npm run dev`, `npm run pay`). The test suites deliberately do not read it, so a `.env` left over from local work cannot change what a funded run settles — set these in your **shell** instead: `FACILITATOR_URL`, `GATEWAY_URL`, the corridor (`SOURCE_NETWORK`, `SOURCE_ASSET`, `DEST_NETWORK`, `DEST_ASSET`), and each leg's source-chain RPC (`RPC_URL` forward, `REVERSE_RPC_URL` reverse). All default to the shipped corridor, and each leg prints the corridor it is about to settle before any funds move.

> **Other corridors:** Base ↔ Tempo is what these examples are hardened against and wired to out of the box. Atum supports [other corridors](https://docs.atum.xyz/get-started/reference/supported-assets) — export the variables above to exercise one (`.env` is for the by-hand `npm run dev`); see [`settlement-proof.md`](docs/settlement-proof.md). Two values don't follow the corridor: each leg's RPC must point at that leg's own **source** chain, and `FULFILLMENT_AMOUNT` is atomic units for a **6-decimal** token.

## Evaluating settlement

Taking an integration toward production and want to confirm that settlement over these protocols is real and independently verifiable? See **[Settlement proof: verifying real settlement over x402 and MPP](docs/settlement-proof.md)**. It walks through a self-serve, on-chain-verifiable real settlement for both protocols, the reliability differences between them, and what the examples deliberately leave to the layer above.

## License

This repository is licensed under the [MIT License](./LICENSE). You may copy, modify, and ship these examples in your own applications.

The `@atumlabs/*` packages they depend on are licensed separately. Access to any Atum API, gateway, network, or other service remains subject to that service's own terms.
