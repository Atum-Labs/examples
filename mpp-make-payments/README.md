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
| `RPC_URL` | No | Source-chain RPC URL (pre-set to Base Sepolia, `https://sepolia.base.org`). When set, the client approves the source token (Permit2) before paying; clear it against the stub merchant. |

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

The shipped `.env.example` is wired for the **Base Sepolia → Tempo** testnet corridor: `MERCHANT_URL=http://localhost:4030/paid` (the sibling merchant) and `RPC_URL=https://sepolia.base.org` (the Base Sepolia source chain) are already set. To pay for real:

1. `PRIVATE_KEY=` — the payer wallet's key.
2. Fund that wallet on **Base Sepolia**: the source token (**USDC**, ~`0.06` to cover the `0.05` charge plus the 3% markup cap) and a little **ETH** for the Permit2 approval's gas. With `RPC_URL` set, the client approves the source token (Permit2) for you before paying — via the `ensureSourceApproval` helper in `@atumlabs/mppx-atum-escrow/client` — so the escrow deposit does not revert at settlement.
3. Point `MERCHANT_URL` elsewhere only if the merchant isn't the local default.

On success the client prints — on the first run the approval line shows the Permit2 approval tx (below); on later runs, once the allowance is set, it reads `Source token already approved.`:

```
Requesting http://localhost:4030/paid …
Approved source token (tx 0x1d6f4c2824186d333c612308420d9c563002cf878e8b1649af4e19fc790f2376).
Status: 200
Payment-Receipt header: present
{
  "message": "Access granted.",
  "data": "Your premium content here."
}
```

Verify the movement on `sepolia.basescan.org` (USDC leaves the payer wallet) and `explore.testnet.tempo.xyz` (pathUSD arrives — import token `0x20c0000000000000000000000000000000000000`, 6 decimals). The merchant terminal also prints the source and destination transaction links.

For **mainnet**, the steps are identical with mainnet chains/tokens and a merchant settling through a production gateway.

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
