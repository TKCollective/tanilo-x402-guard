// subject.claim_hash: one check -> hash of its input object, the way tanilo-mcp and the hosted endpoint compute it;
// two checks -> hash of the checks array.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { taniloGuard } from "../src/index.js";
import { claimHashFor } from "../src/signed.js";
import { jcs } from "../src/rules/contract-price-jcs.js";
import { ASSETS, TERMS, NOW, ctx, mockApi } from "./helpers.mjs";

// Copied verbatim (types removed) from tanilo-mcp src/index.ts, function sha256Canonical (main 6bfd01e, lines
// 259-267). The hosted endpoint, tanilo-mcp-remote lib/tools.js lines 46-49 (main 6740a0b), is the same code.
async function sha256Canonical(value) {
  const { createHash } = await import("node:crypto");
  const canonical = (v) => {
    if (v === null || typeof v !== "object") return JSON.stringify(v);
    if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
    return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canonical(v[k])).join(",") + "}";
  };
  return "sha256-" + createHash("sha256").update(canonical(value), "utf8").digest("hex");
}

const CAP = { cap_id: "per-call", amount: "5.00", currency: "USD", scope: "per_purchase" };

test("one check: the guard's claim_hash equals tanilo-mcp's for the same input, byte for byte", async () => {
  for (const [opts, expected] of [
    [{ terms: TERMS }, "contract_price_match"],
    [{ cap: CAP }, "spend_cap"],
  ]) {
    const api = mockApi();
    await taniloGuard({ mode: "signed", assets: ASSETS, now: NOW, fetch: api.fetchImpl, ...opts })(ctx({ amount: "1000000" }));
    const body = api.calls[0].body;
    assert.deepEqual(body.checks.map((c) => c.check_type), [expected]);
    const mcp = await sha256Canonical(body.checks[0].input);
    assert.equal(body.subject.claim_hash, mcp);
    assert.match(mcp, /^sha256-[0-9a-f]{64}$/);
  }
});

test("one check: the published contract-price example input hashes to the value on the docs page", async () => {
  // tanilo-site docs/contract-price-check.html line 74 shows this claim_hash for this input.
  const input = {
    offer: { unit_price: "2.00", currency: "USD", unit: "call", quantity: "1", seller: "seller.example", sku: "api.weather.v1", offered_at: "2026-10-01T12:00:00Z" },
    terms: [{ agreement_id: "MSA-2026-014", version: "1", seller: "seller.example", product_scope: { skus: ["api.weather.v1"] }, currency: "USD", unit: "call", price_per_unit: "1.00", effective_from: "2026-01-01T00:00:00Z" }],
  };
  const guard = claimHashFor([{ check_type: "contract_price_match", input }]);
  assert.equal(guard, await sha256Canonical(input));
  assert.equal(guard, "sha256-e38f60d319e97a9244289b37b08483ea79802c47042fe32c005e066bc232e6cd");
});

test("one check: agreement on awkward strings (unicode, quotes, escapes) and key order", async () => {
  const input = { z: "é ☃ \u0001 \"q\" \\", a: { y: ["b", "a"], b: "x" }, "10": "n", "9": "m" };
  assert.equal(claimHashFor([{ check_type: "spend_cap", input }]), await sha256Canonical(input));
});

test("two checks: the hash of the checks array as sent", async () => {
  const api = mockApi();
  await taniloGuard({ mode: "signed", terms: TERMS, cap: CAP, assets: ASSETS, now: NOW, fetch: api.fetchImpl })(ctx({ amount: "1000000" }));
  const body = api.calls[0].body;
  assert.equal(body.checks.length, 2);
  const expected = "sha256-" + createHash("sha256").update(Buffer.from(jcs(body.checks), "utf8")).digest("hex");
  assert.equal(body.subject.claim_hash, expected);
  assert.notEqual(body.subject.claim_hash, await sha256Canonical(body.checks[0].input));
});
