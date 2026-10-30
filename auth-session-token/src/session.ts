/*
 * Copyright (c) 2026 Atum Labs, Inc.
 * SPDX-License-Identifier: MIT
 */

import {
  requestSessionToken,
  type RequestSessionTokenOptions,
  type SessionToken,
} from "@atumlabs/payment-gateway-client/signing";

// A session token cannot be refreshed: when it is close to expiring, the holder starts a new
// session. Renewing a couple of minutes early keeps a request from leaving with a token that
// expires before the gateway reads it.
export const RENEW_BEFORE_MS = 2 * 60 * 1000;

/**
 * Holds the current session token and replaces it before it expires.
 *
 * Pass `() => sessions.current()` as the Payment Gateway client's `TOKEN`, and every call it makes
 * carries a live `Authorization: Bearer` token without the caller tracking expiry.
 */
export class SessionTokens {
  #token: SessionToken | undefined;
  #renewing: Promise<SessionToken> | undefined;

  constructor(
    private readonly options: RequestSessionTokenOptions,
    private readonly now: () => number = Date.now,
  ) {}

  /** The bearer token to send now, requesting a new session if the held one is about to expire. */
  async current(): Promise<string> {
    if (this.#token && !this.#dueForRenewal(this.#token)) return this.#token.accessToken;
    // One renewal at a time: concurrent callers share it rather than each spending a nonce.
    this.#renewing ??= requestSessionToken(this.options).finally(() => {
      this.#renewing = undefined;
    });
    this.#token = await this.#renewing;
    return this.#token.accessToken;
  }

  /** The token currently held, if a session has been established. */
  get token(): SessionToken | undefined {
    return this.#token;
  }

  #dueForRenewal(token: SessionToken): boolean {
    // A token whose whole life is shorter than the margin (a credential close to its own expiry
    // caps it) is renewed at its halfway point instead, so it is still used at least once.
    const margin = Math.min(RENEW_BEFORE_MS, (token.expiresIn * 1000) / 2);
    return token.expiresAt.getTime() - this.now() <= margin;
  }
}
