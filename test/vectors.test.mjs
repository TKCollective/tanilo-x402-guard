// The published CC0 vectors (tanilo-receipt-spec checks/, copied unchanged into test/vectors/).
// 1. Every vector through the in-process rules: the exact published result.
// 2. Every vector the guard can reproduce from an x402 payment, through the guard in local mode and in signed
//    mode (mock API): the same state and reason as the vector, and the same decision in both modes.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { taniloGuard, evaluateLocal } from "../src/index.js";
import { mockApi } from "./helpers.mjs";

const load = (f) => JSON.parse(fs.readFileSync(new URL(`./vectors/${f}`, import.meta.url), "utf8"));
const CPM = load("contract-price.vectors.json");
const SPC = load("spend-cap.vectors.json");

test("the vector files are the published ones", () => {
  assert.equal(CPM.rule_id, "contract-price-match/v0.1");
  assert.equal(SPC.rule_id, "spend-cap/v0.1");
  assert.equal(CPM.cases.length, 82);
  assert.equal(SPC.cases.length, 59);
});

for (const [name, file, ct] of [["contract-price", CPM, "contract_price_match"], ["spend-cap", SPC, "spend_cap"]]) {
  test(`${name}: all ${file.cases.length} vectors give the published result in process`, () => {
    for (const v of file.cases) {
      const got = evaluateLocal(ct, v.input);
      if (v.result.invalid) {
        assert.equal(got.invalid, true, v.id);
        assert.equal(got.path, v.result.member, v.id);
      } else {
        assert.deepEqual(got, v.result, v.id);
      }
    }
  });
}

// ── through the guard ───────────────────────────────────────────────────────────────────────────────────

const NET = "eip155:8453", ASSET = "0x00000000000000000000000000000000000000aa", RES_URL = "https://seller.example/v";
const DEC = 16;

function scaled(s, places) {   // exact decimal string -> BigInt at `places`
  const [i, f = ""] = s.split(".");
  return BigInt(i) * 10n ** BigInt(places) + BigInt(f.padEnd(places, "0"));
}
function toDec(v, places) {
  const S = 10n ** BigInt(places);
  const f = (v % S).toString().padStart(places, "0").replace(/0+$/, "");
  return f ? `${v / S}.${f}` : `${v / S}`;
}
const fracDigits = (s) => (s.split(".")[1] || "").replace(/0+$/, "").length;

// An x402 payment whose amount is unit_price x quantity, in an asset mapped to the offer's currency with 16 decimals.
function paymentFor(offer) {
  const total = (scaled(offer.unit_price, 8) * scaled(offer.quantity, 8));          // at 16 places
  const req = { scheme: "exact", network: NET, asset: ASSET, amount: total.toString(), payTo: "0x1", maxTimeoutSeconds: 60, extra: {} };
  return { total: toDec(total, 16), context: { paymentRequired: { x402Version: 2, resource: { url: RES_URL }, accepts: [req] }, selectedRequirements: req } };
}

function cpmGuardCase(v) {
  if (v.result.invalid) return { skip: "invalid input (the guard never sends input the rule cannot read)" };
  const o = v.input.offer;
  if (Object.keys(o).sort().join() !== "currency,offered_at,quantity,seller,sku,unit,unit_price") return { skip: "offer members the guard does not produce" };
  const { total, context } = paymentFor(o);
  if (fracDigits(total) > 8) return { skip: "total has more than 8 fraction digits" };
  return {
    context,
    options: { assets: { [NET]: { [ASSET]: { currency: o.currency, decimals: DEC } } }, now: () => new Date(o.offered_at),
      terms: [{ resource: RES_URL, seller: o.seller, sku: o.sku, unit: o.unit, quantity: o.quantity, terms: v.input.terms }] },
  };
}

function spcGuardCase(v) {
  if (v.result.invalid) return { skip: "invalid input (the guard never sends input the rule cannot read)" };
  const o = v.input.offer;
  if (o.quantity === undefined || o.quantity === null) return { skip: "no quantity (the guard always sends one)" };
  if (o.offered_at === undefined || o.offered_at === null) return { skip: "no offer time (the guard always sends one)" };
  const { total, context } = paymentFor(o);
  if (fracDigits(total) > 8) return { skip: "total has more than 8 fraction digits" };
  const { already_spent, ...cap } = v.input.cap;
  if (cap.scope === "per_period") cap.alreadySpent = () => already_spent ?? "0";
  return { context, options: { assets: { [NET]: { [ASSET]: { currency: o.currency, decimals: DEC } } }, now: () => new Date(o.offered_at), cap } };
}

for (const [name, file, ct, build] of [["contract-price", CPM, "contract_price_match", cpmGuardCase], ["spend-cap", SPC, "spend_cap", spcGuardCase]]) {
  test(`${name}: every reproducible vector gives the published state and reason through the guard, local and signed alike`, async () => {
    let ran = 0;
    const skipped = {};
    for (const v of file.cases) {
      const c = build(v);
      if (c.skip) { skipped[c.skip] = (skipped[c.skip] || 0) + 1; continue; }
      const out = {};
      for (const mode of ["local", "signed"]) {
        let d;
        const api = mockApi();
        await taniloGuard({ ...c.options, mode, fetch: api.fetchImpl, onDecision: (x) => { d = x; } })(c.context);
        const check = d.checks.find((x) => x.check_type === ct);
        assert.equal(check.status, v.result.state, `${v.id} ${mode}: ${check.summary}`);
        assert.equal(check.reason, v.result.reason, `${v.id} ${mode}`);
        assert.equal(check.signed, mode === "signed", v.id);
        out[mode] = d.allow;
      }
      assert.equal(out.local, out.signed, `${v.id}: local and signed decisions differ`);
      ran++;
    }
    console.log(`# ${name}: ${ran} of ${file.cases.length} vectors through the guard in both modes; skipped ${JSON.stringify(skipped)}`);
    assert.ok(ran >= (ct === "contract_price_match" ? 50 : 30), `only ${ran} ran`);
  });
}
