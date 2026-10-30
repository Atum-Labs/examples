/*
 * Copyright (c) 2026 Atum Labs, Inc.
 * SPDX-License-Identifier: MIT
 */

// An in-process stand-in for the Atum authorization service, for a stub run with
// USE_SESSION_TOKEN=true: it needs no credential, no network and no keys.
//
// It checks the shape of what the client sends: the presentation must answer a nonce it issued,
// once, for its own environment, from the holder its credentials name, and carry a Known to Atum
// credential. It does NOT verify signatures or the credential's issuer; the real service does both,
// and refuses a credential it did not issue.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";

const TOKEN_EXCHANGE_GRANT = "urn:ietf:params:oauth:grant-type:token-exchange";
const PRESENTATION_TOKEN_TYPE = "urn:atum:params:oauth:token-type:ldp_vp";
const ACCESS_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:access_token";
export const STUB_TOKEN_LIFETIME_SECONDS = 3600;

export interface StubAuthOptions {
  /** Refuse every token exchange as unavailable, to show a payment going ahead without a session. */
  refuse?: boolean;
}

export interface StubAuth {
  /** Base URL of the authorization service. */
  url: string;
  /** Nonces issued so far, one per session requested. */
  noncesIssued: number;
  /** Tokens issued so far. */
  tokensIssued: string[];
  close(): Promise<void>;
}

/** A Known to Atum credential for `address`, shaped like the one Atum issues. Unsigned: stub only. */
export function stubCredential(address: string): Record<string, unknown> {
  const now = new Date();
  return {
    "@context": [
      "https://www.w3.org/2018/credentials/v1",
      "https://schemas.atum.xyz/credentials/known-to-atum/v1",
    ],
    id: `urn:uuid:${crypto.randomUUID()}`,
    type: ["VerifiableCredential", "KnownToAtumVerifiableCredential"],
    issuer: "did:web:stub.invalid",
    issuanceDate: now.toISOString(),
    expirationDate: new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(),
    credentialSubject: { id: `did:pkh:eip155:84532:${address.toLowerCase()}`, role: "psp" },
    proof: {
      type: "EcdsaSecp256k1RecoverySignature2020",
      created: now.toISOString(),
      verificationMethod: "did:web:stub.invalid#issuer-key-1",
      proofPurpose: "assertionMethod",
    },
  };
}

export async function startStubAuth(options: StubAuthOptions = {}): Promise<StubAuth> {
  const outstanding = new Set<string>();
  let expectedDomain = "";

  const stub: StubAuth = {
    url: "",
    noncesIssued: 0,
    tokensIssued: [],
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://stub");

      if (req.method === "POST" && url.pathname === "/v1/auth/nonce") {
        const nonce = randomBytes(32).toString("base64url");
        outstanding.add(nonce);
        stub.noncesIssued += 1;
        send(res, 200, { nonce, expected_domain: expectedDomain, expires_in: 300 }, { "Cache-Control": "no-store" });
        return;
      }

      if (req.method === "POST" && url.pathname === "/v1/auth/token") {
        const form = new URLSearchParams(await readBody(req));
        if (
          form.get("grant_type") !== TOKEN_EXCHANGE_GRANT ||
          form.get("subject_token_type") !== PRESENTATION_TOKEN_TYPE
        ) {
          return refuse(res, 400, "INVALID_REQUEST", "Not a token exchange of a presentation.");
        }
        const presentation = JSON.parse(form.get("subject_token") ?? "null") as {
          holder?: string;
          verifiableCredential?: Array<{ type?: string[]; credentialSubject?: { id?: string } }>;
          proof?: { challenge?: string; domain?: string; proofPurpose?: string };
        } | null;
        const challenge = presentation?.proof?.challenge ?? "";
        // Taken whether or not the rest holds, as the real service does: a refused presentation
        // spends its nonce, so a retry needs a new one.
        if (!outstanding.delete(challenge)) {
          return refuse(res, 401, "CHALLENGE_EXPIRED", "The nonce is unknown, expired or already used.");
        }
        const credentials = presentation?.verifiableCredential ?? [];
        if (
          presentation?.proof?.domain !== expectedDomain ||
          presentation?.proof?.proofPurpose !== "authentication" ||
          credentials.length === 0 ||
          credentials.some((c) => c.credentialSubject?.id !== presentation?.holder)
        ) {
          return refuse(res, 401, "INVALID_PRESENTATION", "The presentation does not answer this nonce for this holder.");
        }
        if (!credentials.some((c) => c.type?.includes("KnownToAtumVerifiableCredential"))) {
          return refuse(res, 403, "CREDENTIAL_MISSING", "No Known to Atum credential was presented.");
        }
        if (options.refuse) {
          return refuse(res, 503, "SERVICE_UNAVAILABLE", "The stub was started to refuse every session.");
        }
        const accessToken = `stub.${randomBytes(24).toString("base64url")}`;
        stub.tokensIssued.push(accessToken);
        send(
          res,
          200,
          {
            access_token: accessToken,
            issued_token_type: ACCESS_TOKEN_TYPE,
            token_type: "Bearer",
            expires_in: STUB_TOKEN_LIFETIME_SECONDS,
          },
          { "Cache-Control": "no-store", Pragma: "no-cache" },
        );
        return;
      }

      refuse(res, 404, "NOT_FOUND", "The requested resource was not found.");
    } catch {
      refuse(res, 400, "INVALID_REQUEST", "The stub could not read the request.");
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  stub.url = `http://127.0.0.1:${port}`;
  // A did:web names the environment, with the port percent-encoded, as the real service's does.
  expectedDomain = `did:web:127.0.0.1%3A${port}`;
  return stub;
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

function refuse(res: ServerResponse, status: number, code: string, message: string): void {
  send(res, status, { code, message, domain: "AUTHORIZATION_SERVICE" }, { "Cache-Control": "no-store" });
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}
