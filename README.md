# Atum Examples

Proprietary reference implementations for approved developers building applications that interoperate with Atum products and services. This repository is **not open source**; access is available only through Atum approval (see [License](#license) below).

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

The default corridor is **Base Sepolia USDC → Tempo (Moderato) pathUSD**. Real testnet funds move, so the payer wallet must be funded and have approved the source token (Permit2). See each app's `.env.example` and `src/merchant.ts` for the exact values, and its "Going to testnet / mainnet" section for the full walkthrough.

> **`production-testnet` is a testnet, and it is not yet hardened.**
>
> Expect the possibility of occasional failures and slow corridors: a failed or timed-out result might not necessarily be a confirmed failure.
>
> When using `production-testnet`, verify settlement on-chain before retrying.

### Mainnet

Where authorized by Atum, the same examples run against mainnet: set the stub flag to `false`, point the gateway and facilitator URLs at the production endpoints Atum provides, and set the corridor to Atum-authorized mainnet chains and tokens. Contact Atum for production access and URLs.

## License

This repository contains proprietary Atum Labs reference implementations provided to approved developers to help them build applications that interoperate with Atum products and services.

The repository is **not open source**. Access and use are governed by the [`LICENSE`](./LICENSE) file at the root of this repository.

Subject to that license, approved developers may study, adapt, and incorporate portions of the examples into their own applications. Atum retains ownership of the examples and all Atum intellectual property. The examples may not be published, redistributed as source code, or offered as a standalone reference library, template collection, or implementation kit.

Atum may suspend or revoke repository access at any time. Ending access does not ordinarily require a developer to discontinue a compliant application already built from the examples, but it ends further use of the repository for new development and remains subject to the license's confidentiality, ownership, security, and use restrictions.

Access to any Atum package, API, gateway, network, credential, or other service is separate and may require additional authorization and terms. Contact Atum for access.
