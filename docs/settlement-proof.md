# Settlement proof: verifying real settlement over x402 and MPP

This guide shows how to apply these examples to **real settlement**, and how to **verify (with independent on-chain evidence) that a payment actually settled**. It's for anyone moving an integration toward production, whether you're the merchant accepting payments, the payer making them, or building a platform on top of the rail.

The question it answers is: **is settlement over these protocols real, verifiable?** You can confirm that, end to end, with on-chain evidence — no Atum-side demo required.

> **Proprietary reference material.** See the [root README](../README.md) and [`LICENSE`](../LICENSE). Chains, assets, corridors, gateway, and facilitator shown here are illustrative and require separate Atum authorization.

> **Corridor.** Atum supports many corridors ([supported assets](https://docs.atumlabs.xyz/get-started/reference/supported-assets)); the one these examples are **tested and hardened** against — and wired to out of the box — is **Base Sepolia USDC ↔ Tempo (Moderato) pathUSD**. See the [root README](../README.md) for its hardening status, and each app's `.env.example` for the exact chains, assets, and addresses. The proof method below is corridor-agnostic — the commands just use the hardened corridor for concreteness; to prove another supported corridor, point the examples at it and substitute the source/destination chains, assets, and block explorers.

## What these examples prove 

The four examples in this repo model the two *endpoints* of a payment: 

- A merchant that accepts (`*-accept-payments`) and
- A payer that pays (`*-make-payments`)

The **settlement itself** — moving value from a source token on one chain to a destination token on another — is performed by Atum's hosted **payment gateway** (MPP) and **x402 facilitator**, which the examples call. 

This guide focuses on exercising that settlement on-chain, and verifying the result independently so that you can trust your code before going to production. 

**These examples demonstrate:**

- A real payment can settle cross-chain and produce **independently verifiable on-chain transactions** (a source deposit and a destination-chain payout).
- The exact **integration surface** (the 402 challenge, the signed credential, the verify/settle or submit call) so you can estimate your own integration lift.

## What these examples do not prove

- **The fiat leg.** No card authorization/capture, no on-ramp/off-ramp. The corridor is stablecoin → stablecoin only.
- **Credential or token issuance.** No agent-credential minting, tokenization, or identity — the payer here simply holds a key.
- **Disputes, chargebacks, refunds, or reversals** beyond idempotent retry of an identical credential.

## Prerequisites for settlement proof

- Node.js 20+ and npm.
- **`@atumlabs` npm access** (early access / restricted scope). Without it, `npm install` fails on the client packages. [Contact Atum](mailto:support@atumlabs.xyz).
- A **funded wallet on every chain it spends from** — for the shipped corridor that's Base Sepolia (testnet USDC to spend, plus ETH for gas) and, because the funded test settles **both directions** by default, Tempo (Moderato) as well (pathUSD, which also covers gas: `cast rpc tempo_fundAddress <your-address> --rpc-url https://rpc.moderato.tempo.xyz`). Set `SKIP_REVERSE=1` to run the forward leg only and fund just one chain.
- A **receiving address on the destination chain** — for the shipped corridor, Tempo (Moderato), where the merchant is paid out.

> Real testnet funds move. A failed or timed-out result on `production-testnet` is not necessarily a confirmed failure — verify on-chain before retrying (a fresh retry with a *new* credential is a second payment).

## The self-serve proof

Both protocols ship an opt-in real-settlement test, gated on `RUN_REAL_E2E=1` so it never runs by accident. Each one boots the real merchant against the hosted gateway/facilitator, drives a real payment with the client, and **asserts a genuine on-chain settlement — failing loudly if it detects the stub**, so it cannot give a false pass.

### MPP (recommended)

On the shipped Base ↔ Tempo corridor MPP settles about as fast as x402 (~25–40s per leg). Its edge isn't speed — it's that the merchant polls the gateway to a terminal state, so if a corridor ever settles slower than x402 v1 can confirm synchronously, MPP still resolves to a confirmed result instead of giving up (see [Reliability](#reliability-characteristics)).

```bash
# one-time: install the restricted client + merchant packages
npm login                                   # an account granted @atumlabs access
cd mpp-make-payments   && npm install
cd ../mpp-accept-payments && npm install

# run the real settlement and assert an on-chain result
RUN_REAL_E2E=1 \
  PRIVATE_KEY=0x<funded Base Sepolia key> \
  DEST_ADDRESS=0x<your Tempo receiving address> \
  MPP_SECRET_KEY=$(openssl rand -hex 32) \
  npm test
```

On success the merchant logs the two transactions that constitute the proof:

```
  settled payment 0x<payment id>
    source deposit:     https://sepolia.basescan.org/tx/0x…   (Base Sepolia USDC into escrow)
    destination payout: https://explore.testnet.tempo.xyz/tx/0x…   (Tempo pathUSD to your address)
[…] → 200: settled, serving resource
```

Prefer to watch it by hand instead of via the test? Run the two apps in separate terminals:

```bash
# terminal 1 — merchant, real settlement
cd mpp-accept-payments
USE_STUB_SUBMITTER=false \
  MPP_SECRET_KEY=$(openssl rand -hex 32) \
  DEST_ADDRESS=0x<Tempo receiving address> \
  npm run dev

# terminal 2 — payer
cd mpp-make-payments
PRIVATE_KEY=0x<funded Base Sepolia key> \
  RPC_URL=https://sepolia.base.org \
  npm run pay
```

### x402

```bash
npm login
cd x402-make-payments   && npm install
cd ../x402-accept-payments && npm install

RUN_REAL_E2E=1 \
  PRIVATE_KEY=0x<funded Base Sepolia key> \
  DEST_ADDRESS=0x<your Tempo receiving address> \
  npm test
```

On a synchronous settlement the merchant logs `→ 200: settled`, followed by the settlement transaction link(s). If the corridor settles slower than the facilitator's synchronous window, the test **fails by design** with the async-tail explanation; set `ALLOW_ASYNC_TAIL=1` to accept "submitted, settling asynchronously" as a conditional pass (wiring verified up to submission). Optional overrides: `RPC_URL` (default `https://sepolia.base.org`), `FACILITATOR_URL`, `GATEWAY_URL`.

## Independent verification

Do not take the logs at face value — that's the point of an on-chain rail. For each run:

1. Open the **source deposit** on the source-chain block explorer (shipped corridor: [Base Sepolia](https://sepolia.basescan.org)): confirm the payer's token moved into the escrow contract for the expected amount (`FULFILLMENT_AMOUNT` + markup).
2. Open the **destination payout** on the destination-chain explorer (shipped corridor: [Tempo](https://explore.testnet.tempo.xyz)): confirm your `DEST_ADDRESS` received exactly `FULFILLMENT_AMOUNT` of the destination token.
3. Confirm the two are the legs of one payment (the merchant log ties them to a single `payment id`).

If both transactions confirm on their respective chains, the corridor settled — regardless of what any local process reported.

## Reliability characteristics

| | x402 (v1 facilitator) | MPP |
| --- | --- | --- |
| Settlement confirmation | **Synchronous only** — the facilitator confirms within the gateway's `payment_sync_wait_seconds` (~30s). No async tail. | Merchant **polls** `GET /payments/{id}/status` to a terminal state (up to the fulfillment deadline). |
| Behavior when settlement is slow (e.g. the shipped Base ↔ Tempo corridor) | Returns `"async tail is not supported in v1"`; the payment keeps settling but **cannot be confirmed synchronously**. Not a confirmed failure. | Waits it out and reports the terminal result. |
| Idempotency / retry | Resending the **identical** signed credential is idempotent (the gateway returns the original result, not a second charge). Never build a new credential for a retry. | Same — see `mpp-make-payments/src/retry.ts` and its tests. |

**Takeaway:** on the shipped Base ↔ Tempo corridor both protocols settle at comparable speed (~25–40s per leg); MPP additionally **survives the async tail** — it polls to a terminal state, so it always resolves to a confirmed result. Prefer **MPP** for a deterministic confirmation. If you use x402, your integration must treat a pending/async-tail result as *unconfirmed, not failed*, and reconcile against on-chain state before retrying.

## Beyond settlement: what you still build

The rail settles value and gives you on-chain finality. Everything around that stays with you and is intentionally out of scope for these examples. These matter if you're building an intermediary on top of the rail.

- **Fiat bridging** — card auth/capture and on-/off-ramp between fiat and the source/destination stablecoins.
- **Credentials & identity** — issuing and validating the credentials (agent or otherwise) that authorize a payment; tokenization.
- **Dispute lifecycle** — chargebacks, refunds, and reversals. The rail gives you idempotent settlement and on-chain finality; dispute *policy* is yours.
- **Guarantee / underwriting & risk** — fraud, limits, and any settlement guarantee you extend to your users.
- **Reconciliation & reporting** — mapping on-chain settlement evidence back to your ledger.

These are illustrative. Other participants in the rail may carry related responsibilities.

## Further reading

- [Root README](../README.md) — environments (stub / testnet / mainnet) and the corridor.
- [`x402-accept-payments`](../x402-accept-payments/README.md) and [`mpp-accept-payments`](../mpp-accept-payments/README.md) — the merchant/settlement side.
- [Atum documentation](https://docs.atumlabs.xyz)
