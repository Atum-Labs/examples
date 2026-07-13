# x402-accept-payments

An example merchant server that accepts cross-chain payments using the [x402](https://x402.org) protocol and the Atum `atum-escrow` scheme.

The merchant gates a route behind payment: unauthenticated requests receive an HTTP 402 with the payment options you accept; requests with a valid payment credential are verified and settled through the Atum facilitator before the protected content is returned.

## How it works

1. A client hits `GET /paid` without a payment credential.
2. The merchant returns `402 Payment Required` with its accepted payment options.
3. The client signs a payment credential and retries with an `X-Payment` header.
4. The merchant calls `/verify` on the facilitator — validates the credential without moving funds.
5. The merchant calls `/settle` — funds are moved on-chain.
6. The merchant returns `200 OK` with the protected resource and a `X-Payment-Response` header.

## Prerequisites

- Node.js 20+
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

Edit `.env` and fill in your corridor config (`DEST_ADDRESS`, `ESCROW_CONTRACT`, etc.). Contact Atum to get contract addresses for your corridor.

### 3. Start everything

```bash
npm run dev
```

This starts the mock facilitator and the merchant server together in one terminal.

> The mock facilitator always approves payments without touching any blockchain. Replace `FACILITATOR_URL` in `.env` with an Atum-provided URL when you're ready to test against testnet or mainnet.

### 4. Test it

Without payment (expect 402):

```bash
curl -i http://localhost:4020/paid
```

With a mock payment credential:

```bash
# Base64-encode a minimal payment payload
PAYMENT=$(echo '{"x402Version":2,"accepted":{"scheme":"atum-escrow"},"payload":{"paymentRequest":{}}}' | base64)

curl -i http://localhost:4020/paid \
  -H "X-Payment: $PAYMENT"
```

## Going to testnet / mainnet

1. Get your facilitator URL and contract addresses from Atum.
2. Update `FACILITATOR_URL`, `ESCROW_CONTRACT`, `FULFILLMENT_PROXY`, `RESERVER`, `RELEASER`, and `VERIFIER_ENDPOINT` in `.env`.
3. Run `npm run merchant` — no other changes needed.

## Project structure

```
src/
├── merchant.ts          # The merchant server — gate a route behind x402 payment
└── mock-facilitator.ts  # Local-only mock facilitator for development
```

## Further reading

- [x402 Facilitator API reference](https://docs.atumlabs.xyz/api-reference/x402/introduction)
- [x402 protocol](https://x402.org)
