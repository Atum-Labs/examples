# mpp-accept-payments

An example merchant server that accepts payments over the [Machine Payments Protocol (MPP)](https://mpp.dev) using Atum's `atum-escrow` payment method.

The merchant gates a route (`GET /paid/<purchase id>`) behind payment. Unlike x402, MPP has **no separate facilitator**: the server verifies the payment credential in-process with the `mppx` SDK, then submits it to Atum for settlement through a `PaymentSubmitter`.

> Licensed under MIT — see the [root LICENSE](../LICENSE). The packages, gateway, chains, assets, and corridors shown here are the hosted testnet defaults. Atum makes no promise of support, maintenance, compatibility, or production availability.

## How it works

1. A client hits `GET /paid/<purchase id>` without a payment credential, naming the purchase it wants to pay for.
2. `mppx` returns `402 Payment Required` with an `atum-escrow` challenge — the corridor terms plus that purchase id — in a `WWW-Authenticate: Payment` header.
3. The client signs a payment credential and retries with an `Authorization: Payment` header.
4. `mppx` calls this method's `verify()` — it checks the signature and terms locally, then hands the request to your `PaymentSubmitter`.
5. The merchant returns `200 OK` with the protected resource and a `Payment-Receipt` header — or, if settlement is still in flight, a `402` telling the payer to re-attempt the same purchase.

By default this example uses a **stub submitter** that returns a canned confirmation, so you can run the full flow locally without a gateway or funds. Point it at a real Atum Payment Gateway when you're ready to settle for real.

## Prerequisites

- Node.js 20+ — on Node 20, installs may print `EBADENGINE` for some transitive deps that declare `engines.node >= 22`; install and stub runs still succeed. Node 22+ silences the warning.
- npm

## Quickstart

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

The defaults run against the stub submitter — no changes needed to try the flow locally.

### 3. Start the server

```bash
npm run dev
```

You should see:

```
MPP merchant listening on http://localhost:4030/paid/<purchase id>
Submitter: stub (local, no funds)
```

Each request is logged with a short id (e.g. `[a1b2c3d4]`) so you can trace one request's lifecycle in the logs.

### 4. Try a payment

Drive a payment through it with the sibling [`mpp-make-payments`](../mpp-make-payments) client (`npm run pay` after this merchant is up) — a `curl` can't easily produce the signed credential MPP expects. You should get a `200` with a `Payment-Receipt` header.

## Testing

```bash
npm test
```

This boots the merchant (in stub mode) and drives real payments against it using the `mpp-make-payments` client, then checks for a successful `200` response with a receipt. It also covers a few things worth knowing your setup handles correctly: concurrent payments from different wallets, the same wallet paying more than once, and the server refusing to start when it's misconfigured for real settlement.

> This test drives the `mpp-make-payments` client too, so make sure you've also run `npm install` in [`../mpp-make-payments`](../mpp-make-payments) before running it.

> The end-to-end test that settles against the live gateway is **opt-in** — it moves real testnet funds. Run it with a funded Base Sepolia wallet and a Tempo receiving address:
>
> ```bash
> RUN_REAL_E2E=1 PRIVATE_KEY=0x... DEST_ADDRESS=0x... npm test
> ```
>
> It asserts a real on-chain Base → Tempo settlement (a hex payment id plus source-deposit and destination-payout tx links) and fails if it detects the stub, so it can never give a false pass. A fresh `MPP_SECRET_KEY` is generated per run; optional overrides: `GATEWAY_URL`, `FULFILLMENT_DEADLINE_SECONDS`, and each leg's source-chain RPC (`RPC_URL`, defaults to Base Sepolia; `REVERSE_RPC_URL`, defaults to Tempo Moderato). When settlement outruns the gateway's synchronous window the merchant answers "still settling" and the payer re-attempts the same purchase, so a slow corridor still resolves to a confirmed result. For the full walkthrough and independent on-chain verification, see [Settlement proof](../docs/settlement-proof.md).
>
> **To settle a different corridor,** set `SOURCE_NETWORK` / `SOURCE_ASSET` / `DEST_NETWORK` / `DEST_ASSET` and the RPCs above in your **shell**, not in `.env`. `.env` configures the merchant you start by hand with `npm run dev` (see [Going to testnet / mainnet](#going-to-testnet--mainnet)); this test suite does not read it, so a leftover `.env` cannot change what it settles. Each leg prints its corridor before funds move.

## Settlement outcomes

Cross-chain settlement can take longer than the gateway holds a connection open (~30s). The submitter this example provides **submits and returns what the gateway said — it does not poll for completion.** Polling would hold the payer's own HTTP request open for the whole settlement window (the classic proxy timeout) and would hide the pending state that makes the payer's re-attempt safe. Passing the gateway's `status` through is what lets `verify()` tell these three apart:

| `verify()` outcome | What happened | What the payer should do |
|---|---|---|
| a receipt | Settled | Nothing; the resource is served |
| `SettlementPendingError` | Accepted, still settling | **Re-attempt the same purchase** — it resolves onto this payment |
| `SettlementFailedError` | Terminal failure | **A new payment, under a new purchase id** — this one can never settle |
| `PaymentRejectedError` | Refused; nothing charged | Fix the request and pay the same purchase again |

Pending and failed demand **opposite** actions, so never collapse them into one "payment failed": reading pending as failed abandons a payment that was about to succeed and invites a second charge; reading failed as pending strands the payer retrying a dead payment. Both reach the payer as a `402` with problem details, distinguished by `type`, and both carry the gateway's `paymentId` as its own field for reconciliation.

To watch it locally with no funds, start the merchant with `STUB_PENDING_ATTEMPTS=2`:

```
[95da714b] → 402: challenge issued (purchase order_986d…)
  payment pay_stub_… accepted, still settling — the payer's re-attempt at this purchase will collect the outcome
[0d71b1b5] → 402: not settled (purchase order_986d…) — see the payment line above
…
[cafeffc7] → 200: settled, serving purchase order_986d…
```

## Idempotency: what this merchant has to do

**Naming the purchase: point `intentId` at a value your route already has.** MPP needs a per-purchase identifier in the `402` challenge — the payer derives the payment's identity from it and refuses to sign a challenge without one. The merchant must therefore know which purchase a request is for *before* any payment exists, and the request is all it has to go on. This example puts it in the path (`GET /paid/<purchase id>`), the way real merchant routes already carry it:

```ts
// /invoices/4711/pdf, /orders/4711/download, /jobs/abc123/result — use what you have
buildChargeChallenge(corridor, source, FULFILLMENT_AMOUNT, { intentId: purchaseId });
```

A request that names no purchase is refused with a `400` rather than served a challenge the payer would reject anyway.

**Delivering once: your job.** A purchase identifier stops you being *paid* twice, not *delivering* twice: if a payer reuses one across two purchases, the second resolves onto the first payment and the gateway replays its receipt, so a merchant keying delivery on the request ships again. Key it on the receipt's `payment_id` instead — [`src/payments.ts`](src/payments.ts) shows the shape, and in production it is the payments table you already keep for reconciliation. It also makes an honest retry safe: a payer that never received the `200` is served the same result.

## Going to testnet / mainnet

The shipped `.env.example` is already wired for a live **testnet** corridor — it accepts **Base Sepolia USDC** and delivers **Tempo (Moderato) pathUSD**, settling through Atum's testnet gateway (`GATEWAY_URL=https://payment-gw.production-testnet.atum.xyz`). To settle for real instead of the stub, change three values in `.env`:

1. `USE_STUB_SUBMITTER=false` — switch from the canned stub to real settlement.
2. `MPP_SECRET_KEY=` — set a private one (`openssl rand -hex 32`). The default is a public placeholder and the server refuses to start with it once real settlement is enabled.
3. `DEST_ADDRESS=` — your receiving address on the destination chain (Tempo).

The corridor (`SOURCE_*` = Base Sepolia USDC, `DEST_*` = Tempo pathUSD), the amount (`FULFILLMENT_AMOUNT=50000`, i.e. `0.05`), and the markup/deadlines are already set — adjust them for a different corridor. The escrow, role, proxy, and verifier addresses are resolved from the gateway automatically via `corridorFromDefaults` — you don't configure them by hand.

Two things to know when changing the corridor here:

- `FULFILLMENT_AMOUNT` is in **atomic units for a 6-decimal token** and does not rescale itself, so a destination asset with different decimals needs a new value.
- This `.env` corridor applies to the merchant you start with `npm run dev`. To repoint the **test suite**, export the same variables instead — see [Testing](#testing).

The payer funds the payment (source token + Base Sepolia gas) — see the [`mpp-make-payments`](../mpp-make-payments) example. Once both are running, a successful real settlement logs the source (Base) and destination (Tempo) transaction links (your ids and hashes will differ):

```
MPP merchant listening on http://localhost:4030/paid/<purchase id>
Submitter: real gateway https://payment-gw.production-testnet.atum.xyz
[9b590148] → 402: challenge issued
  settled payment 0xcd49e71041cf5834d7f7599ed31b0028a16d08363d04c202ebdbe3223f404752
    source deposit:     https://sepolia.basescan.org/tx/0x4b5e59c9ee03f64fa85bcbda5a20a6ba4c0626e59d19b0a079acafdb0af9ec34
    destination payout: https://explore.testnet.tempo.xyz/tx/0xf941a02fdc39dbff3a2a54aafa9f950fcd6301b28df32b845ca9ba9485408bf3
[8cb31437] → 200: settled, serving resource
```

For **mainnet** (where authorized by Atum), the steps are identical — point `GATEWAY_URL` at a production gateway and set `SOURCE_*`/`DEST_*` to Atum-authorized mainnet chains and tokens.

> With a real gateway, `verify()` holds the inbound request while the gateway waits for settlement — up to its synchronous window (~30s), never longer. Make sure your server/proxy read timeout and the client's request timeout exceed that. Past the window the merchant answers "still settling" instead of holding on, which is what keeps the request bounded; the payer's re-attempt collects the outcome.

## Project structure

```
src/
├── merchant.ts     # The mppx server — gate a route behind MPP payment
├── payments.ts     # What has been delivered, keyed by payment — so nothing ships twice
└── smoke.test.ts   # End-to-end check: boots both apps together and verifies a payment succeeds
```

## Further reading

- [MPP](https://mpp.dev)
- [Atum documentation](https://docs.atum.xyz)
