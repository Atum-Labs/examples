# mpp-make-payments

An example client that programmatically pays for an HTTP-gated resource over the [Machine Payments Protocol (MPP)](https://mpp.dev) using Atum's `atum-escrow` method.

The `mppx` client handles the whole flow in one `fetch` call:

1. Requests the resource — receives a `402 Payment Required` with an `atum-escrow` challenge.
2. Reads the corridor terms from the challenge.
3. Signs a Permit2 authorization for the source token (no on-chain transaction — the escrow deposit executes only when the merchant settles).
4. Retries the request with the signed credential and returns the final `200` response.

## Pair with mpp-accept-payments

This example is designed to run against [`mpp-accept-payments`](../mpp-accept-payments), which serves the merchant on `http://localhost:4030`. Start that first (its default stub submitter needs no funds), then run the client here.

## Prerequisites

- Node.js 20+ (includes npm)
- For a **real** (non-stub) settlement: a funded testnet wallet holding the source token, with the source escrow approved (Permit2). Not needed against the merchant's default stub submitter.

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

| Variable | Required | Description |
|---|---|---|
| `PRIVATE_KEY` | Yes | 0x-prefixed 32-byte hex key for the payer wallet. The source account is derived from it. |
| `RESOURCE_URL` | No | The MPP-gated resource. Defaults to `http://localhost:4030/paid-resource`. |

### 3. Run

```bash
npm run pay
```

Expected output when paired with the stub merchant:

```
Requesting http://localhost:4030/paid-resource …
Status: 200
Payment-Receipt header: present
{"message":"Access granted.","data":"Your premium content here."}
```

## Going to testnet

1. Point `RESOURCE_URL` at a merchant settling through a real Atum Payment Gateway.
2. Fund the payer wallet with the source token and approve the source escrow for it (Permit2). The `ensureSourceApproval` helper in `@atum-labs/mppx-atum-escrow/client` can do this for you.

## Further reading

- [MPP](https://mpp.dev)
- [Atum documentation](https://docs.atumlabs.xyz)
