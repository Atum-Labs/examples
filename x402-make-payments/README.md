# x402-make-payments

An example x402 client that programmatically pays for an HTTP-gated resource using the [x402](https://x402.org) protocol and Atum's `atum-escrow` scheme.

The client handles the full payment flow automatically:

1. Requests the resource — receives a `402 Payment Required` response.
2. Reads the payment requirements from the `PAYMENT-REQUIRED` header.
3. Signs a Permit2 authorization for the source token (no on-chain transaction — the escrow deposit executes only when the merchant settles).
4. Retries the request with the signed credential in a `PAYMENT-SIGNATURE` header and returns the final `200` response.

> **Proprietary reference example.** This is an Atum reference implementation provided to approved developers — not open-source software. The packages, facilitator, gateway, chains, assets, and corridors it shows (e.g. Base Sepolia, Tempo, pathUSD) are illustrative; their availability and your access to them require separate Atum authorization and are **not** implied by their appearance here. Atum makes no promise of support, maintenance, compatibility, or production availability. Contact Atum for access.

## Pair with x402-accept-payments

This example is designed to work alongside [`x402-accept-payments`](../x402-accept-payments), which runs the merchant server on `http://localhost:4020`. Run that first (its default stub needs no funds), then run the client here.

## Prerequisites

- **Node.js 20+** — includes npm.
- **A funded testnet wallet** — only for a real (non-stub) settlement: the wallet must hold the source token and have approved Permit2 as a spender. Not needed against the merchant's default stub.
- **An npm account granted `@atumlabs` access** — required to install the escrow package; [contact us](mailto:support@atumlabs.xyz) for access.

## Quickstart

### 1. Install dependencies

```bash
npm login    # an account granted @atumlabs access
npm install
```

> `@atumlabs/x402-atum-escrow` is published to npm under the `@atumlabs` scope, currently in **early access** (restricted). Without `npm login` first, the install fails with a `403`/`404` on that package.

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env`:

| Variable | Required | Description |
|---|---|---|
| `PRIVATE_KEY` | Yes | 0x-prefixed 32-byte hex private key for the payer wallet. The source account is derived from it. |
| `RPC_URL` | No | Source-chain RPC URL (Base Sepolia). When set, the client preflights your Permit2 allowance before signing. Leave blank against the stub merchant. |
| `MERCHANT_URL` | No | URL of the x402-gated resource. Defaults to `http://localhost:4020/paid`. |

### 3. Run the client

```bash
npm run pay
```

Expected output when paired with the stub merchant:

```
Requesting http://localhost:4020/paid …
Status: 200
{
  "message": "Access granted.",
  "data": "Your premium content here."
}
```

## Testing

This client is exercised end-to-end by the smoke test in [`../x402-accept-payments`](../x402-accept-payments), which boots both apps together and drives real payments through them. Run `npm test` there (after `npm install` in both apps) — see that example's README for details.

## Going to testnet or mainnet

> **⚠ Cross-chain settlement can be slower than x402 can confirm.** x402 settles **synchronously**: if cross-chain settlement outruns the facilitator's ~30s window (common on slow corridors like **Base ↔ Tempo**), the client prints a `402` with `"the async tail is not supported in v1"` and a "settlement pending" warning. That is **not** a confirmed failure — the payment was submitted and may still complete. Verify on-chain before retrying (a fresh retry is a *second* payment). Prefer fast corridors for a synchronous demo.

The shipped `.env.example` is wired for the **Base Sepolia → Tempo** testnet corridor — the merchant's default. To pay a real (non-stub) merchant:

1. `PRIVATE_KEY=` — the payer wallet's key.
2. Fund that wallet on **Base Sepolia**: the source token (**USDC**, ~`0.06` to cover the `0.05` charge plus the 3% markup cap) and a little **ETH** for gas.
3. Approve **Permit2** as a spender on the source token once (`approve(Permit2, type(uint160).max)`), so the escrow deposit does not revert at settlement.
4. Set `RPC_URL=https://sepolia.base.org` so the client preflights that allowance before signing — it aborts with a clear message if the approval is missing, instead of reverting on-chain at settle.

Make sure the paired merchant is running in real mode (`USE_STUB_FACILITATOR=false`, see [`x402-accept-payments`](../x402-accept-payments)).

On success the client prints the `200` and resource body; the merchant terminal prints the settlement transaction. Verify the movement on `sepolia.basescan.org` (USDC leaves the payer wallet) and `explore.testnet.tempo.xyz` (pathUSD arrives — import token `0x20c0000000000000000000000000000000000000`, 6 decimals).

For **mainnet** (where authorized by Atum), the steps are identical with Atum-authorized mainnet chains/tokens and a merchant settling through a production facilitator.

## Project structure

```
src/
└── client.ts       # The x402 client — pay for a gated resource in one call
```

## Further reading

- [x402 Facilitator API reference](https://docs.atumlabs.xyz/api-reference/x402/introduction)
- [x402 protocol](https://x402.org)
- [Atum documentation](https://docs.atumlabs.xyz)
