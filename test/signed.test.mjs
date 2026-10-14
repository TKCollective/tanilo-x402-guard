// Signed mode against a mock of POST /v1/verify-facts. No live calls.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { taniloGuard } from "../src/index.js";
import { ASSETS, TERMS, NOW, ctx, recorder, mockApi, signedAnswer, hang, TEST_JWKS, TEST_KID } from "./helpers.mjs";

const capPP = { cap_id: "per-call", amount: "5.00", currency: "USD", scope: "per_purchase" };
const signed = (api, extra = {}) => ({ mode: "signed", terms: TERMS, cap: capPP, assets: ASSETS, now: NOW, fetch: api.fetchImpl, baseUrl: "https://api.test", ...extra });
const json = (status, body) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("verified: the signed receipt is passed to onDecision, and its signature checks out against jwks", async () => {
  const api = mockApi();
  const r = recorder();
  const out = await taniloGuard(signed(api, { jwks: TEST_JWKS, ...r }))(ctx({ amount: "1000000" }));
  assert.equal(out, undefined);
  assert.equal(api.calls.length, 1);
  assert.equal(api.calls[0].url, "https://api.test/v1/verify-facts");
  const body = api.calls[0].body;
  assert.deepEqual(body.checks.map((c) => c.check_type), ["contract_price_match", "spend_cap"]);
  assert.match(body.subject.claim_hash, /^sha256-[0-9a-f]{64}$/);
  const d = r.decisions[0];
  assert.equal(d.mode, "signed");
  assert.equal(d.receipt.kid, TEST_KID);
  assert.equal(d.receipt.signature_checked, true);
  assert.match(d.receipt.canonical_sha256, /^sha256-[0-9a-f]{64}$/);
  assert.equal(d.receipt.jws.signatures.length, 1);
  const payload = Buffer.from(d.receipt.jws.payload, "base64url");
  assert.equal(d.receipt.canonical_sha256, `sha256-${crypto.createHash("sha256").update(payload).digest("hex")}`);
  assert.ok(d.checks.every((c) => c.status === "verified" && c.signed === true));
  assert.match(d.checks[0].summary, /the offered price matches the supplied term under contract-price-match\/v0\.1 \(signed receipt\)/);
});

test("contradicted in signed mode aborts and still hands over the receipt", async () => {
  const r = recorder();
  const out = await taniloGuard(signed(mockApi(), r))(ctx({ amount: "2000000" }));
  assert.match(out.reason, /contract_price_match contradicted: offered 2\.00 USD above term price 1\.00 under contract-price-match\/v0\.1 \(signed receipt\)/);
  assert.ok(r.decisions[0].receipt.jws);
});

test("nothing to send (no terms for the resource, no cap): no call is made", async () => {
  const api = mockApi();
  const r = recorder();
  const out = await taniloGuard(signed(api, { cap: undefined, ...r }))(ctx({ url: "https://other.example/x" }));
  assert.equal(out, undefined);
  assert.equal(api.calls.length, 0);
  assert.equal(r.decisions[0].receipt, null);
});

test("input the published rule cannot read is not sent", async () => {
  const api = mockApi();
  const bad = [{ ...TERMS[0], terms: [{ ...TERMS[0].terms[0], price_per_unit: 1 }] }];   // a JSON number: refused by the rule
  const r = recorder();
  const out = await taniloGuard(signed(api, { terms: bad, ...r }))(ctx());
  assert.equal(out.abort, true);
  assert.deepEqual(api.calls[0].body.checks.map((c) => c.check_type), ["spend_cap"]);
  assert.equal(r.decisions[0].checks[0].reason, "input_invalid");
});

const FAILURES = {
  timeout: hang,
  "HTTP 500": () => json(500, { error: "verify_facts_internal_error" }),
  "HTTP 503 not_signed": () => json(503, { status: "not_signed", verdict: "act", check_results: [] }),
  "HTTP 422": () => json(422, { error: "claim_not_deterministic" }),
  "malformed JSON": () => json(200, "{not json"),
  "unsigned 200 (results but no jws)": (body) => { const a = signedAnswer(body); delete a.jws; return json(200, a); },
  "network error": () => { throw new TypeError("fetch failed"); },
  "jws with a wrong canonical_sha256": (body) => json(200, { ...signedAnswer(body), canonical_sha256: "sha256-" + "0".repeat(64) }),
  "a check missing from the signed payload": (body) => json(200, signedAnswer(body, { tamper: (cr) => cr.pop() })),
};

for (const [name, behave] of Object.entries(FAILURES)) {
  test(`unavailable (${name}): blocked by default, allowed under onUnavailable: allow, never a made-up verdict`, async () => {
    for (const policy of ["block", "allow"]) {
      const r = recorder();
      const out = await taniloGuard(signed(mockApi(behave), { onUnavailable: policy, timeoutMs: 50, ...r }))(ctx({ amount: "1000000" }));
      const d = r.decisions[0];
      assert.ok(d.checks.every((c) => c.status === "unavailable"), JSON.stringify(d.checks.map((c) => c.status)));
      assert.equal(d.receipt, null);
      if (policy === "block") {
        assert.equal(out.abort, true);
        assert.match(out.reason, /unavailable: .*no result is assumed/);
      } else assert.equal(out, undefined);
      assert.deepEqual(d.policy.applied, [`unavailable: onUnavailable = ${policy}`]);
    }
  });
}

test("the timeout is honoured", async () => {
  const t0 = Date.now();
  const out = await taniloGuard(signed(mockApi(hang), { timeoutMs: 100 }))(ctx());
  const ms = Date.now() - t0;
  assert.equal(out.abort, true);
  assert.match(out.reason, /no answer within 100 ms \(timeout\)/);
  assert.ok(ms >= 90 && ms < 1500, `took ${ms} ms`);
});

test("a receipt signed by a key not in the supplied jwks is unavailable", async () => {
  const other = crypto.generateKeyPairSync("ed25519").privateKey;
  const api = mockApi((body) => json(200, signedAnswer(body, { key: other })));
  const out = await taniloGuard(signed(api, { jwks: TEST_JWKS }))(ctx());
  assert.match(out.reason, /signature does not verify against the supplied key set/);
});

test("a signed state that differs from the published rule on the same input is not used", async () => {
  const api = mockApi((body) => json(200, signedAnswer(body, { tamper: (cr) => { cr[0].state = "verified"; delete cr[0].failure_reason; } })));
  const r = recorder();
  const out = await taniloGuard(signed(api, r))(ctx({ amount: "2000000" }));
  assert.equal(out.abort, true);
  assert.ok(r.decisions[0].checks.every((c) => c.status === "unavailable" && c.reason === "service_differs_from_rule"));
});

test("the unsigned wrapper is never read for the verdict", async () => {
  // The wrapper says act; the signed payload says contradicted. The guard follows the signed payload.
  const api = mockApi((body) => json(200, { ...signedAnswer(body), verdict: "act", check_results: [] }));
  const out = await taniloGuard(signed(api))(ctx({ amount: "2000000" }));
  assert.match(out.reason, /contradicted/);
});

test("signed mode never throws on malformed requirements", async () => {
  const api = mockApi();
  const g = taniloGuard(signed(api));
  for (const c of [undefined, null, {}, { selectedRequirements: {} }, ctx({ amount: "x" })]) {
    const out = await g(c);
    assert.equal(out.abort, true);
  }
  assert.equal(api.calls.length, 0);
});
