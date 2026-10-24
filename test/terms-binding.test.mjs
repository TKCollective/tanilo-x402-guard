// Binding the supplied terms to the payment's recipient, asset and network, not only its amount.
// A terms entry may declare the expected payTo, asset and network. A mismatch is contradicted and stops the payment
// before it is created. An expectation the entry does not declare is reported as not_evaluated and follows
// onNotEvaluated, like a resource with no terms. These are guard checks, never sent to the API, never in a receipt.
import { test } from "node:test";
import assert from "node:assert/strict";
import { taniloGuard } from "../src/index.js";
import { ctx, recorder, NOW, NET, USDC_BASE, URL_WEATHER, TERMS, mockApi } from "./helpers.mjs";

const USDT_BASE = "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2";          // a second USD asset the buyer has mapped
const NET_SEP = "eip155:84532", USDC_SEP = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const ASSETS = {
  [NET]: { [USDC_BASE]: { currency: "USD", decimals: 6 }, [USDT_BASE]: { currency: "USD", decimals: 6 } },
  [NET_SEP]: { [USDC_SEP]: { currency: "USD", decimals: 6 } },
};
const PAYEE = "0x1111111111111111111111111111111111111111", OTHER = "0x2222222222222222222222222222222222222222";
const CAP = { cap_id: "c", amount: "5.00", currency: "USD", scope: "per_purchase" };
const bound = (extra = {}) => [{ ...TERMS[0], payTo: PAYEE, asset: USDC_BASE, network: NET, ...extra }];
const unbound = () => [{ ...TERMS[0] }];
const guard = (o = {}) => taniloGuard({ mode: "local", terms: bound(), cap: CAP, assets: ASSETS, now: NOW, ...o });
const status = (d, ct) => d.checks.find((c) => c.check_type === ct)?.status;
const pay = (over) => ctx({ amount: "1000000", payTo: PAYEE, ...over });   // 1.00 USD: matches the supplied term

test("all three bindings declared and matching: verified, and the entry's expectations are recorded in the decision", async () => {
  const r = recorder();
  assert.equal(await guard(r)(pay({})), undefined);
  const d = r.decisions[0];
  for (const ct of ["payee_match", "asset_match", "network_match"]) {
    const c = d.checks.find((x) => x.check_type === ct);
    assert.equal(c.status, "verified", ct);
    assert.equal(c.guard_check, true, ct);
    assert.equal(c.rule_id, null, ct);
  }
  assert.deepEqual(d.checks.map((c) => c.check_type), ["contract_price_match", "spend_cap", "payee_match", "asset_match", "network_match"]);
  assert.deepEqual(d.inputs.terms_entry, { resource: URL_WEATHER, match: "exact", payTo: PAYEE, asset: USDC_BASE, network: NET });
});

test("payTo changed, amount unchanged: payee_match contradicted, stopped", async () => {
  const r = recorder();
  const out = await guard(r)(pay({ payTo: OTHER }));
  assert.equal(out?.abort, true);
  assert.match(out.reason, /payee_match contradicted/);
  assert.equal(status(r.decisions[0], "contract_price_match"), "verified");   // the price alone would have passed it
});

test("asset changed to another mapped USD asset, amount unchanged: asset_match contradicted, stopped, both assets named", async () => {
  const r = recorder();
  const out = await guard(r)(pay({ asset: USDT_BASE }));
  assert.equal(out?.abort, true);
  assert.match(out.reason, new RegExp(`asset_match contradicted: the payment is in ${USDT_BASE}, but the supplied terms name ${USDC_BASE} \\(a guard check, not a published Tanilo rule\\)`));
  const d = r.decisions[0];
  assert.equal(status(d, "contract_price_match"), "verified");
  assert.equal(status(d, "asset_match"), "contradicted");
  assert.ok(d.policy.applied.includes("asset_match contradicted: always abort"), JSON.stringify(d.policy.applied));
});

test("network changed to another mapped network, amount unchanged: network_match contradicted, stopped", async () => {
  const r = recorder();
  const out = await guard({ terms: bound({ asset: undefined }), ...r })(pay({ network: NET_SEP, asset: USDC_SEP }));
  assert.equal(out?.abort, true);
  assert.match(out.reason, new RegExp(`network_match contradicted: the payment is on ${NET_SEP}, but the supplied terms name ${NET}`));
  assert.equal(status(r.decisions[0], "contract_price_match"), "verified");
  assert.equal(status(r.decisions[0], "asset_match"), "not_evaluated");
});

