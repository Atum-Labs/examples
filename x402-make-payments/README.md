# x402-make-payments

An example x402 client that programmatically pays for an HTTP-gated resource using the [x402](https://x402.org) protocol and Atum's `atum-escrow` scheme.

> **Proprietary reference example.** This is an Atum reference implementation provided to approved developers — not open-source software. The packages, facilitator, gateway, chains, assets, and corridors it shows (e.g. Base Sepolia, Tempo, pathUSD) are illustrative; their availability and your access to them require separate Atum authorization and are **not** implied by their appearance here. Atum makes no promise of support, maintenance, compatibility, or production availability. Contact Atum for access.

## How it works

The client handles the full payment flow automatically:

1. Requests the resource — receives a `402 Payment Required` response.
2. Reads the payment requirements from the `PAYMENT-REQUIRED` header.
3. Signs a Permit2 authorization for the source token (no on-chain transaction — the escrow deposit executes only when the merchant settles).
4. Retries the request with the signed credential in a `PAYMENT-SIGNATURE` header and returns the final `200` response.

## Resilience: safe retries

x402's SDK handles the payment handshake for you: `wrapFetchWithPayment` (from `@x402/fetch`) makes the initial request, reads the `402`, signs the payment, and retries with the credential — all in one `fetchWithPayment` call. This example therefore doesn't ship a dedicated retry module the way [`mpp-make-payments`](../mpp-make-payments) does.

If you add your own retries around a settled payment (e.g. on a transient `5xx`), follow the same rule that example documents: resend the **identical** signed payment rather than signing a new one — re-signing would be a distinct, second payment, and the Atum gateway is idempotent on an identical resubmission. If you instead re-run the client to retry (which re-signs), set a stable `REQUEST_ID` so the re-signed payment reuses the same deposit nonce and is deduped — see [Avoiding double payments](#avoiding-double-payments).

## Avoiding double payments

A double payment happens when a payer, unsure whether a slow settlement succeeded, **pays again**. The escrow deposit nonce is derived from `(REQUEST_ID, payer address)`, so setting and reusing a stable `REQUEST_ID` makes a retry reproduce the *same* nonce — the second attempt is deduped on-chain and by the Atum gateway instead of charging twice. Follow four rules:

1. **One `REQUEST_ID` per payment** — derive it from something already unique per payment, such as your order or invoice id.
2. **Reuse it verbatim on retry** of that same payment.
3. **Never reuse it across different payments** — a new payment needs a new id, or the second payment dedupes into the first and is rejected.
4. **Keep one payment per run** — this example pays once per invocation, which makes a per-run `REQUEST_ID` a per-payment id automatically. Do **not** wrap it in a loop that makes several payments under one fixed id (the second and later payments would collide on the nonce).

**Retrying a "settlement pending" result** (see [Going to testnet / mainnet](#going-to-testnet--mainnet)): re-run with the **same** `REQUEST_ID`. Because the nonce is identical, the gateway recognizes the resubmission and will not charge again — so a retry is safe even before you can tell whether the first attempt settled.

> Leaving `REQUEST_ID` blank uses a fresh random id each run, which is fine for a one-shot demo but **not** retry-safe: a re-run would sign a new nonce and could double-pay.

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
| `REQUEST_ID` | No | Idempotency key for the payment. Set to a stable per-payment id (e.g. your order id) and reuse it on retry to avoid a double charge; use a distinct value per payment. Blank ⇒ a random, non-retry-safe id is used. See [Avoiding double payments](#avoiding-double-payments). |

> **Switching wallets or environments?** If you previously exported `PRIVATE_KEY` in your shell (e.g. `export PRIVATE_KEY=0x…`), that value takes precedence over `.env` — `dotenv` does not replace variables already set in your environment. After editing `.env` you may silently keep signing with the old key. Run `unset PRIVATE_KEY` so the value from `.env` is used, then re-run the client.

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

## Going to testnet / mainnet

> **⚠ Cross-chain settlement can be slower than x402 can confirm.** x402 settles **synchronously**: if cross-chain settlement outruns the facilitator's ~30s window (common on slow corridors like **Base ↔ Tempo**), the client prints a `402` with `"the async tail is not supported in v1"` and a "settlement pending" warning. That is **not** a confirmed failure — the payment was submitted and may still complete. If you set a stable `REQUEST_ID` ([Avoiding double payments](#avoiding-double-payments)), you can safely re-run with the **same** value — the retry is deduped, not a second payment. Otherwise a fresh retry *is* a second payment, so verify on-chain first. Prefer fast corridors for a synchronous demo.

The shipped `.env.example` is wired for the **Base Sepolia → Tempo** testnet corridor — the merchant's default. To pay a real (non-stub) merchant:

1. `PRIVATE_KEY=` — the payer wallet's key.
2. Fund that wallet on **Base Sepolia**: the source token (**USDC**, ~`0.06` to cover the `0.05` charge plus the 3% markup cap) and a little **ETH** for gas. For the reverse leg, also fund it on **Tempo** with `pathUSD` — that covers both the payment and gas, since Tempo has no native gas token (see the root README's `cast rpc tempo_fundAddress` faucet command).
3. Approve **Permit2** once per source token, per chain — the escrow pulls your funds through it, and this client refuses to sign without an allowance:

   ```bash
   # Base Sepolia USDC
   cast send 0x036CbD53842c5426634e7929541eC2318f3dCF7e "approve(address,uint256)" \
     0x000000000022D473030F116dDEE9F6B43aC78BA3 1000000000 \
     --rpc-url https://sepolia.base.org --private-key "$PRIVATE_KEY"

   # Tempo pathUSD — needed to pay *from* Tempo (the reverse leg)
   cast send 0x20c0000000000000000000000000000000000000 "approve(address,uint256)" \
     0x000000000022D473030F116dDEE9F6B43aC78BA3 1000000000 \
     --rpc-url https://rpc.moderato.tempo.xyz --private-key "$PRIVATE_KEY"
   ```

   `mpp-make-payments` does this for you via `ensureSourceApproval`; this client only checks and aborts.
4. Set `RPC_URL=https://sepolia.base.org` so the client preflights that allowance before signing — it aborts with a clear message rather than reverting on-chain at settle.

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
