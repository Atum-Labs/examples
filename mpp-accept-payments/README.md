# mpp-accept-payments

An example merchant server that accepts payments over the [Machine Payments Protocol (MPP)](https://mpp.dev) using Atum's `atum-escrow` payment method.

The merchant gates a route (`GET /paid`) behind payment. Unlike x402, MPP has **no separate facilitator**: the server verifies the payment credential in-process with the `mppx` SDK, then submits it to Atum for settlement through a `PaymentSubmitter`.

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

### 4. Try a payment

Drive a payment through it with the [`mpp-make-payments`](../mpp-make-payments) client — a `curl` can't easily produce the signed credential MPP expects. Start this server, then run `npm run pay` there; you should get a `200` with a `Payment-Receipt` header.

## Going to testnet / mainnet

1. Set `USE_STUB_SUBMITTER=false` and `GATEWAY_URL` to an Atum-provided Payment Gateway.
2. Set your `DEST_*` and `SOURCE_*` (chains, tokens, receive address). The escrow, role, proxy, and verifier addresses are resolved from the gateway automatically via `corridorFromDefaults` — you don't configure them by hand.
3. The payer must hold the source token and have approved the source escrow (Permit2) — see the `mpp-make-payments` example.

> With a real gateway, `verify()` holds the inbound request open until settlement completes (the Payment Gateway's synchronous window — a few seconds). Make sure your server/proxy read timeout and the client's request timeout both exceed it, or a successful payment may never be served.

## Project structure

```
src/
└── merchant.ts   # The mppx server — gate a route behind MPP payment
```

## Further reading

- [MPP](https://mpp.dev)
- [Atum documentation](https://docs.atumlabs.xyz)
