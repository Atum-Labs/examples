# x402-make-payments

An example x402 client that programmatically pays for an HTTP-gated resource using the [x402](https://x402.org) protocol and Atum's `atum-escrow` scheme.

The client handles the full payment flow automatically:

1. Requests the resource — receives a `402 Payment Required` response.
2. Reads the payment requirements from the `PAYMENT-REQUIRED` header.
3. Signs a Permit2 authorization for the source token.
4. Retries the request with the signed credential in a `PAYMENT-SIGNATURE` header.
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

> `@atumlabs/x402-atum-escrow` is published to npm under the `@atumlabs` scope, currently in **early access** (restricted). You'll need npm access granted to install it — [contact us](mailto:support@atumlabs.xyz) for access, then run `npm login` before `npm install`.

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
  "message": "Access granted.",
  "data": "Your premium content here."
}
```

## Going to testnet or mainnet

1. Point `MERCHANT_URL` at a real x402-gated resource.
2. Make sure your wallet holds the source token on the supported chain.
3. Run `approve(Permit2, type(uint160).max)` on the source token contract once (or set `RPC_URL` in `.env` — the client will tell you if your allowance is insufficient).
4. Replace `FACILITATOR_URL` in the merchant's `.env` with an Atum-provided URL.

## Optional: live corridor test (Base Sepolia → Tempo Moderato)

`npm run pay` prints the response but doesn't assert anything, so it passes even against the mock. `test:corridor` runs the same flow but **asserts** the payment settled **synchronously on the expected destination network against a real facilitator** — a pass/fail check you can wire into CI for a specific corridor.

It is opt-in because it moves real testnet funds. To run it end to end you need:

- A funded source wallet with an `approve(Permit2)` allowance on the source token (Base Sepolia USDC by default).
- A merchant pointed at a **real** Atum facilitator with `GATEWAY_URL` set (not the mock — the test fails loudly on a mock receipt so it can never give a false pass).

```bash
# In x402-accept-payments/.env: set FACILITATOR_URL + GATEWAY_URL to Atum testnet, then:
#   cd ../x402-accept-payments && npm run merchant

# Here, with PRIVATE_KEY, MERCHANT_URL, EXPECT_NETWORK, and RPC_URL set in .env:
npm run test:corridor
```

On success it prints the settlement network, transaction hash, and payer, and exits `0`. On any failure (wrong status, missing receipt, mock receipt, or settled on the wrong network) it exits non-zero.

| Variable | Required | Description |
|---|---|---|
| `PRIVATE_KEY` | Yes | Payer wallet key. |
| `MERCHANT_URL` | No | Gated resource. Defaults to `http://localhost:4020/paid`. |
| `EXPECT_NETWORK` | Yes | Destination CAIP-2 the receipt must report (e.g. `eip155:42431` for Tempo Moderato). |
| `RPC_URL` | No | Source-chain RPC; preflights the Permit2 allowance. |
