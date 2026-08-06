/*
 * Copyright (c) 2026 Atum Labs, Inc. All rights reserved.
 * Proprietary reference implementation; not open source.
 * Access and use are governed by the LICENSE file at the root of this repository.
 * Do not remove, alter, or obscure this notice.
 */

// A record of what this merchant has delivered, keyed by the payment that funded it.
//
// A purchase identifier stops you being PAID twice; it does not stop you DELIVERING
// twice. If a payer reuses one identifier across two genuine purchases, the second
// resolves onto the first payment: the gateway replays that payment's receipt and charges
// nothing, so a merchant keying delivery on the request sees a valid receipt and ships
// again. Keying on the receipt's payment id closes that, and makes an honest retry safe
// too — a payer that never received the 200 re-attempts and is served the same result.
//
// In production this is your database: the payments or orders table you already keep for
// reconciliation. The in-memory map below is a stand-in so the example runs with no
// infrastructure.

/** What was delivered for one payment. */
export interface FulfilledPayment<T> {
  /** The Atum payment id from the settlement receipt — this record's key. */
  readonly paymentId: string;
  /** The response body that was served, replayed verbatim on a later attempt. */
  readonly result: T;
  /** When it was first delivered (ms epoch). */
  readonly fulfilledAt: number;
}

export class PaymentLedger<T> {
  readonly #fulfilled = new Map<string, FulfilledPayment<T>>();
  readonly #now: () => number;

  constructor(options: { now?: () => number } = {}) {
    this.#now = options.now ?? Date.now;
  }

  /** What was delivered for this payment, or `undefined` if nothing has been. */
  served(paymentId: string): FulfilledPayment<T> | undefined {
    return this.#fulfilled.get(paymentId);
  }

  /**
   * Record a delivery against the payment that funded it. The first record wins, so
   * `fulfilledAt` keeps saying when the goods actually went out.
   */
  record(paymentId: string, result: T): FulfilledPayment<T> {
    const existing = this.#fulfilled.get(paymentId);
    if (existing) return existing;
    const record: FulfilledPayment<T> = { paymentId, result, fulfilledAt: this.#now() };
    this.#fulfilled.set(paymentId, record);
    return record;
  }

  /** How many distinct payments have been fulfilled. */
  get size(): number {
    return this.#fulfilled.size;
  }
}
