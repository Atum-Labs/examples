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
- **Disputes, chargebacks, refunds, or reversals** beyond the idempotent re-attempt of a purchase described below.

## Prerequisites for settlement proof

- Node.js 20+ and npm.
- **`@atumlabs` npm access** (early access / restricted scope). Without it, `npm install` fails on the client packages. [Contact Atum](mailto:support@atumlabs.xyz).
- A **funded wallet on every chain it spends from** — for the shipped corridor that's Base Sepolia (testnet USDC to spend, plus ETH for gas) and, because the funded test settles **both directions** by default, Tempo (Moderato) as well (pathUSD, which also covers gas: `cast rpc tempo_fundAddress <your-address> --rpc-url https://rpc.moderato.tempo.xyz`). Set `SKIP_REVERSE=1` to run the forward leg only and fund just one chain.
- A **receiving address on the destination chain** — for the shipped corridor, Tempo (Moderato), where the merchant is paid out.

> Real testnet funds move. A settlement that outruns the gateway's ~30s synchronous window is not a failure: re-attempting the **same purchase** resolves onto the original payment and returns its outcome, and cannot charge twice. What you must not do is pay again under a *new* purchase identifier — that is a second payment.

## The self-serve proof

Both protocols ship an opt-in real-settlement test, gated on `RUN_REAL_E2E=1` so it never runs by accident. Each one boots the real merchant against the hosted gateway/facilitator, drives a real payment with the client, and **asserts a genuine on-chain settlement — failing loudly if it detects the stub**, so it cannot give a false pass.

### MPP (recommended)

On the shipped Base ↔ Tempo corridor both protocols settle at comparable speed (~25–40s per leg) and behave identically when settlement runs long (see [Reliability](#reliability-characteristics)). Choose between them on integration shape, not on settlement reliability.

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

The merchant logs `→ 200: settled`, followed by the settlement transaction link(s). If the corridor settles slower than the gateway's synchronous window, the payer re-attempts the purchase until it does — the run takes longer, and the outcome is the same. Optional overrides: `RPC_URL` (default `https://sepolia.base.org`), `FACILITATOR_URL`, `GATEWAY_URL`.

## Independent verification

Do not take the logs at face value — that's the point of an on-chain rail. For each run:

1. Open the **source deposit** on the source-chain block explorer (shipped corridor: [Base Sepolia](https://sepolia.basescan.org)): confirm the payer's token moved into the escrow contract for the expected amount (`FULFILLMENT_AMOUNT` + markup).
2. Open the **destination payout** on the destination-chain explorer (shipped corridor: [Tempo](https://explore.testnet.tempo.xyz)): confirm your `DEST_ADDRESS` received exactly `FULFILLMENT_AMOUNT` of the destination token.
3. Confirm the two are the legs of one payment (the merchant log ties them to a single `payment id`).

If both transactions confirm on their respective chains, the corridor settled — regardless of what any local process reported.

## Reliability characteristics

Both protocols now behave the same way, because both rest on the same guarantee: a payment has a stable identity, and re-attempting it resolves onto the original payment instead of taking a second one.

| | x402 | MPP |
| --- | --- | --- |
| Behaviour when settlement is slow | The facilitator reports `settlement_pending` with the payment id. Nothing is held open. | `verify()` raises `SettlementPendingError` with the payment id. Nothing is held open, and the merchant does **not** poll. |
| How the outcome is collected | The payer re-attempts the same purchase until it reaches a terminal outcome. | Identical. |
| Naming the purchase | The payer supplies `paymentIdentifier`; it rides in the payment. **The merchant's API is unchanged.** | The merchant stamps `intentId` into the challenge, read from its own route (`/invoices/4711/pdf` already has it). |
| Terminal failure | That identifier is spent for good; the same goods need a NEW one. | Identical. |
| Delivering once | The merchant's own job: key fulfilment on the receipt's `payment_id`, never on the request. | Identical. |

**Takeaway:** settlement reliability is no longer a reason to prefer one protocol over the other — on the shipped Base ↔ Tempo corridor they settle at comparable speed (~25–40s per leg) and resolve a slow settlement the same way. Choose on integration shape: x402 asks nothing of your API, while MPP needs one value your route already carries.

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
