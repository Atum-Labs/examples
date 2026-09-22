# pgc-make-payments

An example client that programmatically prepares, signs, and submits a payment through the Atum Payment Gateway using [`@atumlabs/payment-gateway-client`](https://www.npmjs.com/package/@atumlabs/payment-gateway-client).

There is no paired merchant. PGC is the direct gateway path (`prepare` → sign → submit → collect) — not an HTTP-gated `402` resource.

> Licensed under MIT — see the [root LICENSE](../LICENSE). The packages, gateway, chains, assets, and corridors shown here are testnet defaults. Atum makes no promise of support, maintenance, compatibility, or production availability.

## How it works

The client handles the full payment flow automatically:

1. Builds a payment request — corridor contract addresses come from the gateway's `GET /v1/defaults`, not from config.
2. Signs a Permit2 authorization for the source token — signing itself costs nothing on-chain, and the escrow deposit executes only when the gateway settles. (In real mode the client also sends a one-off `approve(Permit2)` transaction if your allowance is short — see [Going to testnet / mainnet](#going-to-testnet--mainnet).)
3. Submits the signed request.
4. If settlement outruns the gateway's synchronous window, follows the **same request id** until it reaches a terminal outcome — see [Retries and idempotency](#retries-and-idempotency).

## Retries and idempotency

Cross-chain settlement can take longer than the gateway holds a connection open (~30s). A `2xx` from `submitPayment` means the payment was accepted, **not** that it settled. Read `status`:

| Status | Meaning | What to do |
| --- | --- | --- |
| `pending` | Accepted, still settling | Wait, or re-submit the **same** `request_id` |
| `completed` | Delivered | Done |
| `failed` / `cancelled` | Terminal | That id is spent; the same corridor needs a **new** `request_id` |

x402 and MPP collect a slow settlement by re-attempting the purchase (a fresh 402, a new signature). PGC has no 402. The SDK's collection mechanism is `waitForTerminalStatus` — the same helper behind `send-payment --wait` — which looks the payment up by `payment_id`. Re-submitting the same `request_id` also returns the current state, but it rebuilds and re-sends the payment to do so.

[`src/purchase.ts`](src/purchase.ts) waits:

```
Preparing eip155:84532/erc20:0x036C… → eip155:42431/erc20:0x20c0… via http://127.0.0.1:… …
Request pmt_f45bb75a9adc49258f64 — to re-attempt it: REQUEST_ID=pmt_f45bb75a9adc49258f64 npm run pay
  still settling — waiting for a terminal status
  settled — payment pay_stub_…
```

The `request_id` is required, and the SDK will not invent one. An id the library chose is an id you cannot reuse on a retry. This example generates one per run and prints it.

### It names a payment, not an order

A payment that fails terminally spends its identifier for good, so an order that outlives a failed payment needs a new one for the next attempt:

```
order books-123 → payment 1 (books-123-1) → FAILED   ← that identifier is now dead
                → payment 2 (books-123-2) → settles  ← the order is paid
```

So derive it from both — your order id plus a counter you bump for each new payment attempt at that order: `` `${order.id}-${order.paymentAttempts}` ``. Reuse it on every attempt at one payment; never across two payments — the second would resolve onto the first, so nothing additional is charged.

This example pays once per run, so it generates an identifier per run and prints it. Pass `REQUEST_ID` **only** to resume a payment interrupted while still settling — never set it in `.env`.

## Prerequisites

- **Node.js 20+** — includes npm.
- **A funded testnet wallet** — only for a real (non-stub) settlement: it needs the source token plus a little gas on the source chain. The client grants the Permit2 approval itself, so there is no manual approval step. Not needed against the default stub.

## Quickstart

### 1. Install dependencies

```bash
npm install
```

This installs `@atumlabs/payment-gateway-client` from the public registry, pinned to the v4-contracts release this client is drafted against.

### 2. Configure environment

```bash
cp .env.example .env
```

**A stub run needs no `.env` at all** — skip to `npm run pay`. The payment is signed offline and never touches a chain, so with `PRIVATE_KEY` unset the client generates a throwaway key for the run and prints its address. Copy `.env.example` when you move to real settlement:

| Variable | Required | Description |
|---|---|---|
| `USE_STUB_GATEWAY` | No | `true` (default) runs an in-process stub. `false` submits to a real gateway. |
| `PRIVATE_KEY` | For real settlement | 0x-prefixed 32-byte hex private key for the payer wallet. Leave it unset against the stub and the client generates one per run. |
| `DEST_ADDRESS` | For real settlement | Receiving address on the destination chain. |
| `RPC_URL` | No | Source-chain RPC URL (Base Sepolia). When set, the client approves the source token (Permit2) before signing. Leave blank against the stub. |
| `GATEWAY_URL` | No | Real-mode gateway. Defaults to the hosted testnet gateway. |

> `REQUEST_ID` is **not** a `.env` value — the client generates one per run and prints it. Pass it on the command line only, to resume an interrupted payment.

> **Switching wallets or environments?** If you previously exported `PRIVATE_KEY` in your shell, that value takes precedence over `.env`. Run `unset PRIVATE_KEY` so the value from `.env` is used.

### 3. Run the client

```bash
npm run pay
```

Expected output on the stub:

```
No PRIVATE_KEY set — signing this stub run with a throwaway key (0x…).
It holds no funds and is discarded on exit. Set PRIVATE_KEY in .env to settle for real.
Preparing eip155:84532/erc20:0x036CbD53842c5426634e7929541eC2318f3dCF7e → eip155:42431/erc20:0x20c0000000000000000000000000000000000000 via http://127.0.0.1:… …
Request pmt_f45bb75a9adc49258f64 — to re-attempt it: REQUEST_ID=pmt_f45bb75a9adc49258f64 npm run pay
  settled — payment pay_stub_0000000000000000
{
  "payment_id": "pay_stub_0000000000000000",
  "status": "completed",
  "confirmation": { ... }
}
```

To watch the wait that resolves a slow settlement, run with `STUB_PENDING_ATTEMPTS=2` — no funds, no gateway.

## CLI copy-paste

The same package ships command-line tools. After `npm install` they are on `npx`. The interesting split is **prepare and sign, review, then submit** — the document `--prepare-only` writes is not a description of the payment, it *is* the payment.

Widen the quote window if you intend to submit later, but only by tens of seconds. The default is 10s; an over-long window ends in a terminal `QUOTES_EXPIRED`. `--submit` signs nothing and needs no private key. Treat the prepared file like a signed cheque.

`send-payment`'s exit code tells you the outcome without parsing output: `0` completed, `2` pending (follow up with `payment-status` or `--wait`), `3` failed (terminal — a retry needs a NEW `--request-id`), `1` unknown (bad args, unreachable gateway, or a request that may still have been accepted — re-run under the same `--request-id` to find out). This only describes a submitted payment; `--prepare-only`'s exit `0` just means the request was built and signed, not that anything was paid — don't chain a payment-conditional step off it.

Real CLI commands talk to a live gateway (they are not the stub). Replace the sender, destination, and key with your own; the corridor is the hardened Base Sepolia USDC → Tempo pathUSD path.

```bash
export PRIVATE_KEY=0xYourOwnTestnetKey
export SENDER=0xYourPayerAddress
export DEST=0xYourReceivingEOA
export GATEWAY=https://payment-gw.production-testnet.atum.xyz
export SOURCE=eip155:84532/erc20:0x036CbD53842c5426634e7929541eC2318f3dCF7e
export DESTINATION=eip155:42431/erc20:0x20c0000000000000000000000000000000000000
```

```bash
# 1. build and sign, submit nothing
npx send-payment --prepare-only --gateway "$GATEWAY" \
  --quote-deadline-seconds 30 \
  --request-id order_demo_1 \
  "$SENDER" 50000 \
  "$SOURCE" \
  "$DEST" \
  "$DESTINATION" \
  > request.json
```

```bash
# 2. inspect it, have it reviewed
#    request.json is a signed authorization. Anyone who has it can send it.
```

```bash
# 3. send it
npx send-payment --submit request.json --gateway "$GATEWAY" --wait
```

Or piped, with no file on disk:

```bash
npx send-payment --prepare-only --gateway "$GATEWAY" \
  --quote-deadline-seconds 30 \
  --request-id order_demo_1 \
  "$SENDER" 50000 "$SOURCE" "$DEST" "$DESTINATION" \
  | npx send-payment --submit - --gateway "$GATEWAY" --wait
```

One-shot (prepare, sign, and submit together):

```bash
npx send-payment --gateway "$GATEWAY" --wait \
  --request-id order_demo_1 \
  "$SENDER" 50000 "$SOURCE" "$DEST" "$DESTINATION"
```

Follow a payment you already have an id for:

```bash
npx payment-status --gateway "$GATEWAY" pay_…
```

The SDK example (`npm run pay`) calls `ensureSourceApproval` when `RPC_URL` is set, so there is no manual Permit2 step on that path. The CLI's equivalent, if you are paying from the command line and have never approved this token, is:

```bash
npx approve-permit2 "$SENDER" "$SOURCE" --rpc-url https://sepolia.base.org
```

## Testing

```bash
npm test
```

Hermetic: the full prepare → sign → submit → collect flow runs against the in-process stub — no gateway, no funds, no key required.

## Going to testnet / mainnet

> **Cross-chain settlement can outrun the gateway's synchronous window (~30s)**, and on corridors like **Base ↔ Tempo** it often does. That is not a failure: `submitPayment` comes back `pending`, and `waitForTerminalStatus` (or a re-run under the same `REQUEST_ID`) collects the outcome.

The shipped `.env.example` is wired for the **Base Sepolia → Tempo** testnet corridor. To settle for real:

1. `USE_STUB_GATEWAY=false`
2. `PRIVATE_KEY=` — the payer wallet's key.
3. `DEST_ADDRESS=` — the receiving address on Tempo (or whichever chain is the destination).
4. Fund that wallet on **Base Sepolia**: the source token (**USDC**, ~`0.06` to cover the `0.05` charge plus markup) and a little **ETH** for gas. For the reverse leg, also fund it on **Tempo** with `pathUSD` — that covers both the payment and gas, since Tempo has no native gas token (see the root README's `cast rpc tempo_fundAddress` faucet command).
5. Set `RPC_URL=https://sepolia.base.org` (or the source chain you are paying from). The client then approves **Permit2** for you before signing, via `ensureSourceApproval`.

   Worth getting right up front: a deposit that reverts on-chain is a *terminal* settlement failure, and a terminal failure spends that request identifier for good.

6. Leave `GATEWAY_URL` unset to use the hosted testnet gateway (`https://payment-gw.production-testnet.atum.xyz`).

On success the client prints the `payment_id` and fulfillment confirmation (source and destination transaction hashes). Verify the movement on `sepolia.basescan.org` (USDC leaves the payer wallet) and `explore.testnet.tempo.xyz` (pathUSD arrives — import token `0x20c0000000000000000000000000000000000000`, 6 decimals).

For **mainnet** (where authorized by Atum), the steps are identical with Atum-authorized mainnet chains/tokens and the production gateway URL Atum provides.

## Project structure

```
src/
├── client.ts        # prepare → sign → submit → collect
├── purchase.ts      # waitForTerminalStatus until the payment is terminal
└── stub-gateway.ts  # in-process gateway for stub runs and smoke tests
```

## Further reading

- [Build with the SDK](https://docs.atum.xyz/get-started/start-building/build-with-the-sdk)
- [Using the CLI](https://docs.atum.xyz/get-started/start-building/using-the-cli)
- [Atum documentation](https://docs.atum.xyz)
