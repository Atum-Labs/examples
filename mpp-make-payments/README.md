# mpp-make-payments

An example client that programmatically pays for an HTTP-gated resource over the [Machine Payments Protocol (MPP)](https://mpp.dev) using Atum's `atum-escrow` method.

The client handles the full payment flow automatically:

1. Requests the resource — receives a `402 Payment Required` with an `atum-escrow` challenge.
2. Reads the corridor terms from the challenge.
3. Signs a Permit2 authorization for the source token (no on-chain transaction — the escrow deposit executes only when the merchant settles).
4. Retries the request with the signed credential and returns the final `200` response.

## Resilience: safe retries

If the paid request fails or times out — for example, if the merchant restarts while your payment is settling — this client automatically retries, up to 3 times, using the **exact same signed credential** rather than a freshly-signed one.

This matters because a payment is only safe to retry this way: the Atum Payment Gateway recognizes an identical resubmission and returns the original result instead of settling twice, whereas a *newly signed* request would be a distinct, second payment. That's why this example builds the credential once (via `mppx.createCredential`) and reuses it across attempts, rather than relying on a single one-shot request.

## Pair with mpp-accept-payments

This example is designed to work alongside [`mpp-accept-payments`](../mpp-accept-payments), which runs the merchant server on `http://localhost:4030`. Run that first (its default stub submitter needs no funds), then run the client here.

## Prerequisites

- **Node.js 20+** — includes npm.
- **A funded testnet wallet** — only for a real (non-stub) settlement: the wallet must hold the source token and have approved the source escrow (Permit2). Not needed against the merchant's default stub submitter.

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

Edit `.env`:

| Variable | Required | Description |
|---|---|---|
| `PRIVATE_KEY` | Yes | 0x-prefixed 32-byte hex private key for the payer wallet. The source account is derived from it. |
| `MERCHANT_URL` | No | URL of the MPP-gated resource. Defaults to `http://localhost:4030/paid`. |
| `RPC_URL` | No | Source-chain RPC URL. When set, the client approves the source token (Permit2) before paying. Leave blank against the stub merchant. |

### 3. Run the client

```bash
npm run pay
```

Expected output when paired with the stub merchant:

```
Requesting http://localhost:4030/paid …
Status: 200
Payment-Receipt header: present
{
  "message": "Access granted.",
  "data": "Your premium content here."
}
```

## Testing

```bash
npm test
```

This verifies the retry behavior described above against a server that fails a couple of times before succeeding — no live merchant needed. To test this client together with a real `mpp-accept-payments` merchant instead, run `npm test` from [`../mpp-accept-payments`](../mpp-accept-payments) — that test drives both apps together.

## Going to testnet or mainnet

1. Point `MERCHANT_URL` at a merchant settling through a real Atum Payment Gateway.
2. Fund the payer wallet with the source token. Set `RPC_URL` and the client approves the source token (Permit2) for you before paying — via the `ensureSourceApproval` helper in `@atumlabs/mppx-atum-escrow/client` — so the escrow deposit does not revert at settlement.

## Project structure

```
src/
├── client.ts       # The mppx client — pay for a gated resource in one call
├── retry.ts        # Retry policy for the paid request (see "Resilience: safe retries" above)
└── retry.test.ts   # Verifies the retry policy against a server that fails then recovers
```

## Further reading

- [MPP](https://mpp.dev)
- [Atum documentation](https://docs.atumlabs.xyz)
