# x402-accept-payments

An example merchant server that accepts cross-chain payments using the [x402](https://x402.org) protocol and Atum's `atum-escrow` scheme.

The merchant gates a route (`GET /paid`) behind payment: unpaid requests receive an HTTP `402` with the payment options the merchant accepts; a request carrying a valid payment credential is verified and settled through the Atum x402 facilitator before the protected content is returned.

By default this example uses a **stub** that runs the full `402 → pay → 200` flow locally with no facilitator, gateway, or funds — the x402 counterpart of the stub submitter in [`mpp-accept-payments`](../mpp-accept-payments). Flip one flag to settle for real.

> **Proprietary reference example.** This is an Atum reference implementation provided to approved developers — not open-source software. The packages, facilitator, gateway, chains, assets, and corridors it shows (e.g. Base Sepolia, Tempo, pathUSD) are illustrative; their availability and your access to them require separate Atum authorization and are **not** implied by their appearance here. Atum makes no promise of support, maintenance, compatibility, or production availability. Contact Atum for access.

## How it works

1. A client hits `GET /paid` without a payment credential.
2. The merchant returns `402 Payment Required` with its accepted payment options in a `PAYMENT-REQUIRED` header (mirrored in the JSON body for readability).
3. The client signs a payment credential and retries with a `PAYMENT-SIGNATURE` header.
4. The merchant calls the facilitator's `/verify` — validates the credential without moving funds.
5. The merchant calls `/settle` — funds move on-chain.
6. The merchant returns `200 OK` with the protected resource and a `PAYMENT-RESPONSE` header carrying the settlement receipt.

In stub mode, steps 4–5 are short-circuited in-process with a canned success — nothing settles and no funds move.

## Prerequisites

- Node.js 20+
- npm

## Quickstart

### 1. Install dependencies

```bash
npm install
```

The merchant itself has no private dependencies — it runs the stub flow with only public packages. That's deliberate: x402's server side is a public spec, so this merchant is hand-rolled on public packages, unlike the [`mpp-accept-payments`](../mpp-accept-payments) merchant, which builds on Atum's `mppx` method. (Driving a real payment through it uses the [`x402-make-payments`](../x402-make-payments) client, which needs early-access npm access — see that example and [Testing](#testing) below.)

### 2. Configure environment

```bash
cp .env.example .env
```

The defaults run the stub submitter — no changes needed to try the flow locally.

### 3. Start the server

```bash
npm run dev
```

You should see:

```
Merchant listening on http://localhost:4020
Facilitator: stub (local, no funds)
```

### 4. Try a payment

Drive a payment through it with the [`x402-make-payments`](../x402-make-payments) client — a `curl` can't easily produce the signed credential x402 expects. Start this server, then run `npm run pay` there; you should get a `200` with an `Access granted` body.

## Testing

```bash
npm test
```

This boots the merchant (stub mode) and drives real payments against it using the `x402-make-payments` client, then checks for a successful `200`. It also covers concurrent payments from different wallets, the same wallet paying more than once, and the server refusing to start when it's misconfigured for real settlement.

**Running the tests needs early-access npm access.** The test drives the `x402-make-payments` client, which depends on `@atumlabs/x402-atum-escrow` — a **restricted** package on npm. It can't be installed without authentication, so the suite runs **locally**, not in public CI.

Local (one-time):

```bash
npm login                                   # an account granted @atumlabs access
cd ../x402-make-payments && npm install     # installs the restricted client package
cd ../x402-accept-payments && npm install
npm test
```

Running it in your own private CI: provide an automation token with read access to the `@atumlabs` scope as an `NPM_TOKEN` secret, write an `.npmrc` before install, then `npm ci` in both apps and `npm test`:

```
//registry.npmjs.org/:_authToken=${NPM_TOKEN}
@atumlabs:registry=https://registry.npmjs.org
```

> The end-to-end test that settles against the live facilitator is **opt-in** — it moves real testnet funds. Run it with a funded wallet:
>
> ```bash
> RUN_REAL_E2E=1 PRIVATE_KEY=0x... DEST_ADDRESS=0x... npm test
> ```
>
> The payer approves **Permit2** for each source token itself (`ensureSourceApproval`), so there is no manual setup step — just make sure the wallet has gas on the source chain. Note this test settles **both directions** by default, so the wallet needs funds *and* an approval on Tempo as well — add `SKIP_REVERSE=1` to run the forward (Base → Tempo) leg only. It asserts an on-chain settlement and fails loudly if it detects the stub. For the full self-serve walkthrough (both protocols) and independent on-chain verification, see [Settlement proof](../docs/settlement-proof.md).
>
> **To settle a different corridor,** set `SOURCE_NETWORK` / `SOURCE_ASSET` / `DEST_NETWORK` / `DEST_ASSET` and each leg's source-chain RPC (`RPC_URL` forward, `REVERSE_RPC_URL` reverse) in your **shell**, not in `.env`. `.env` configures the merchant you start by hand with `npm run dev` (see [Going to testnet / mainnet](#going-to-testnet--mainnet)); this test suite does not read it, so a leftover `.env` cannot change what it settles. Each leg prints its corridor before funds move.
>
> **A slow corridor needs nothing special.** When settlement outruns the gateway's synchronous window (~30s), the facilitator reports the payment as still settling and the payer re-attempts the same purchase until it has a terminal outcome — so the funded run settles either way. See [Settlement outcomes](#settlement-outcomes).

## Settlement outcomes

Cross-chain settlement can take longer than the gateway holds a connection open (~30s). Rather than hanging on, the facilitator answers with the payment id and the state it is in. x402 models settlement as a boolean, so everything short of settled arrives as `success: false`; `errorReason` separates three cases:

| `errorReason` | What happened | What the payer should do |
|---|---|---|
| *(none — `success: true`)* | Settled | Nothing; the resource is served |
| `settlement_pending` | Accepted, still settling | **Re-attempt the same purchase** — it resolves onto this payment |
| `settlement_failed` | Terminal failure | **A new payment, under a new identifier** — this one can never settle |
| a gateway code | Refused; nothing charged | Fix the request and pay the same purchase again |

Pending and failed demand **opposite** actions, so never collapse them into one "payment failed": reading pending as failed abandons a payment that was about to succeed and invites a second charge; reading failed as pending strands the payer retrying a dead payment. A pending payment is not served — goods must not be released against an unfinished payment — and this merchant sets `PAYMENT-RESPONSE` on those responses too, since that is the payer's only channel for `errorReason` and the payment id.

To watch it locally with no funds, start the merchant with `STUB_PENDING_ATTEMPTS=2`:

```
→ 402: no payment credential, issuing challenge
→ 402: still settling (payment pay_stub_…) — awaiting the payer's re-attempt
→ 402: no payment credential, issuing challenge
→ 200: settled (stub — no funds moved) — payment pay_stub_…
```

## Idempotency: what this merchant has to do

**Naming the purchase: nothing.** The 402 declares x402's [`payment-identifier`](https://github.com/coinbase/x402/blob/main/specs/extensions/payment_identifier.md) extension as required and the payer names the purchase inside the payment, which this merchant forwards to `/settle` unchanged. Accepting x402 costs your API nothing — no new endpoint, parameter, or header. (To name the purchase yourself from an order id you already hold, add `id` to the declaration in `src/merchant.ts`; a payer may add to your declaration but never overwrite it.)

**Delivering once: your job.** An identifier stops you being *paid* twice, not *delivering* twice: if a payer reuses one across two purchases, the second resolves onto the first payment and the gateway replays its receipt, so a merchant keying delivery on the request ships again. Key it on the receipt's `payment_id` instead — [`src/payments.ts`](src/payments.ts) shows the shape, and in production it is the payments table you already keep for reconciliation. It also makes an honest retry safe: a payer that never received the `200` is served the same result.

## Going to testnet / mainnet

The shipped `.env.example` runs the stub. To settle for real against Atum's testnet facilitator, change two values in `.env`:

1. `USE_STUB_FACILITATOR=false` — switch from the stub to the real facilitator.
2. `DEST_ADDRESS=` — your receiving address on the destination chain (Tempo).

The active corridor is set in `.env.example` — **Base Sepolia USDC → Tempo pathUSD** by default. To reverse direction, comment that block and uncomment the alternative; it's the verified **Base ↔ Tempo** testnet corridor, copied from [Supported assets](https://docs.atum.xyz/get-started/reference/supported-assets) (EVM only, since this example signs with ethers + Permit2). The escrow, proxy, reserver, releaser, and verifier addresses are fetched from the gateway's `/defaults` automatically — you never paste them by hand (verified: `/defaults` returns exactly those addresses). Amount, markup, deadlines, and the facilitator/gateway URLs also have working testnet defaults (see the top of `src/merchant.ts`).

Two things to know when changing the corridor here:

- `FULFILLMENT_AMOUNT` is in **atomic units for a 6-decimal token** and does not rescale itself, so a destination asset with different decimals needs a new value.
- This `.env` corridor applies to the merchant you start with `npm run dev`. To repoint the **test suite**, export the same variables instead — see [Testing](#testing).

The payer funds the payment (source token + gas) — see [`x402-make-payments`](../x402-make-payments). On a successful real settlement the merchant logs the settlement transaction:

```
Merchant listening on http://localhost:4020
Facilitator: real https://x402-facilitator.production-testnet.atum.xyz · corridor from https://payment-gw.production-testnet.atum.xyz/defaults
→ 402: no payment credential, issuing challenge
→ 402: still settling (payment pay_…) — awaiting the payer's re-attempt
→ 402: no payment credential, issuing challenge
→ 200: settled — payment pay_…
    source deposit:     https://sepolia.basescan.org/tx/0x…
    destination payout: https://explore.testnet.tempo.xyz/tx/0x…
```

For **mainnet** (where authorized by Atum), the steps are identical — point `FACILITATOR_URL` / `GATEWAY_URL` at production and set the corridor to Atum-authorized mainnet chains and tokens.

## Project structure

```
src/
├── merchant.ts     # The x402 merchant — gate a route behind payment (stub or real)
├── payments.ts     # What has been delivered, keyed by payment — so nothing ships twice
└── smoke.test.ts   # End-to-end check: boots both apps together and verifies a payment succeeds
```

## Further reading

- [x402 Facilitator API reference](https://docs.atum.xyz/api-reference/x402/introduction)
- [x402 protocol](https://x402.org)
- [Atum documentation](https://docs.atum.xyz)
