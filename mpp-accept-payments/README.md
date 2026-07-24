# mpp-accept-payments

An example merchant server that accepts payments over the [Machine Payments Protocol (MPP)](https://mpp.dev) using Atum's `atum-escrow` payment method.

The merchant gates a route (`GET /paid`) behind payment. Unlike x402, MPP has **no separate facilitator**: the server verifies the payment credential in-process with the `mppx` SDK, then submits it to Atum for settlement through a `PaymentSubmitter`.

> **Proprietary reference example.** This is an Atum reference implementation provided to approved developers — not open-source software. The packages, gateway, chains, assets, and corridors it shows (e.g. Base Sepolia, Tempo, pathUSD) are illustrative; their availability and your access to them require separate Atum authorization and are **not** implied by their appearance here. Atum makes no promise of support, maintenance, compatibility, or production availability. Contact Atum for access.

## How it works

1. A client hits `GET /paid` without a payment credential.
2. `mppx` returns `402 Payment Required` with an `atum-escrow` challenge (the corridor terms) in a `WWW-Authenticate: Payment` header.
3. The client signs a payment credential and retries with an `Authorization: Payment` header.
4. `mppx` calls this method's `verify()` — it checks the signature and terms locally, then hands the request to your `PaymentSubmitter`.
5. The merchant returns `200 OK` with the protected resource and a `Payment-Receipt` header.

By default this example uses a **stub submitter** that returns a canned confirmation, so you can run the full flow locally without a gateway or funds. Point it at a real Atum Payment Gateway when you're ready to settle for real.

## Prerequisites

- Node.js 20+
- npm

## Quickstart

### 1. Install dependencies

```bash
npm install
```

> `@atumlabs/mppx-atum-escrow` is published to npm under the `@atumlabs` scope, currently in **early access** (restricted). You'll need npm access granted to install it — [contact us](mailto:support@atumlabs.xyz) for access, then run `npm login` before `npm install`.

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
MPP merchant listening on http://localhost:4030/paid
Submitter: stub (local, no funds)
```

Each request is logged with a short id (e.g. `[a1b2c3d4]`) so you can trace one request's lifecycle in the logs.

### 4. Try a payment

Drive a payment through it with the [`mpp-make-payments`](../mpp-make-payments) client — a `curl` can't easily produce the signed credential MPP expects. Start this server, then run `npm run pay` there; you should get a `200` with a `Payment-Receipt` header.

## Testing

```bash
npm test
```

This boots the merchant (in stub mode) and drives real payments against it using the `mpp-make-payments` client, then checks for a successful `200` response with a receipt. It also covers a few things worth knowing your setup handles correctly: concurrent payments from different wallets, the same wallet paying more than once, and the server refusing to start when it's misconfigured for real settlement.

> This test drives the `mpp-make-payments` client too, so make sure you've also run `npm install` in [`../mpp-make-payments`](../mpp-make-payments) before running it.

## Going to testnet / mainnet

The shipped `.env.example` is already wired for a live **testnet** corridor — it accepts **Base Sepolia USDC** and delivers **Tempo (Moderato) pathUSD**, settling through Atum's testnet gateway (`GATEWAY_URL=https://payment-gw.production-testnet.atum.xyz`). To settle for real instead of the stub, change three values in `.env`:

1. `USE_STUB_SUBMITTER=false` — switch from the canned stub to real settlement.
2. `MPP_SECRET_KEY=` — set a private one (`openssl rand -hex 32`). The default is a public placeholder and the server refuses to start with it once real settlement is enabled.
3. `DEST_ADDRESS=` — your receiving address on the destination chain (Tempo).

The corridor (`SOURCE_*` = Base Sepolia USDC, `DEST_*` = Tempo pathUSD), the amount (`FULFILLMENT_AMOUNT=50000`, i.e. `0.05`), and the markup/deadlines are already set — adjust them for a different corridor. The escrow, role, proxy, and verifier addresses are resolved from the gateway automatically via `corridorFromDefaults` — you don't configure them by hand.

The payer funds the payment (source token + Base Sepolia gas) — see the [`mpp-make-payments`](../mpp-make-payments) example. Once both are running, a successful real settlement logs the source (Base) and destination (Tempo) transaction links (your ids and hashes will differ):

```
MPP merchant listening on http://localhost:4030/paid
Submitter: real gateway https://payment-gw.production-testnet.atum.xyz
[9b590148] → 402: challenge issued
  settled payment 0xcd49e71041cf5834d7f7599ed31b0028a16d08363d04c202ebdbe3223f404752
    source deposit:     https://sepolia.basescan.org/tx/0x4b5e59c9ee03f64fa85bcbda5a20a6ba4c0626e59d19b0a079acafdb0af9ec34
    destination payout: https://explore.testnet.tempo.xyz/tx/0xf941a02fdc39dbff3a2a54aafa9f950fcd6301b28df32b845ca9ba9485408bf3
[8cb31437] → 200: settled, serving resource
```

For **mainnet** (where authorized by Atum), the steps are identical — point `GATEWAY_URL` at a production gateway and set `SOURCE_*`/`DEST_*` to Atum-authorized mainnet chains and tokens.

> With a real gateway, `verify()` holds the inbound request open until settlement completes (the Payment Gateway's synchronous window — a few seconds). Make sure your server/proxy read timeout and the client's request timeout both exceed it, or a successful payment may never be served.

## Project structure

```
src/
├── merchant.ts     # The mppx server — gate a route behind MPP payment
└── smoke.test.ts   # End-to-end check: boots both apps together and verifies a payment succeeds
```

## Further reading

- [MPP](https://mpp.dev)
- [Atum documentation](https://docs.atumlabs.xyz)
