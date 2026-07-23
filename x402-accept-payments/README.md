# x402-accept-payments

An example merchant server that accepts cross-chain payments using the [x402](https://x402.org) protocol and Atum's `atum-escrow` scheme.

The merchant gates a route (`GET /paid`) behind payment: unpaid requests receive an HTTP `402` with the payment options the merchant accepts; a request carrying a valid payment credential is verified and settled through the Atum x402 facilitator before the protected content is returned.

By default this example uses a **stub** that runs the full `402 → pay → 200` flow locally with no facilitator, gateway, or funds — the x402 counterpart of the stub submitter in [`mpp-accept-payments`](../mpp-accept-payments). Flip one flag to settle for real.

## How it works

1. A client hits `GET /paid` without a payment credential.
2. The merchant returns `402 Payment Required` with its accepted payment options in a `PAYMENT-REQUIRED` header (mirrored in the JSON body for readability).
3. The client signs a payment credential and retries with a `PAYMENT-SIGNATURE` header.
4. The merchant calls the facilitator's `/verify` — validates the credential without moving funds.
5. The merchant calls `/settle` — funds move on-chain.
6. The merchant returns `200 OK` with the protected resource and a `PAYMENT-RESPONSE` header carrying the settlement receipt.

In stub mode, steps 4–5 are short-circuited in-process with a canned success — nothing settles and no funds move.

## Prerequisites

- Node.js 20+
- npm

## Quickstart

### 1. Install dependencies

```bash
npm install
```

The merchant itself has no private dependencies — it runs the stub flow with only public packages. (Driving a real payment through it uses the [`x402-make-payments`](../x402-make-payments) client, which needs early-access npm access — see that example and [Testing](#testing) below.)

### 2. Configure environment

```bash
cp .env.example .env
```

The defaults run the stub submitter — no changes needed to try the flow locally.

### 3. Start the server

```bash
npm run dev
```

You should see:

```
Merchant listening on http://localhost:4020
Facilitator: stub (local, no funds)
```

### 4. Try a payment

Drive a payment through it with the [`x402-make-payments`](../x402-make-payments) client — a `curl` can't easily produce the signed credential x402 expects. Start this server, then run `npm run pay` there; you should get a `200` with an `Access granted` body.

## Testing

```bash
npm test
```

This boots the merchant (stub mode) and drives real payments against it using the `x402-make-payments` client, then checks for a successful `200`. It also covers concurrent payments from different wallets, the same wallet paying more than once, and the server refusing to start when it's misconfigured for real settlement.

**Running the tests needs early-access npm access.** The test drives the `x402-make-payments` client, which depends on `@atumlabs/x402-atum-escrow` — a **restricted** package on npm. It can't be installed without authentication, so the suite runs **locally**, not in public CI.

Local (one-time):

```bash
npm login                                   # an account granted @atumlabs access
cd ../x402-make-payments && npm install     # installs the restricted client package
cd ../x402-accept-payments && npm install
npm test
```

Running it in your own private CI: provide an automation token with read access to the `@atumlabs` scope as an `NPM_TOKEN` secret, write an `.npmrc` before install, then `npm ci` in both apps and `npm test`:

```
//registry.npmjs.org/:_authToken=${NPM_TOKEN}
@atumlabs:registry=https://registry.npmjs.org
```

> The end-to-end test that settles against the live facilitator is **opt-in** — it moves real testnet funds. Run it with a funded wallet:
>
> ```bash
> RUN_REAL_E2E=1 PRIVATE_KEY=0x... DEST_ADDRESS=0x... npm test
> ```
>
> It asserts a real on-chain settlement and fails if it detects the stub, so it can never give a false pass.
>
> **x402 settles synchronously.** The x402 facilitator (v1) confirms settlement only within the gateway's synchronous window (~30s, the server-side `payment_sync_wait_seconds`) — it has no async tail. If a corridor settles slower than that window, `/settle` returns `"settlement did not complete synchronously; the async tail is not supported in v1"` and the payment continues settling asynchronously without a synchronous confirmation. (This is the key difference from MPP, whose merchant polls the gateway for the async tail.) In that case the real e2e reports the limitation; set `ALLOW_ASYNC_TAIL=1` to treat a clean submission as a conditional pass (wiring verified up to submission).

## Going to testnet / mainnet

> **⚠ Cross-chain settlement can be slower than x402 can confirm.** x402 settles **synchronously** — the facilitator only confirms settlement within the gateway's ~30s window. On slow corridors (notably **Base ↔ Tempo**), cross-chain settlement often takes longer, so `/settle` returns `"the async tail is not supported in v1"` and the payment is reported as unconfirmed **even though it may have gone through**. A pending/timeout result here is **not** a confirmed failure — verify on-chain before retrying (a fresh retry is a *second* payment). For a reliably synchronous demo, use a fast corridor; for slow corridors, prefer [MPP](../mpp-accept-payments), whose merchant polls the gateway for the async tail.

The shipped `.env.example` runs the stub. To settle for real against Atum's testnet facilitator, change two values in `.env`:

1. `USE_STUB_FACILITATOR=false` — switch from the stub to the real facilitator.
2. `DEST_ADDRESS=` — your receiving address on the destination chain (Tempo).

The corridor defaults to **Base Sepolia USDC → Tempo pathUSD**. To switch corridors, uncomment one **source** pair and one **dest** pair from the corridor menu in `.env.example` — a curated, copy-paste-correct list drawn from [Supported assets](https://docs.atumlabs.xyz/get-started/reference/supported-assets) (EVM only, since this example signs with ethers + Permit2; not every pair has settlement coverage yet — see the notes there). The escrow, proxy, reserver, releaser, and verifier addresses are then fetched from the gateway's `/defaults` automatically — you never paste them by hand. Amount, markup, deadlines, and the facilitator/gateway URLs also have working defaults (see the top of `src/merchant.ts`).

The payer funds the payment (source token + gas) — see [`x402-make-payments`](../x402-make-payments). On a successful real settlement the merchant logs the settlement transaction:

```
Merchant listening on http://localhost:4020
Facilitator: real https://x402-facilitator.production-testnet.atum.xyz · corridor from https://payment-gw.production-testnet.atum.xyz/defaults
→ 402: no payment credential, issuing challenge
→ 200: settled (tx 0x…)
```

For **mainnet**, the steps are identical — point `FACILITATOR_URL` / `GATEWAY_URL` at production and set the corridor to mainnet chains and tokens.

## Project structure

```
src/
├── merchant.ts     # The x402 merchant — gate a route behind payment (stub or real)
└── smoke.test.ts   # End-to-end check: boots both apps together and verifies a payment succeeds
```

## Further reading

- [x402 Facilitator API reference](https://docs.atumlabs.xyz/api-reference/x402/introduction)
- [x402 protocol](https://x402.org)
- [Atum documentation](https://docs.atumlabs.xyz)
