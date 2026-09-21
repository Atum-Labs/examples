# mpp-make-payments

An example client that programmatically pays for an HTTP-gated resource over the [Machine Payments Protocol (MPP)](https://mpp.dev) using Atum's `atum-escrow` method.

> Licensed under MIT — see the [root LICENSE](../LICENSE). The packages, gateway, chains, assets, and corridors shown here are the hosted testnet defaults. Atum makes no promise of support, maintenance, compatibility, or production availability.

## How it works

The client handles the full payment flow automatically:

1. Requests the resource — receives a `402 Payment Required` with an `atum-escrow` challenge.
2. Reads the corridor terms from the challenge.
3. Signs a Permit2 authorization for the source token — signing itself costs nothing on-chain, and the escrow deposit executes only when the merchant settles. (Against a real merchant the client also sends a one-off `approve(Permit2)` transaction if your allowance is short — see [Going to testnet / mainnet](#going-to-testnet--mainnet).)
4. Retries the request with the signed credential.
5. If settlement outruns the gateway's synchronous window, re-attempts the **same purchase** until it reaches a terminal outcome — see [Retries and idempotency](#retries-and-idempotency).

## Retries and idempotency

Cross-chain settlement can take longer than the gateway holds a connection open (~30s). Rather than the merchant hanging on — which is what runs into proxy timeouts — `verify()` reports the payment as still settling, and **re-attempting the same purchase collects the result.** The gateway resolves the re-attempt onto the same payment, so it costs nothing and cannot charge twice. [`src/purchase.ts`](src/purchase.ts) does this:

```
  attempt 1/20 …
  still settling (payment pay_…) — 31s elapsed, re-attempting in 5s
  attempt 2/20 …
  settled after 2 attempt(s) in 37s
Status: 200
```

Only the first attempt is slow — it creates the payment; re-attempts return immediately, so the interval paces the wait. Each attempt fetches a fresh `402` and signs a **new** credential: `quote_deadline` is an absolute timestamp, so a signed credential goes stale within seconds and `verify()` refuses it. What makes the attempts one payment is the **purchase identifier**. MPP gives the payer no channel to carry it, so the merchant needs it *before* it can build the challenge — this client therefore puts it in the URL, and the merchant stamps it into the challenge from there:

```
GET /paid/order_9f3c2a1b7d4e5c6a8b0f
```

### It names a payment, not an order

A payment that fails terminally spends its identifier for good, so an order that outlives a failed payment needs a new one for the next attempt:

```
order books-123 → payment 1 (books-123-1) → FAILED   ← that identifier is now dead
                → payment 2 (books-123-2) → settles  ← the order is paid
```

So derive it from both — your order id plus a counter you bump for each new payment attempt at that order: `` `${order.id}-${order.paymentAttempts}` ``. Reuse it on every attempt at one payment; never across two purchases — the second would resolve onto the first payment, so the buyer gets the goods twice and the merchant is paid once. Nothing can detect that, which is why the merchant keys fulfilment on the receipt's `payment_id` (see [`mpp-accept-payments`](../mpp-accept-payments)).

This example pays for one purchase per run, so it generates an identifier per run and prints it. Pass `PURCHASE_ID` **only** to resume a payment interrupted while still settling — never set it in `.env`, or every run would re-attempt the same payment and later runs would be served without paying.

## Pair with mpp-accept-payments

This example is designed to work alongside [`mpp-accept-payments`](../mpp-accept-payments), which runs the merchant server on `http://localhost:4030`. Run that first (its default stub submitter needs no funds), then run the client here.

## Prerequisites

- **Node.js 20+** — includes npm. On Node 20 the install prints `EBADENGINE` for a couple of transitive deps that declare `engines.node >= 22`; install and stub runs still succeed, and Node 22+ silences it.
- **A funded testnet wallet** — only for a real (non-stub) settlement: it needs the source token plus a little gas on the source chain. The client grants the Permit2 approval itself, so there is no manual approval step. Not needed against the merchant's default stub submitter.

## Quickstart

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

**A stub run needs no `.env` at all** — skip to `npm run pay`. The payment is signed offline and never touches a chain, so with `PRIVATE_KEY` unset the client generates a throwaway key for the run and prints its address. Copy `.env.example` when you move to real settlement:

| Variable | Required | Description |
|---|---|---|
| `PRIVATE_KEY` | For real settlement | `export PRIVATE_KEY=0x…` in the shell, **or** uncomment it in `.env`. Shell wins if both are set. Leave it unset against the stub merchant. Do not write `PRIVATE_KEY=$PRIVATE_KEY` — dotenv does not expand that. The funded e2e suite never reads `.env`, so that path needs the shell export (see the [root quickstart](../README.md#root-quickstart)). |
| `MERCHANT_URL` | No | Base URL of the MPP-gated resource; the client appends the purchase id. Defaults to `http://localhost:4030/paid`. |
| `RPC_URL` | No | Source-chain RPC URL (Base Sepolia). When set, the client approves the source token (Permit2) before paying, so the escrow deposit does not revert at settlement. Leave blank against the stub merchant. |

> `PURCHASE_ID` is **not** a `.env` value — the client generates one per run and prints it. Pass it on the command line only, to resume an interrupted payment. See [Retries and idempotency](#retries-and-idempotency).

> **Where the key lives.** For `npm run pay`, `PRIVATE_KEY` can be in the shell (`export PRIVATE_KEY=0x…`) or in `.env`. `dotenv` does not override a variable already in the environment, so an exported key wins. `unset PRIVATE_KEY` when you want a stub run with a throwaway signer. `npm run test:e2e` does not read `.env` — that path needs the export; see the [root quickstart](../README.md#root-quickstart).

### 3. Run the client

```bash
npm run pay
```

Expected output when paired with the stub merchant:

```
Requesting http://localhost:4030/paid/order_986d1b6ed264bde2bacd …
Purchase order_986d1b6ed264bde2bacd — to re-attempt it: PURCHASE_ID=order_986d1b6ed264bde2bacd npm run pay
  attempt 1/20 …
  settled after 1 attempt(s) in 0s
Status: 200
Payment-Receipt header: present
{
  "message": "Access granted.",
  "data": "Your premium content here."
}
```

To watch the re-attempt loop that resolves a slow settlement, start the merchant with `STUB_PENDING_ATTEMPTS=2` (see [`mpp-accept-payments`](../mpp-accept-payments)) — no funds, no gateway.

## Testing

```bash
npm test
```

This verifies the retry behavior described above against a server that fails a couple of times before succeeding — no live merchant needed. To test this client together with a real `mpp-accept-payments` merchant instead, run `npm test` from [`../mpp-accept-payments`](../mpp-accept-payments) — that test drives both apps together.

## Going to testnet / mainnet

The shipped `.env.example` is wired for the **Base Sepolia → Tempo** testnet corridor: `MERCHANT_URL=http://localhost:4030/paid` (the sibling merchant) and `RPC_URL=https://sepolia.base.org` (the Base Sepolia source chain) are already set. To pay for real:

1. `PRIVATE_KEY` — `export PRIVATE_KEY=0x…` in this shell, or uncomment it in `.env`.
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

For **mainnet** (where authorized by Atum), the steps are identical with Atum-authorized mainnet chains/tokens and a merchant settling through a production gateway.

## Project structure

```
src/
├── client.ts         # The mppx client — names the purchase and pays for the resource
├── purchase.ts       # Re-attempts the purchase until settlement reaches a terminal outcome
└── purchase.test.ts  # Verifies pending is retried and a terminal failure is not
```

## Further reading

- [MPP](https://mpp.dev)
- [Atum documentation](https://docs.atum.xyz)