test("asset addresses: EVM compared without regard to case; network compared exactly", async () => {
  assert.equal(await guard({ terms: bound({ asset: USDC_BASE.toLowerCase() }) })(pay({})), undefined);
  const out = await guard({ terms: bound({ network: "EIP155:8453" }) })(pay({}));
  assert.equal(out?.abort, true);
  assert.match(out.reason, /network_match contradicted/);
});

test("a binding mismatch stops the payment even with onNotEvaluated and onIndeterminate set to allow", async () => {
  const out = await guard({ onNotEvaluated: "allow", onIndeterminate: "allow" })(pay({ asset: USDT_BASE }));
  assert.equal(out?.abort, true);
  const out2 = await guard({ onNotEvaluated: "allow", onIndeterminate: "allow" })(pay({ network: NET_SEP, asset: USDC_SEP }));
  assert.equal(out2?.abort, true);
});

test("expectations the entry does not declare are not_evaluated and follow onNotEvaluated (default allow)", async () => {
  const r = recorder();
  assert.equal(await guard({ terms: unbound(), ...r })(pay({ payTo: OTHER, asset: USDT_BASE })), undefined);
  const d = r.decisions[0];
  for (const ct of ["payee_match", "asset_match", "network_match"]) assert.equal(status(d, ct), "not_evaluated", ct);
  assert.equal(d.checks.find((c) => c.check_type === "asset_match").reason, "no_asset_in_terms");
  assert.ok(d.policy.applied.includes("not_evaluated: onNotEvaluated = allow"));
});

test("…and with onNotEvaluated: \"block\" an undeclared recipient, asset or network stops the payment", async () => {
  const out = await guard({ terms: unbound(), onNotEvaluated: "block" })(pay({}));
  assert.equal(out?.abort, true);
  assert.match(out.reason, /payee_match not evaluated: the supplied terms name no payTo/);
  assert.match(out.reason, /asset_match not evaluated: the supplied terms name no asset/);
  assert.match(out.reason, /network_match not evaluated: the supplied terms name no network/);
  // declaring just one of them leaves the other two not_evaluated
  const out2 = await guard({ terms: bound({ asset: undefined, network: undefined }), onNotEvaluated: "block" })(pay({}));
  assert.equal(out2?.abort, true);
  assert.doesNotMatch(out2.reason, /payee_match/);
  assert.match(out2.reason, /asset_match not evaluated/);
});

test("no terms entry for the resource: the three bindings are not_evaluated too", async () => {
  const r = recorder();
  assert.equal(await guard({ terms: [], ...r })(pay({ payTo: OTHER })), undefined);
  for (const ct of ["payee_match", "asset_match", "network_match"]) {
    const c = r.decisions[0].checks.find((x) => x.check_type === ct);
    assert.equal(c.status, "not_evaluated", ct);
    assert.equal(c.reason, "no_terms_for_resource", ct);
  }
});

test("an unmapped asset is still indeterminate for the price, and contradicted by asset_match when the entry names the asset", async () => {
  const r = recorder();
  const out = await guard(r)(pay({ asset: "0x000000000000000000000000000000000000dEaD" }));
  assert.equal(out?.abort, true);
  assert.equal(status(r.decisions[0], "contract_price_match"), "indeterminate");
  assert.equal(status(r.decisions[0], "asset_match"), "contradicted");
});

test("config: asset and network, when given, must be non-empty strings", () => {
  assert.throws(() => taniloGuard({ terms: bound({ asset: "" }) }), /terms\[0\]\.asset must be a non-empty string/);
  assert.throws(() => taniloGuard({ terms: bound({ network: 8453 }) }), /terms\[0\]\.network must be a non-empty string/);
});

test("signed mode: the binding checks are never sent to the API and never in the receipt", async () => {
  const api = mockApi();
  const r = recorder();
  const out = await taniloGuard({ mode: "signed", terms: bound(), cap: CAP, assets: ASSETS, now: NOW, fetch: api.fetchImpl, ...r })(pay({}));
  assert.equal(out, undefined);
  assert.equal(api.calls.length, 1);
  assert.deepEqual(api.calls[0].body.checks.map((c) => c.check_type), ["contract_price_match", "spend_cap"]);
  assert.doesNotMatch(JSON.stringify(api.calls[0].body), /asset_match|network_match|payee_match/);
  const d = r.decisions[0];
  assert.doesNotMatch(Buffer.from(d.receipt.jws.payload, "base64url").toString(), /asset_match|network_match|payee_match/);
  for (const ct of ["payee_match", "asset_match", "network_match"]) assert.equal(d.checks.find((c) => c.check_type === ct).signed, undefined, ct);
});
