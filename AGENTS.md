# AGENTS.md

Proprietary Atum reference examples for accepting and making payments over **x402** and **MPP**. Not open source — see [`LICENSE`](./LICENSE).

**Tested corridor:** Atum supports many corridors ([supported assets](https://docs.atumlabs.xyz/get-started/reference/supported-assets)); the corridor these examples are hardened against is **Base Sepolia USDC ↔ Tempo (Moderato) pathUSD**. The [root README](./README.md) is the source of truth for that hardened corridor and its status; each app's `.env.example` holds the exact chains, assets, and addresses it's wired to. Other supported corridors work but aren't hardened here — prefer the hardened one for anything you need to rely on.

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

- Node.js 20+. Each app runs standalone (`cd x402-accept-payments`); the repo root has orchestration scripts to run every app together.
- **`@atumlabs/*` packages are restricted npm (early access).** `npm install` fails without `npm login` under an account granted `@atumlabs` scope. This affects both `make` apps, `mpp-accept-payments`, and running any test (tests drive the sibling client).
- Run: merchants use `npm run dev`; payers use `npm run pay`. **Stub mode is the default** — the full `402 → pay → 200` flow runs locally with no gateway, facilitator, or funds.
- Verify from the repo root: `npm run typecheck` and `npm test` (smoke, no funds) run all four apps; `npm run test:e2e` runs the funded settlement — **both directions of the shipped corridor by default** (the hardened Base ↔ Tempo), needing `PRIVATE_KEY` + `DEST_ADDRESS` exported. The reverse leg spends pathUSD on Tempo (also covers gas — Tempo has no native gas token; fund via `cast rpc tempo_fundAddress <addr> --rpc-url https://rpc.moderato.tempo.xyz`); its source RPC defaults to the public Moderato endpoint (override `REVERSE_RPC_URL`). Set `SKIP_REVERSE=1` to limit a run to the forward leg. All four apps have their own `npm test`; the funded e2e lives in the `accept` apps and spawns the real `make` client, so it covers both sides. Tests are Node's built-in runner via `tsx`.
- `.env` is gitignored; copy from each app's `.env.example`. Never commit secrets.

## Domain gotchas (agents get these wrong)

- **Never rebuild a signed credential to retry.** Resend the *identical* bytes — settlement is idempotent on identical credentials; a new credential is a second payment. See `mpp-make-payments/src/retry.ts`.
- **x402 v1 has no async tail.** On slow corridors (notably Base ↔ Tempo), settlement can outrun the facilitator's ~30s synchronous window; `/settle` then returns `"async tail is not supported in v1"`. Treat that as **pending, not failed** — verify on-chain before retrying. Prefer **MPP** on slow corridors (its merchant polls the gateway to a terminal state).
- **Real settlement is opt-in and moves real testnet funds:** `USE_STUB_FACILITATOR=false` (x402) / `USE_STUB_SUBMITTER=false` (MPP), or `RUN_REAL_E2E=1 PRIVATE_KEY=… DEST_ADDRESS=… npm test`. Startup guards refuse the placeholder MPP secret and an invalid `DEST_ADDRESS` in real mode — keep those guards intact.
- **Real settlement needs a one-time `approve(Permit2)` per source token/chain** — `x402-make` aborts without it, `mpp-make` auto-approves; see the root README's "One-time setup — approve Permit2."
- Corridor contract addresses come from the gateway's `GET /defaults` at startup — do not hardcode them.

## Conventions

- TypeScript, strict, ESM (`"type": "module"`); import local files with the `.js` extension.
- Every `src/**` file carries the [`SOURCE-HEADER.txt`](./SOURCE-HEADER.txt) copyright notice — preserve it; add it to new source files. (Markdown docs don't carry it.)
- Keep examples self-contained and readable: comments explain *why* (protocol/settlement intent), not *what*.
