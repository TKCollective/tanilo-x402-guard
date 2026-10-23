// x402-foundation/x402 issue #3866 (igor-vii, 2026-10-21; Argus-Agent-Test-Lab scenario S-BS-06, "oversize amount"):
// the official @x402/fetch client signs an authorization for ANY amount the 402 declares, and the caller's
// spend limit is the only thing that can stop a ×10 overcharge. These tests run the guard's hook on the
// issue's own numbers, with no network and no keys. They do not claim anything about on-chain settlement.
//
//   canonical price 10000 atomic units (0.01 USDC, 6 decimals), inflated requirement 100000 (0.10 USDC),
//   network eip155:84532 (Base Sepolia), asset 0x036CbD53842c5426634e7929541eC2318f3dCF7e, payTo 0x9999…,
//   caller's per-payment cap $1 (which a 0.10 payment passes).
import { test } from "node:test";
import assert from "node:assert/strict";
import { taniloGuard } from "../src/index.js";
import { ctx, recorder, NOW } from "./helpers.mjs";

const NET = "eip155:84532";
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const PAY_TO = "0x9999999999999999999999999999999999999999";
const URL = "http://127.0.0.1:4021/weather";
const ASSETS = { [NET]: { [USDC]: { currency: "USD", decimals: 6 } } };
const CANONICAL = "10000", INFLATED_X10 = "100000";
const TERMS = [{ resource: URL, seller: "seller.example", sku: "api.weather.v1", unit: "call",
  terms: [{ agreement_id: "BLOCK-B-001", version: "1", seller: "seller.example", product_scope: { skus: ["api.weather.v1"] }, currency: "USD", unit: "call", price_per_unit: "0.01", effective_from: "2026-01-01T00:00:00Z" }] }];
const CAP = { cap_id: "per-payment", amount: "1.00", currency: "USD", scope: "per_purchase" };   // the issue's maxAmountPerPayment: "$1"
const sbs06 = (amount) => ctx({ amount, url: URL, asset: USDC, network: NET, payTo: PAY_TO });
const status = (d, ct) => d.checks.find((c) => c.check_type === ct)?.status;

test("S-BS-06: the ×10 inflated requirement is stopped by the contract-price check, under the $1 cap", async () => {
  const r = recorder();
  const out = await taniloGuard({ mode: "local", terms: TERMS, cap: CAP, assets: ASSETS, now: NOW, ...r })(sbs06(INFLATED_X10));
  assert.equal(out?.abort, true);
  assert.match(out.reason, /contract_price_match contradicted: offered 0\.10 USD above term price 0\.01/);
  const d = r.decisions[0];
  assert.equal(d.allow, false);
  assert.equal(status(d, "contract_price_match"), "contradicted");
  assert.equal(status(d, "spend_cap"), "verified", "0.10 is within the $1 cap: the cap alone would not have stopped it");
  assert.equal(d.checks.find((c) => c.check_type === "contract_price_match").evidence.offer_is, "above_term_price");
  assert.equal(d.receipt, null, "local mode: nothing signed, nothing sent");
});

test("S-BS-06 control: the canonical requirement is allowed by both checks", async () => {
  const r = recorder();
  const out = await taniloGuard({ mode: "local", terms: TERMS, cap: CAP, assets: ASSETS, now: NOW, ...r })(sbs06(CANONICAL));
  assert.equal(out, undefined);
  assert.equal(status(r.decisions[0], "contract_price_match"), "verified");
  assert.equal(status(r.decisions[0], "spend_cap"), "verified");
});

test("the issue's point, reproduced: a cap alone lets the ×10 overcharge through (guard with no terms, default policy)", async () => {
  const r = recorder();
  const out = await taniloGuard({ mode: "local", cap: CAP, assets: ASSETS, now: NOW, ...r })(sbs06(INFLATED_X10));
  assert.equal(out, undefined, "no terms supplied: contract_price_match is not evaluated and onNotEvaluated defaults to allow");
  assert.equal(status(r.decisions[0], "contract_price_match"), "not_evaluated");
  assert.equal(status(r.decisions[0], "spend_cap"), "verified");
});

test("…and onNotEvaluated: \"block\" stops any payment for which no term was supplied", async () => {
  const out = await taniloGuard({ mode: "local", cap: CAP, assets: ASSETS, now: NOW, onNotEvaluated: "block" })(sbs06(INFLATED_X10));
  assert.equal(out?.abort, true);
  assert.match(out.reason, /contract_price_match not evaluated: no supplied terms for /);
});

test("the cap stops only what exceeds it: ×1000 (10.00 USD) is contradicted by both checks", async () => {
  const r = recorder();
  const out = await taniloGuard({ mode: "local", terms: TERMS, cap: CAP, assets: ASSETS, now: NOW, ...r })(sbs06("10000000"));
  assert.equal(out?.abort, true);
  assert.equal(status(r.decisions[0], "contract_price_match"), "contradicted");
  assert.equal(status(r.decisions[0], "spend_cap"), "contradicted");
});

test("#3660's sign-flipped case: a zero amount is contradicted as below the term price, not allowed as cheap", async () => {
  const out = await taniloGuard({ mode: "local", terms: TERMS, cap: CAP, assets: ASSETS, now: NOW })(sbs06("0"));
  assert.equal(out?.abort, true);
  assert.match(out.reason, /offered 0(\.00)? USD below term price 0\.01/);
});

test("an unmapped asset on the inflated requirement is indeterminate and blocked by default, never silently paid", async () => {
  const r = recorder();
  const out = await taniloGuard({ mode: "local", terms: TERMS, cap: CAP, assets: ASSETS, now: NOW, ...r })(ctx({ amount: INFLATED_X10, url: URL, asset: "0x000000000000000000000000000000000000dEaD", network: NET, payTo: PAY_TO }));
  assert.equal(out?.abort, true);
  assert.equal(status(r.decisions[0], "contract_price_match"), "indeterminate");
});
