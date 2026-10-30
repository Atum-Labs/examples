#!/usr/bin/env node
/**
 * The display.ts copies are identical by design (standalone packages).
 * A drift in one recording would make the others look like a different product.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const COPIES = [
  "mpp-make-payments/src/display.ts",
  "mpp-accept-payments/src/display.ts",
  "x402-make-payments/src/display.ts",
  "x402-accept-payments/src/display.ts",
  "pgc-make-payments/src/display.ts",
  "auth-session-token/src/display.ts",
];

test("every display.ts copy is identical", () => {
  const bodies = COPIES.map((rel) => readFileSync(join(root, rel), "utf8"));
  for (let i = 1; i < bodies.length; i++) {
    assert.equal(bodies[i], bodies[0], `${COPIES[i]} drifted from ${COPIES[0]}`);
  }
});
