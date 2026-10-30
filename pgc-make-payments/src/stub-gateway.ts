/*
 * Copyright (c) 2026 Atum Labs, Inc.
 * SPDX-License-Identifier: MIT
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

// In-process Payment Gateway stand-in for a stub run. It speaks the three
// endpoints prepare → submit → status actually hit, and nothing else.
//
// It does not verify signatures — that is the SDK's job. It only proves the
// example completes the handshake end to end without a hosted gateway, funds,
// or keys. Contract addresses are placeholders; a real prepare reads them from
// GET /v1/defaults on the live gateway instead.

const STUB_PAYMENT_ID = "pay_stub_0000000000000000";

const STUB_DEFAULTS = {
  quote_selector: "0x0000000000000000000000000000000000000004",
  escrow_contract: "0x0000000000000000000000000000000000000001",
  fulfillment_proxy: "0x0000000000000000000000000000000000000003",
  fulfillment_verifier: {
    account: "0x0000000000000000000000000000000000000005",
    endpoint: "http://127.0.0.1/veri-fill",
  },
};

/** How a stub payment ends: delivered, failed, refunded, or waiting on its refund. */
export type StubOutcome = "completed" | "failed" | "refunded" | "refund_available";

export const STUB_OUTCOMES: readonly StubOutcome[] = ["completed", "failed", "refunded", "refund_available"];

export interface StubGatewayOptions {
  /** First N status checks report `pending`, then terminal (`settleAs`). Default: 0. */
  pendingAttempts?: number;
  /** The status this payment ends in, once pendingAttempts is exhausted. Default: "completed". */
  settleAs?: StubOutcome;
}

export interface StubGateway {
  url: string;
  /** The request_id on each POST /v1/payments, in order. */
  submitted: () => string[];
  /** The body of each POST /v1/payments, in order: what a real gateway would have been asked to settle. */
  submittedRequests: () => Record<string, unknown>[];
  close: () => Promise<void>;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

// What a completed payment lists under `transactions`: the payer's deposit on the source
// chain and the payout on the destination chain.
const STUB_TRANSACTIONS = {
  deposit: { transaction_hash: `0x${"11".repeat(32)}`, chain_id: "eip155:84532" },
  fulfillment: { transaction_hash: `0x${"22".repeat(32)}`, chain_id: "eip155:42431" },
};

// completed carries its transactions; failed carries an error instead — mirrors the real
// gateway, where a failed payment never reaches fulfillment. A refunded payment or one waiting
// on its refund was not delivered either, so it lists only the deposit.
function terminalBody(replay: boolean, status: StubOutcome) {
  if (status === "refunded" || status === "refund_available") {
    return {
      payment_id: STUB_PAYMENT_ID,
      status,
      idempotent_replay: replay,
      quote_id: "quote_stub",
      transactions: { deposit: STUB_TRANSACTIONS.deposit },
    };
  }
  if (status === "failed") {
    return {
      payment_id: STUB_PAYMENT_ID,
      status: "failed",
      idempotent_replay: replay,
      quote_id: "quote_stub",
      error: { code: "SETTLEMENT_FAILED", message: "stub: settlement forced to fail (settleAs)" },
    };
  }
  return {
    payment_id: STUB_PAYMENT_ID,
    status: "completed",
    idempotent_replay: replay,
    quote_id: "quote_stub",
    transactions: STUB_TRANSACTIONS,
  };
}

/**
 * Start a loopback gateway the client can prepare, submit, and poll against.
 */
export function startStubGateway(options: StubGatewayOptions = {}): Promise<StubGateway> {
  const pendingAttempts = options.pendingAttempts ?? 0;
  const settleAs = options.settleAs ?? "completed";
  const submitted: string[] = [];
  const submittedRequests: Record<string, unknown>[] = [];
  const payments = new Map<string, { requestId: string; statusChecks: number }>();

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const method = req.method ?? "GET";

      if (method === "GET" && url.pathname === "/v1/defaults") {
        const chainId = url.searchParams.get("chain_id") ?? "eip155:84532";
        send(res, 200, { chain_id: chainId, ...STUB_DEFAULTS });
        return;
      }

      if (method === "POST" && url.pathname === "/v1/payments") {
        const raw = await readBody(req);
        const body = raw === "" ? {} : (JSON.parse(raw) as { request_id?: string });
        const requestId = body.request_id ?? "(unnamed)";
        submitted.push(requestId);
        submittedRequests.push(body);

        const existing = [...payments.values()].find((p) => p.requestId === requestId);
        if (existing) {
          send(
            res,
            200,
            pendingAttempts > 0 && existing.statusChecks < pendingAttempts
              ? { payment_id: STUB_PAYMENT_ID, status: "pending", idempotent_replay: true }
              : terminalBody(true, settleAs),
          );
          return;
        }

        payments.set(STUB_PAYMENT_ID, { requestId, statusChecks: 0 });
        send(
          res,
          200,
          pendingAttempts > 0
            ? { payment_id: STUB_PAYMENT_ID, status: "pending", idempotent_replay: false }
            : terminalBody(false, settleAs),
        );
        return;
      }

      const statusMatch = url.pathname.match(/^\/v1\/payments\/([^/]+)\/status$/);
      if (method === "GET" && statusMatch) {
        const paymentId = decodeURIComponent(statusMatch[1]);
        const payment = payments.get(paymentId);
        if (!payment) {
          send(res, 404, { code: "NOT_FOUND", message: `no payment ${paymentId}` });
          return;
        }
        payment.statusChecks += 1;
        if (payment.statusChecks <= pendingAttempts) {
          send(res, 200, { payment_id: paymentId, status: "pending" });
          return;
        }
        const { idempotent_replay: _replay, quote_id: _quote, ...status } = terminalBody(false, settleAs);
        send(res, 200, status);
        return;
      }

      send(res, 404, {
        code: "NOT_FOUND",
        message: `stub gateway serves no ${method} ${url.pathname}`,
      });
    })().catch((err: unknown) => {
      send(res, 500, { code: "INTERNAL_ERROR", message: (err as Error).message });
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        submitted: () => submitted.slice(),
        submittedRequests: () => submittedRequests.map((request) => ({ ...request })),
        close: () =>
          new Promise<void>((closeResolve, closeReject) => {
            server.closeAllConnections();
            server.close((err) => (err ? closeReject(err) : closeResolve()));
          }),
      });
    });
  });
}
