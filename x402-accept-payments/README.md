# x402-accept-payments

An example merchant server that accepts cross-chain payments using the [x402](https://x402.org) protocol and the Atum `atum-escrow` scheme.

The merchant gates a route behind payment: unauthenticated requests receive an HTTP 402 with the payment options you accept; requests with a valid payment credential are verified and settled through the Atum facilitator before the protected content is returned.

The protocol work is done by the Atum package — `paymentMiddleware` gates the route, `registerAtumEscrowScheme` builds the `402`, and `HTTPFacilitatorClient` delegates verify/settle. You never hand-build a `402` or call `/verify` / `/settle` yourself.

## How it works

1. A client hits `GET /paid` without a payment credential.
2. `paymentMiddleware` returns `402 Payment Required` with the accepted payment options.
3. The client signs a payment credential and retries with it.
4. The middleware verifies the credential with the facilitator (no funds moved), then settles it (funds move on-chain).
5. The route handler runs and returns `200 OK` with the protected resource and a `PAYMENT-RESPONSE` header carrying the settlement receipt.

Corridor contract addresses (escrow, fulfillment proxy, verifier, roles) are Atum-network facts, so the merchant reads them from the payment gateway's `/defaults` at startup rather than hardcoding them.

## Prerequisites

- Node.js 20+
- npm
- Access to the `@atumlabs/x402-atum-escrow` package (early access — see below)

## Quickstart

### 1. Install dependencies

```bash
npm install
```

> `@atumlabs/x402-atum-escrow` is published under the `@atumlabs` scope, currently in **early access** (restricted). You'll need npm access granted to install it — [contact us](mailto:support@atumlabs.xyz), then run `npm login` before `npm install`.

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env` and set `DEST_ADDRESS` to the address you want to receive on. The corridor defaults to **Base Sepolia USDC → Tempo Moderato pathUSD**. Leave `GATEWAY_URL` unset for local mock mode.

### 3. Start everything

```bash
npm run dev
```

This starts the mock facilitator and the merchant server together in one terminal.

> The mock facilitator always approves payments without touching any blockchain — it's a local stand-in for Atum's hosted facilitator, not a replacement for the package (the merchant uses `@atumlabs/x402-atum-escrow/server` either way). Set `GATEWAY_URL` and point `FACILITATOR_URL` at an Atum facilitator when you're ready for real settlement.

### 4. Test it

Without payment (expect `402`):

```bash
curl -i http://localhost:4020/paid
```

With a real payment credential, drive it from the sibling [`x402-make-payments`](../x402-make-payments) client:

```bash
cd ../x402-make-payments && npm run pay
```

## Going to testnet / mainnet

1. Get your facilitator URL and gateway URL from Atum.
2. Set `FACILITATOR_URL` and `GATEWAY_URL` in `.env` (contract addresses are read from `${GATEWAY_URL}/defaults`).
3. Run `npm run merchant` — no code changes needed.

## Project structure

```
src/
├── merchant.ts          # The merchant server — gate a route behind x402 payment
└── mock-facilitator.ts  # Local-only stand-in for the hosted Atum facilitator
```

## Further reading

- [x402 Facilitator API reference](https://docs.atumlabs.xyz/api-reference/x402/introduction)
- [x402 protocol](https://x402.org)
