# Settlement proof: Base ↔ Tempo over x402 and MPP

This guide is for teams evaluating Atum as a **settlement rail that runs underneath their own orchestration layer** — routing, credentialing, guaranteeing, or otherwise sitting *above* the payment and reconciling it — rather than acting as the merchant or the payer themselves.

If that's you, the question you're really asking is not "how do I gate a route behind payment?" It's **"is the Base ↔ Tempo settlement underneath these protocols real, verifiable, and reliable enough to build on?"** This guide shows how to answer that yourself, end to end, with on-chain evidence — no Atum-side demo required.

> **Proprietary reference material.** See the [root README](../README.md) and [`LICENSE`](../LICENSE). Chains, assets, corridors, gateway, and facilitator shown here are illustrative and require separate Atum authorization; their appearance implies no availability or support.

## What these examples prove — and what they don't

The four examples in this repo model the two *endpoints* of a payment: a merchant that accepts (`*-accept-payments`) and a payer that pays (`*-make-payments`). The **settlement itself** — moving value from a source token on one chain to a destination token on another — is performed by Atum's hosted **payment gateway** (MPP) and **x402 facilitator**, which the examples call. That is the layer an orchestration/settlement operator cares about, so this guide focuses on exercising it for real and verifying the result independently.

**These examples prove:**

- A real Base ↔ Tempo payment settles cross-chain and produces **independently verifiable on-chain transactions** (a source-chain escrow deposit and a destination-chain payout).
- The **reliability semantics** an operator must design around: idempotent retries, and the difference between x402's synchronous confirmation window and MPP's asynchronous polling.
- The exact **integration surface** (the 402 challenge, the signed credential, the verify/settle or submit call) so you can estimate the lift of sitting above it.

**These examples do NOT prove (out of scope — see [Above the rail](#above-the-rail-what-an-orchestration-layer-adds), below):**

- **The fiat leg.** No card authorization/capture, no on-ramp/off-ramp. The corridor is stablecoin → stablecoin only.
- **Credential or token issuance.** No agent-credential minting, tokenization, or identity — the payer here simply holds a key.
- **Disputes, chargebacks, refunds, or reversals** beyond idempotent retry of an identical credential.
- **Mainnet.** What ships targets **Base Sepolia ↔ Tempo Moderato** (testnets). Production requires separate Atum authorization and production gateway/facilitator URLs.

These omissions are deliberate. They are precisely the responsibilities that live in the orchestration/credential/guarantee layer *above* the rail — the layer an evaluator would themselves operate — not in a settlement-rail example. See [below](#above-the-rail-what-an-orchestration-layer-adds).

## Prerequisites

- Node.js 20+ and npm.
- **`@atumlabs` npm access** (early access / restricted scope). Without it, `npm install` fails on the client packages. [Contact Atum](mailto:support@atumlabs.xyz).
- A **funded Base Sepolia wallet** — testnet USDC to spend plus Base Sepolia gas. This is the payer key.
- A **receiving address on Tempo (Moderato)** — where the merchant is paid out.

> Real testnet funds move. A failed or timed-out result on `production-testnet` is not necessarily a confirmed failure — verify on-chain before retrying (a fresh retry with a *new* credential is a second payment).

## The self-serve proof

Both protocols ship an opt-in real-settlement test, gated on `RUN_REAL_E2E=1` so it never runs by accident. Each one boots the real merchant against the hosted gateway/facilitator, drives a real payment with the client, and **asserts a genuine on-chain settlement — failing loudly if it detects the stub**, so it cannot give a false pass.

### MPP (recommended for Base ↔ Tempo)

MPP is the right choice on this corridor: cross-chain settlement here routinely takes longer than x402 v1 can confirm synchronously, and the MPP merchant polls the gateway to a terminal state instead of giving up (see [Reliability](#reliability-characteristics)).

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

On a synchronous settlement the merchant logs `→ 200: settled (tx 0x…)`. If the corridor settles slower than the facilitator's synchronous window, the test **fails by design** with the async-tail explanation; set `ALLOW_ASYNC_TAIL=1` to accept "submitted, settling asynchronously" as a conditional pass (wiring verified up to submission). Optional overrides: `RPC_URL` (default `https://sepolia.base.org`), `FACILITATOR_URL`, `GATEWAY_URL`.

## Independent verification

Do not take the logs at face value — that's the point of an on-chain rail. For each run:

1. Open the **source deposit** on [Base Sepolia explorer](https://sepolia.basescan.org): confirm the payer's USDC moved into the escrow contract for the expected amount (`FULFILLMENT_AMOUNT` + markup).
2. Open the **destination payout** on the [Tempo explorer](https://explore.testnet.tempo.xyz): confirm your `DEST_ADDRESS` received exactly `FULFILLMENT_AMOUNT` of pathUSD.
3. Confirm the two are the legs of one payment (the merchant log ties them to a single `payment id`).

If both transactions confirm on their respective chains, the corridor settled — regardless of what any local process reported.

## Reliability characteristics

| | x402 (v1 facilitator) | MPP |
| --- | --- | --- |
| Settlement confirmation | **Synchronous only** — the facilitator confirms within the gateway's `payment_sync_wait_seconds` (~30s). No async tail. | Merchant **polls** `GET /payments/{id}/status` to a terminal state (up to the fulfillment deadline). |
| Behavior when settlement is slow (typical Base ↔ Tempo) | Returns `"async tail is not supported in v1"`; the payment keeps settling but **cannot be confirmed synchronously**. Not a confirmed failure. | Waits it out and reports the terminal result. |
| Idempotency / retry | Resending the **identical** signed credential is idempotent (the gateway returns the original result, not a second charge). Never build a new credential for a retry. | Same — see `mpp-make-payments/src/retry.ts` and its tests. |

**Takeaway for an operator:** on Base ↔ Tempo, prefer **MPP** for a deterministic confirmation. If you use x402, your orchestration layer must treat a pending/async-tail result as *unconfirmed, not failed*, and reconcile against on-chain state before retrying.

## Above the rail: what an orchestration layer adds

If you are evaluating whether this rail can sit **underneath** you, these are the responsibilities that remain **yours** (and are intentionally not in these examples), so scope them in from the start rather than discovering them late:

- **Fiat bridging** — card auth/capture and on-/off-ramp between your fiat side and the source/destination stablecoins.
- **Credentials & identity** — issuing and validating the credentials (agent or otherwise) that authorize a payment; tokenization.
- **Dispute lifecycle** — chargebacks, refunds, and reversals. The rail gives you idempotent settlement and on-chain finality; dispute *policy* is yours.
- **Guarantee / underwriting & risk** — fraud, limits, and any settlement guarantee you extend to your participants.
- **Reconciliation & reporting** — mapping on-chain settlement evidence back to your ledger.

Naming these up front — rather than letting an evaluator assume the examples cover them — is the difference between "the rail is real and we know exactly where we plug in" and "the demo only showed an endpoint."

## Further reading

- [Root README](../README.md) — environments (stub / testnet / mainnet) and the corridor.
- [`x402-accept-payments`](../x402-accept-payments/README.md) and [`mpp-accept-payments`](../mpp-accept-payments/README.md) — the merchant/settlement side.
- [Atum documentation](https://docs.atumlabs.xyz)
