# x402-make-payments

An example x402 client that programmatically pays for an HTTP-gated resource using the [x402](https://x402.org) protocol and Atum's `atum-escrow` scheme.

The client handles the full payment flow automatically:

1. Requests the resource — receives a `402 Payment Required` response.
2. Reads the payment requirements from the `402` body.
3. Signs a Permit2 authorization for the source token.
4. Retries the request with the signed credential in `X-Payment`.
5. The merchant verifies and settles the payment, then returns the resource.

## Pair with x402-accept-payments

This example is designed to work alongside [`x402-accept-payments`](../x402-accept-payments), which runs the merchant server on `http://localhost:4020`. Run that first (including its mock facilitator), then run the client here.

## Prerequisites

- **Node.js 20+** — includes npm.
- **A funded testnet wallet** — the wallet address must hold the source token (e.g. USDC on Base Sepolia) and have approved Permit2 as a spender.

## Quickstart

### 1. Install dependencies

```bash
npm install
```

> The `@atum-x402` packages are published to GitHub Packages. The `.npmrc` in this directory already points `@atum-x402:registry` there — no token is needed for public packages.

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env`:

| Variable | Required | Description |
|---|---|---|
| `PRIVATE_KEY` | Yes | 0x-prefixed 32-byte hex private key for the payer wallet. |
| `MERCHANT_URL` | No | URL of the x402-gated resource. Defaults to `http://localhost:4020/paid`. |
| `RPC_URL` | No | Source-chain RPC URL. When set, preflights your Permit2 allowance before signing. |

### 3. Run the client

```bash
npm run pay
```

Expected output when paired with the mock merchant:

```
Requesting http://localhost:4020/paid …
Status: 200
{
  "message": "Payment received. Here is your resource.",
  "payer": "0x..."
}
```

## Going to testnet or mainnet

1. Point `MERCHANT_URL` at a real x402-gated resource.
2. Make sure your wallet holds the source token on the supported chain.
3. Run `approve(Permit2, type(uint160).max)` on the source token contract once (or set `RPC_URL` in `.env` — the client will tell you if your allowance is insufficient).
4. Replace `FACILITATOR_URL` in the merchant's `.env` with an Atum-provided URL.
