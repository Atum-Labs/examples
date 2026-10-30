# auth-session-token

An example client that requests an Atum **session token** and sends it on Payment Gateway calls, using [`@atumlabs/payment-gateway-client`](https://www.npmjs.com/package/@atumlabs/payment-gateway-client).

A session token tells the Payment Gateway which wallet is calling. It is not permission to move money: every payment still carries its own signature. See [Session tokens](https://docs.atum.xyz/get-started/identity/session-tokens) for what the token is and what it is for.

> Licensed under MIT — see the [root LICENSE](../LICENSE). The packages, hosts and values shown here are testnet defaults. Atum makes no promise of support, maintenance, compatibility, or production availability.

## How it works

1. **Nonce.** The client asks the authorization service for a single-use nonce (`POST /v1/auth/nonce`). The answer also names the environment (`expected_domain`) the presentation must be bound to.
2. **Presentation.** It signs a presentation of your Known to Atum credential that answers that nonce, with the key of the wallet the credential is issued to. The key signs locally and never leaves the process.
3. **Token.** It exchanges the presentation for a bearer token (`POST /v1/auth/token`).
4. **Use.** It passes `TOKEN: () => sessions.current()` to the Payment Gateway client, so every gateway call sends `Authorization: Bearer <token>`.

Steps 1–3 are one call, `requestSessionToken`. Step 4 is [`src/session.ts`](src/session.ts): `SessionTokens` holds the current token and renews it shortly before it expires.

## Renewal, not refresh

A session token has no refresh. It is valid for `expires_in` seconds, and before then you start a **new session**: a fresh nonce, a new presentation, a new token. `SessionTokens` does that for you two minutes before expiry, and concurrent callers share one renewal rather than each spending a nonce.

Never resend a presentation. A nonce is single use, and a refused exchange spends it, so any retry is a new call to `requestSessionToken`.

## Prerequisites

- Node.js 20+
- For a real session (not the stub):
  - the **Known to Atum** credential Atum issued to your wallet during onboarding, saved as JSON;
  - that wallet's private key.

A testnet credential is valid only on testnet, and a mainnet credential only on mainnet. The credential is issued to an EVM wallet (`did:pkh:eip155:…`), and that wallet's key is the one that signs.

## Quickstart

### 1. Install dependencies

```bash
npm install
```

### 2. Run against the stub

```bash
npm run token
```

No `.env` is needed. The client starts an in-process authorization service and gateway, signs with a throwaway wallet, and prints the token's lifetime and the gateway call that carried it. The stub checks the shape of what you send — the nonce, the environment, the holder, the credential type — but not signatures or the issuer; the real service checks both.

### 3. Request a real session

```bash
cp .env.example .env
```

Set in `.env`:

```bash
USE_STUB_AUTH=false
PRIVATE_KEY=0x...                  # the wallet your credential is issued to
CREDENTIAL_FILE=./credential.json  # your Known to Atum credential (gitignored)
```

`AUTH_URL` and `GATEWAY_URL` default to production-testnet. Then:

```bash
npm run token
```

## Errors

A refusal from the authorization service throws `SessionTokenError`, carrying the HTTP `status`, the error `code` and, when the service sent one, `retryAfterSeconds`. The client prints all three. Each code is described in [Errors](https://docs.atum.xyz/errors). A credential issued to a different wallet than `PRIVATE_KEY` is refused before anything is sent.

## Testing

```bash
npm test
```

Runs the client as a separate process against the stub, and checks the pieces it is built from: the token is sent as a bearer token, it is reused until shortly before expiry and then replaced by a new session, concurrent callers share one renewal, and refusals surface with the service's code. No credential, network or key is needed.

## Project structure

```
auth-session-token/
├── src/
│   ├── client.ts        # the example: a session, then a gateway call that carries it
│   ├── session.ts       # SessionTokens: hold the token, renew it before expiry
│   ├── stub-auth.ts     # in-process authorization service and gateway for stub runs
│   ├── display.ts       # terminal output shared by every example
│   └── smoke.test.ts    # smoke tests against the stub
├── .env.example
└── package.json
```

## Further reading

- [Session tokens](https://docs.atum.xyz/get-started/identity/session-tokens) — what the token is, how to get one, and how to use it
- [Credentials](https://docs.atum.xyz/get-started/identity/credentials) — the Known to Atum credential
- [Know Your Agent](https://docs.atum.xyz/get-started/identity/know-your-agent) — why a session is not a payment
