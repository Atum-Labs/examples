# AGENTS.md

Atum reference examples for accepting and making payments over **x402** and **MPP**. Licensed under MIT — see [`LICENSE`](./LICENSE).

**Tested corridor:** Atum supports many corridors ([supported assets](https://docs.atum.xyz/get-started/reference/supported-assets)); the corridor these examples are hardened against is **Base Sepolia USDC ↔ Tempo (Moderato) pathUSD**. The [root README](./README.md) is the source of truth for that hardened corridor and its status; each app's `.env.example` holds the exact chains, assets, and addresses it's wired to. Other supported corridors work but aren't hardened here — prefer the hardened one for anything you need to rely on.

## Layout

Each app is a standalone npm package (no workspaces). The repo root has a thin orchestration `package.json` (scripts only, no deps) to install/typecheck/test all apps at once — see the [root README](./README.md#running-the-tests). Apps pair by protocol: an `accept` merchant + a `make` payer.

| App | Role | Port | Pairs with |
| --- | --- | --- | --- |
| `x402-accept-payments` | merchant | 4020 | `x402-make-payments` |
| `x402-make-payments` | payer | — | `x402-accept-payments` |
| `mpp-accept-payments` | merchant | 4030 | `mpp-make-payments` |
| `mpp-make-payments` | payer | — | `mpp-accept-payments` |

- Each app has its own `README.md` — read it before changing that app.
- Cross-cutting settlement/reliability guide: [`docs/settlement-proof.md`](./docs/settlement-proof.md).

## Setup, run, test

- Node.js 20+. Each app runs standalone (`cd x402-accept-payments`); the repo root has orchestration scripts to run every app together. On Node 20, MPP installs print `EBADENGINE` for transitive deps that declare `>=22` — install and stub runs still succeed; Node 22+ silences it. The x402 apps are unaffected.
- Run: merchants use `npm run dev`; payers use `npm run pay`. **Stub mode is the default** — the full `402 → pay → 200` flow runs locally with no gateway, facilitator, funds, or keys: the payer signs offline, so with `PRIVATE_KEY` unset it generates a throwaway key per run and logs the address. `PRIVATE_KEY` is still required when `RPC_URL` is set, which is what marks a run as real settlement.
- Verify from the repo root: `npm run typecheck` and `npm test` (smoke, no funds) run all four apps; `npm run test:e2e` runs the funded settlement — **both directions of the shipped corridor by default** (the hardened Base ↔ Tempo), needing `PRIVATE_KEY` + `DEST_ADDRESS` exported. The reverse leg spends pathUSD on Tempo (also covers gas — Tempo has no native gas token; fund via `cast rpc tempo_fundAddress <addr> --rpc-url https://rpc.moderato.tempo.xyz`); its source RPC defaults to the public Moderato endpoint (override `REVERSE_RPC_URL`). Set `SKIP_REVERSE=1` to limit a run to the forward leg. All four apps have their own `npm test`; the funded e2e lives in the `accept` apps and spawns the real `make` client, so it covers both sides. Tests are Node's built-in runner via `tsx`.
- `.env` is gitignored; copy from each app's `.env.example`. Never commit secrets.

## Domain gotchas (agents get these wrong)

- **Retry by re-attempting the purchase, not by replaying bytes.** Deadlines are absolute timestamps, so a signed payment goes stale within seconds. Fetch a fresh 402, re-sign, and keep the same purchase identifier — that is what makes the attempts one payment. See `*/src/purchase.ts`.
- **Never poll for settlement, and never hold a request open for it.** When settlement outruns the gateway's ~30s synchronous window, the merchant reports the payment as still settling and the payer's re-attempt collects the outcome. Both protocols behave identically here.
- **Pending and failed need opposite actions.** Pending → re-attempt the same purchase. Terminal failure → that identifier is spent for good; the same goods need a NEW purchase id. Never collapse them into "payment failed".
- **Key fulfilment on the receipt's `payment_id`, never on the request.** An identifier stops you being paid twice, not delivering twice. See `*/src/payments.ts`.
- **Real settlement is opt-in and moves real testnet funds:** `USE_STUB_FACILITATOR=false` (x402) / `USE_STUB_SUBMITTER=false` (MPP), or `RUN_REAL_E2E=1 PRIVATE_KEY=… DEST_ADDRESS=… npm test`. Startup guards refuse the placeholder MPP secret and an invalid `DEST_ADDRESS` in real mode — keep those guards intact.
- **Real settlement needs an `approve(Permit2)` per source token/chain** — both payers handle it via `ensureSourceApproval` when `RPC_URL` is set, so there is no manual step. Do not reintroduce one.
- Corridor contract addresses come from the gateway's `GET /v1/defaults` at startup — do not hardcode them.

## Conventions

- TypeScript, strict, ESM (`"type": "module"`); import local files with the `.js` extension.
- Every `src/**` file carries the [`SOURCE-HEADER.txt`](./SOURCE-HEADER.txt) copyright notice — preserve it; add it to new source files. (Markdown docs don't carry it.)
- Keep examples self-contained and readable: comments explain *why* (protocol/settlement intent), not *what*.
