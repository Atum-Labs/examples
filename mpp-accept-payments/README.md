# mpp-accept-payments

An example merchant server that accepts payments over the [Machine Payments Protocol (MPP)](https://mpp.dev) using Atum's `atum-escrow` payment method.

The server gates an HTTP route (`GET /paid-resource`) behind payment. Unlike x402, MPP has **no separate facilitator**: the server verifies the payment credential in-process with the `mppx` SDK, then submits it to Atum for settlement through a `PaymentSubmitter`.

## How it works

1. A client requests `GET /paid-resource` without a credential.
2. `mppx` returns `402 Payment Required` with an `atum-escrow` challenge (the corridor terms) in a `WWW-Authenticate: Payment` header.
3. The client builds and signs a payment and retries with an `Authorization: Payment` credential.
4. `mppx` calls this method's `verify()`, which checks the signature and terms locally, then hands the request to your `PaymentSubmitter`.
5. The server returns `200 OK` with the resource and a `Payment-Receipt` header.

By default this example uses a **stub submitter** that returns a canned confirmation, so you can run the full flow locally with no gateway and no funds. Point it at a real Atum Payment Gateway when you're ready to settle for real (see [Going to testnet](#going-to-testnet)).

## Prerequisites

- Node.js 20+ (includes npm)

> The `@atum-labs/mppx-atum-escrow` method package is served from GitHub Packages while it is in early access; the `.npmrc` in this directory points the `@atum-labs` scope there. It will move to the public npm registry (`@atumlabs/mppx-atum-escrow`) at release.

## Quickstart

### 1. Install dependencies

```bash
npm install
```

### 2. Configure

```bash
cp .env.example .env
```

The defaults run against the stub submitter — no changes needed to try the flow locally.

### 3. Run

```bash
npm run serve
```

You should see:

```
MPP merchant listening on http://localhost:4030/paid-resource
Submitter: stub (local, no funds)
```

Pair it with [`mpp-make-payments`](../mpp-make-payments) to drive a payment through it.

## Going to testnet

1. Set `USE_STUB_SUBMITTER=false` and `GATEWAY_URL` to an Atum-provided Payment Gateway.
2. Fill in the real corridor values (`DEST_*`, `SOURCE_*`, `ESCROW`, `RESERVER`, `RELEASER`, `FULFILLMENT_PROXY`, `VERIFIER_ENDPOINT`) — or replace the static corridor in `src/merchant.ts` with `corridorFromDefaults(gateway, {...})`, which fetches them for you.
3. The payer must hold the source token and have approved the source escrow (Permit2) — see the `mpp-make-payments` example.

## Project structure

```
src/
└── merchant.ts   # The mppx server — gate a route behind MPP payment
```

## Further reading

- [MPP](https://mpp.dev)
- [Atum documentation](https://docs.atumlabs.xyz)
