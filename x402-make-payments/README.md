# x402-make-payments

An example x402 client that programmatically pays for an HTTP-gated resource using the [x402](https://x402.org) protocol and Atum's `atum-escrow` scheme.

> **Proprietary reference example.** This is an Atum reference implementation provided to approved developers — not open-source software. The packages, facilitator, gateway, chains, assets, and corridors it shows (e.g. Base Sepolia, Tempo, pathUSD) are illustrative; their availability and your access to them require separate Atum authorization and are **not** implied by their appearance here. Atum makes no promise of support, maintenance, compatibility, or production availability. Contact Atum for access.

## How it works

The client handles the full payment flow automatically:

1. Requests the resource — receives a `402 Payment Required` response.
2. Reads the payment requirements from the `PAYMENT-REQUIRED` header.
3. Signs a Permit2 authorization for the source token — signing itself costs nothing on-chain, and the escrow deposit executes only when the merchant settles. (Against a real merchant the client also sends a one-off `approve(Permit2)` transaction if your allowance is short — see [Going to testnet / mainnet](#going-to-testnet--mainnet).)
4. Retries the request with the signed credential in a `PAYMENT-SIGNATURE` header.
5. If settlement outruns the gateway's synchronous window, re-attempts the **same purchase** until it reaches a terminal outcome — see [Retries and idempotency](#retries-and-idempotency).

## Retries and idempotency

Cross-chain settlement can take longer than the gateway holds a connection open (~30s). Rather than hanging on — which is what runs into proxy timeouts — the facilitator reports the payment as still settling, and **re-attempting the same purchase collects the result.** The gateway resolves the re-attempt onto the same payment, so it costs nothing and cannot charge twice. [`src/purchase.ts`](src/purchase.ts) does this:

```
  attempt 1/20 …
  still settling (payment pay_…) — 31s elapsed, re-attempting in 5s
  attempt 2/20 …
  settled after 2 attempt(s) in 37s — payment pay_…
Status: 200
```

Only the first attempt is slow — it creates the payment; re-attempts return immediately, so the interval paces the wait. Each attempt re-signs from a fresh `402`, since `quote_deadline` is an absolute timestamp and a signed payment goes stale within seconds. What makes them one payment is the **purchase identifier**, carried in x402's [`payment-identifier`](https://github.com/coinbase/x402/blob/main/specs/extensions/payment_identifier.md) extension:

```ts
const pay = wrapFetchWithAtumPayment(fetch, client);
await pay(MERCHANT_URL, {}, { paymentIdentifier: purchaseId });
```

Omit it and the client **refuses to sign** — there is no generated fallback, because one would look like an idempotency key while letting every re-attempt double-charge. The merchant only declares that an identifier is required and never sees the value, so accepting x402 costs its API nothing.

### It names a payment, not an order

A payment that fails terminally spends its identifier for good, so an order that outlives a failed payment needs a new one for the next attempt:

```
order books-123 → payment 1 (books-123-1) → FAILED   ← that identifier is now dead
                → payment 2 (books-123-2) → settles  ← the order is paid
```

So derive it from both — your order id plus a counter you bump for each new payment attempt at that order: `` `${order.id}-${order.paymentAttempts}` ``. Reuse it on every attempt at one payment; never across two purchases — the second would resolve onto the first payment, so the buyer gets the goods twice and the merchant is paid once. Nothing can detect that, which is why the merchant keys fulfilment on the receipt's `payment_id` (see [`x402-accept-payments`](../x402-accept-payments)).

This example pays for one purchase per run, so it generates an identifier per run and prints it. Pass `PURCHASE_ID` **only** to resume a payment interrupted while still settling — never set it in `.env`, or every run would re-attempt the same payment and later runs would be served without paying.

## Pair with x402-accept-payments

This example is designed to work alongside [`x402-accept-payments`](../x402-accept-payments), which runs the merchant server on `http://localhost:4020`. Run that first (its default stub needs no funds), then run the client here.

## Prerequisites

- **Node.js 20+** — includes npm.
- **A funded testnet wallet** — only for a real (non-stub) settlement: it needs the source token plus a little gas on the source chain. The client grants the Permit2 approval itself, so there is no manual approval step. Not needed against the merchant's default stub.

## Quickstart

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env`. **Stub mode needs a valid `PRIVATE_KEY` but no funds** — any throwaway key works. Generate one after install:

```bash
node -e "console.log(require('ethers').Wallet.createRandom().privateKey)"
# or: cast wallet new
```

| Variable | Required | Description |
|---|---|---|
| `PRIVATE_KEY` | Yes | 0x-prefixed 32-byte hex private key for the payer wallet. The source account is derived from it. Stub: any valid key / no funds. Real settlement: a funded testnet key. |
| `RPC_URL` | No | Source-chain RPC URL (Base Sepolia). When set, the client approves the source token (Permit2) before signing, so the escrow deposit does not revert at settlement. Leave blank against the stub merchant. |
| `MERCHANT_URL` | No | URL of the x402-gated resource. Defaults to `http://localhost:4020/paid`. |

> `PURCHASE_ID` is **not** a `.env` value — the client generates one per run and prints it. Pass it on the command line only, to resume an interrupted payment. See [Retries and idempotency](#retries-and-idempotency).

> **Switching wallets or environments?** If you previously exported `PRIVATE_KEY` in your shell (e.g. `export PRIVATE_KEY=0x…`), that value takes precedence over `.env` — `dotenv` does not replace variables already set in your environment. After editing `.env` you may silently keep signing with the old key. Run `unset PRIVATE_KEY` so the value from `.env` is used, then re-run the client.

### 3. Run the client

```bash
npm run pay
```

Expected output when paired with the stub merchant:

```
Requesting http://localhost:4020/paid …
Purchase order_f45bb75a9adc49258f64 — to re-attempt it: PURCHASE_ID=order_f45bb75a9adc49258f64 npm run pay
  attempt 1/20 …
  settled after 1 attempt(s) in 0s — payment pay_stub_…
Status: 200
{
  "message": "Access granted.",
  "data": "Your premium content here."
}
```

To watch the re-attempt loop that resolves a slow settlement, start the merchant with `STUB_PENDING_ATTEMPTS=2` (see [`x402-accept-payments`](../x402-accept-payments)) — no funds, no gateway.

## Testing

This client is exercised end-to-end by the smoke test in [`../x402-accept-payments`](../x402-accept-payments), which boots both apps together and drives real payments through them. Run `npm test` there (after `npm install` in both apps) — see that example's README for details.

## Going to testnet / mainnet

> **Cross-chain settlement can outrun the gateway's synchronous window (~30s)**, and on corridors like **Base ↔ Tempo** it often does. That is not a failure and needs nothing from you: the facilitator reports the payment as still settling, and the client re-attempts the same purchase until it has a terminal outcome. See [Retries and idempotency](#retries-and-idempotency).

The shipped `.env.example` is wired for the **Base Sepolia → Tempo** testnet corridor — the merchant's default. To pay a real (non-stub) merchant:

1. `PRIVATE_KEY=` — the payer wallet's key.
2. Fund that wallet on **Base Sepolia**: the source token (**USDC**, ~`0.06` to cover the `0.05` charge plus the 3% markup cap) and a little **ETH** for gas. For the reverse leg, also fund it on **Tempo** with `pathUSD` — that covers both the payment and gas, since Tempo has no native gas token (see the root README's `cast rpc tempo_fundAddress` faucet command).
3. Set `RPC_URL=https://sepolia.base.org` (or the source chain you are paying from). The client then approves **Permit2** for you before signing, via `ensureSourceApproval` — the escrow pulls your funds through Permit2, so the approval has to exist or the deposit reverts at settlement. It reads the current allowance first and only sends a transaction when it falls short, so it is a no-op on later runs.

   Worth getting right up front: a deposit that reverts on-chain is a *terminal* settlement failure, and a terminal failure spends that purchase identifier for good.

Make sure the paired merchant is running in real mode (`USE_STUB_FACILITATOR=false`, see [`x402-accept-payments`](../x402-accept-payments)).

On success the client prints the `200` and resource body; the merchant terminal prints the settlement transaction. Verify the movement on `sepolia.basescan.org` (USDC leaves the payer wallet) and `explore.testnet.tempo.xyz` (pathUSD arrives — import token `0x20c0000000000000000000000000000000000000`, 6 decimals).

For **mainnet** (where authorized by Atum), the steps are identical with Atum-authorized mainnet chains/tokens and a merchant settling through a production facilitator.

## Project structure

```
src/
├── client.ts       # The x402 client — names the purchase and pays for the resource
└── purchase.ts     # Re-attempts the purchase until settlement reaches a terminal outcome
```

## Further reading

- [x402 Facilitator API reference](https://docs.atum.xyz/api-reference/x402/introduction)
- [x402 protocol](https://x402.org)
- [Atum documentation](https://docs.atum.xyz)
