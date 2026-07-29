# Atum Examples

Proprietary reference implementations for approved developers building applications that interoperate with Atum products and services. This repository is **not open source**; access is available only through Atum approval (see [License](#license) below).

## Early access? Start here

This repo is the fastest way to see an Atum payment work end-to-end — and during early access it's the **source of truth**: where anything else (the docs, an SDK default, an older guide) disagrees with these examples, follow the examples. They're pinned to the environment and corridor we actively test.

- **New here?** Start in stub mode (no funds), then move to real settlement — see [Environments](#environments) below. The path we've hardened for this preview is [Base Sepolia ↔ Tempo](#hosted-testnet-production-testnet); other chains exist in the platform, but this corridor is the most predictable to test here.
- **`production-testnet` is real but still hardening.** Expect the occasional slow corridor or timeout, and treat a timeout as *pending, not failed*: [verify settlement on-chain](docs/settlement-proof.md) before retrying, so you never pay twice.
- **Hit a bump?** Email [support@atumlabs.xyz](mailto:support@atumlabs.xyz) and tell us the specific friction you ran into.

## Environments

The examples run against three environments. Every merchant example defaults to the local stub, so real settlement is always opt-in.

| Environment | Use it to | Settlement | Funds | Opt in with |
| --- | --- | --- | --- | --- |
| **Local (stub)** | Wire up and debug your integration | Simulated in-process | None | Default |
| **Hosted testnet** (`production-testnet`) | Validate a real end-to-end payment | Real, on testnet rails | Testnet funds | `USE_STUB_FACILITATOR=false` (x402) / `USE_STUB_SUBMITTER=false` (MPP) |
| **Mainnet** | Go live (where authorized by Atum) | Real, on mainnet rails | Real funds | Stub flag `false` + Atum-provided production URLs |

### Local (stub)

Both merchant examples default to stub mode. The full `402 → pay → 200` flow runs in-process with no gateway, facilitator, or funds, so any private key works. Start here to confirm your wiring before touching real settlement.

### Hosted testnet (`production-testnet`)

Set the stub flag to `false` to settle for real over Atum's hosted testnet. The apps ship pointed at:

| Service | URL |
| --- | --- |
| Payment Gateway (MPP settlement + x402 corridor defaults) | `https://payment-gw.production-testnet.atum.xyz` |
| x402 facilitator | `https://x402-facilitator.production-testnet.atum.xyz` |

Atum supports many corridors ([supported assets](https://docs.atumlabs.xyz/get-started/reference/supported-assets)); the one these examples ship wired to — and are hardened against — is **Base Sepolia USDC → Tempo (Moderato) pathUSD**. Real testnet funds move, so the payer wallet must be funded and have approved the source token (Permit2). See each app's `.env.example` and `src/merchant.ts` for the exact values (and how to repoint the corridor).

> **`production-testnet` is a testnet, and it is not yet hardened.**
>
> Expect the possibility of occasional failures and slow corridors: a failed or timed-out result might not necessarily be a confirmed failure.
>
> When using `production-testnet`, verify settlement on-chain before retrying — so you never pay twice.

### Mainnet

Where authorized by Atum, the same examples run against mainnet: set the stub flag to `false`, point the gateway and facilitator URLs at the production endpoints Atum provides, and set the corridor to Atum-authorized mainnet chains and tokens. Contact Atum for production access and URLs.

## Running the tests

Each example is a standalone project with its own tests, but the repo root has a thin orchestration `package.json` (scripts only, no dependencies) that runs them all together. Everything below runs from the repo root; the commands at a glance:

| Command | What it runs | Funds |
| --- | --- | --- |
| `npm run install:all` | `npm install` in all four apps | — |
| `npm test` | Smoke tests for all four apps (alias for `test:smoke`) | None |
| `npm run test:e2e` | Real, funded settlement for both protocols, **both directions** of the shipped corridor | Real testnet funds (both chains) |
| `npm run test:all` | Smoke, then the funded e2e | Real testnet funds |
**Bring your own wallet:** set `PRIVATE_KEY` to a testnet key you control and fund it yourself. A single key is enough — an EOA has the same address on every EVM chain, so one key can pay on both sides of the corridor; just fund it on each chain it spends from.

**One-time setup:** the escrow pulls funds through Permit2, so each source token needs `approve(Permit2)` once per chain. `mpp-make-payments` does this automatically; `x402-make-payments` does not — see [its README](x402-make-payments/README.md#going-to-testnet--mainnet) for the exact commands on Base Sepolia and Tempo.

### Step 1 - Install

```bash
npm run install:all
```

### Step 2 - Smoke test — no funds (start here)

```bash
npm test
```

Hermetic: the full `402 → pay → 200` flow runs in-process against a stub — no gateway, no facilitator, no funds, so any private key works. It's the fast "is the wiring intact?" check; the funded e2e tests auto-skip.

### Step 3 - Funded settlement — real testnet funds

Settles real payments over the hosted testnet, for both protocols and in **both directions** of the corridor, so one run proves it settles either way.

**1. Bring your own testnet wallet.** The examples never ship or fund a key — you supply one you control. A single EOA is enough: it has the same address on every EVM chain, so one key pays on both sides of the corridor. Fund it on each chain it spends from. For the shipped **Base Sepolia ↔ Tempo** corridor:

- **Base Sepolia** — testnet USDC to spend, plus a little ETH for gas.
- **Tempo (Moderato)** — pathUSD, which also covers gas (Tempo has no native gas token). Fund it from the faucet:

```bash
cast rpc tempo_fundAddress 0xYourWallet --rpc-url https://rpc.moderato.tempo.xyz   # mints 1M pathUSD
```

**2. Export your key and receiving address.**

```bash
export PRIVATE_KEY=0xYourOwnTestnetKey  # the wallet you funded above
export DEST_ADDRESS=0xYourReceivingEOA  # your receiving address; used on whichever chain is the destination
```

**3. Run it.**

```bash
npm run test:e2e
```

Each `accept` app spawns the **real** `make` client against the hosted facilitator/gateway, so this exercises both sides (payer *and* merchant) of each protocol, each direction — four real settlements. Each prints a heartbeat (`⏳ … still settling — Ns elapsed`) while it settles (30–120s) and, on success, a direction-tagged summary with the corridor, amount, and on-chain transaction links. See the [settlement proof](docs/settlement-proof.md) to verify the result on-chain.

**Options.** Set `SKIP_REVERSE=1` to run the forward leg only (a quick check, or a wallet funded on just one chain). Other overrides: `FACILITATOR_URL`, `GATEWAY_URL`, and the per-direction source RPCs `RPC_URL` / `REVERSE_RPC_URL` (default to the shipped corridor's chains). To run one app alone, `cd` into it and `npm test` (add `RUN_REAL_E2E=1` for the funded legs).

> **Other corridors:** Base ↔ Tempo is what these examples are hardened against and wired to out of the box; the commands above use it for concreteness. Atum supports [other corridors](https://docs.atumlabs.xyz/get-started/reference/supported-assets) — to exercise one, repoint each app's `.env` (`SOURCE_*`/`DEST_*` and the source RPCs); see [`settlement-proof.md`](docs/settlement-proof.md).

## Evaluating settlement

Taking an integration toward production and want to confirm that settlement over these protocols is real and independently verifiable — whether you're the merchant, the payer, or building a platform on top of the rail. See **[Settlement proof: verifying real settlement over x402 and MPP](docs/settlement-proof.md)**. It walks through a self-serve, on-chain-verifiable real settlement for both protocols, the reliability differences between them, and what the examples deliberately leave to the layer above.

## License

This repository contains proprietary Atum Labs reference implementations provided to approved developers to help them build applications that interoperate with Atum products and services.

The repository is **not open source**. Access and use are governed by the [`LICENSE`](./LICENSE) file at the root of this repository.

Subject to that license, approved developers may study, adapt, and incorporate portions of the examples into their own applications. Atum retains ownership of the examples and all Atum intellectual property. The examples may not be published, redistributed as source code, or offered as a standalone reference library, template collection, or implementation kit.

Atum may suspend or revoke repository access at any time. Ending access does not ordinarily require a developer to discontinue a compliant application already built from the examples, but it ends further use of the repository for new development and remains subject to the license's confidentiality, ownership, security, and use restrictions.

Access to any Atum package, API, gateway, network, credential, or other service is separate and may require additional authorization and terms. Contact Atum for access.
