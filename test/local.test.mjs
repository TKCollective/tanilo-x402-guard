import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import crypto from "node:crypto";
import { taniloGuard } from "../src/index.js";
import { atomicToDecimal, divideExact } from "../src/amount.js";
import { ASSETS, TERMS, NOW, NET, USDC_BASE, URL_WEATHER, ctx, recorder } from "./helpers.mjs";

const base = (extra = {}) => ({ terms: TERMS, assets: ASSETS, now: NOW, ...extra });
const status = (d, ct) => d.checks.find((c) => c.check_type === ct).status;

// ── contract price ──────────────────────────────────────────────────────────────────────────────────────

test("price mismatch aborts, naming the check and the difference", async () => {
  const r = recorder();
  const out = await taniloGuard(base(r))(ctx({ amount: "2000000" }));
  assert.equal(out.abort, true);
  assert.match(out.reason, /contract_price_match contradicted: offered 2\.00 USD above term price 1\.00 under contract-price-match\/v0\.1 \(unsigned, computed locally\)/);
  const d = r.decisions[0];
  assert.equal(d.allow, false);
  assert.equal(status(d, "contract_price_match"), "contradicted");
  assert.equal(d.checks[0].signed, false);
  assert.deepEqual(d.checks[0].input.offer, { unit_price: "2", currency: "USD", unit: "call", quantity: "1", seller: "seller.example", sku: "api.weather.v1", offered_at: "2026-10-14T12:00:00.000Z" });
  assert.equal(d.receipt, null);
});

test("price below the term also aborts (contradicted is not only 'too high')", async () => {
  const out = await taniloGuard(base())(ctx({ amount: "500000" }));
  assert.match(out.reason, /offered 0\.50 USD below term price 1\.00/);
});

test("corrected price is allowed and the result names its subject", async () => {
  const r = recorder();
  const out = await taniloGuard(base(r))(ctx({ amount: "1000000" }));
  assert.equal(out, undefined);
  const d = r.decisions[0];
  assert.equal(d.allow, true);
  assert.equal(d.checks[0].summary, "contract_price_match verified: the offered price matches the supplied term under contract-price-match/v0.1 (unsigned, computed locally)");
  assert.equal(status(d, "spend_cap"), "not_evaluated");
});

test("a quantity per payment divides the amount exactly into the unit price", async () => {
  const terms = [{ ...TERMS[0], quantity: "4", terms: [{ ...TERMS[0].terms[0], price_per_unit: "0.25" }] }];
  const r = recorder();
  assert.equal(await taniloGuard(base({ terms, ...r }))(ctx({ amount: "1000000" })), undefined);
  assert.equal(r.decisions[0].checks[0].input.offer.unit_price, "0.25");
  const terms3 = [{ ...TERMS[0], quantity: "3" }];
  const out = await taniloGuard(base({ terms: terms3 }))(ctx({ amount: "1000000" }));
  assert.match(out.reason, /unit_price_not_exact|not exact to 8 places/);
});

test("resourcePrefix matches when no exact entry does; two matches are indeterminate", async () => {
  const pre = [{ ...TERMS[0], resource: undefined, resourcePrefix: "https://seller.example/" }];
  assert.equal(await taniloGuard(base({ terms: pre }))(ctx({ amount: "1000000" })), undefined);
  const two = [pre[0], { ...pre[0], resourcePrefix: "https://seller.example/w" }];
  const r = recorder();
  const out = await taniloGuard(base({ terms: two, ...r }))(ctx({ amount: "1000000" }));
  assert.equal(out.abort, true);
  assert.equal(r.decisions[0].checks[0].reason, "terms_entry_ambiguous");
});

test("a payTo other than the one named with the terms is indeterminate (blocked by default)", async () => {
  const terms = [{ ...TERMS[0], payTo: "0x2222222222222222222222222222222222222222" }];
  const r = recorder();
  const out = await taniloGuard(base({ terms, ...r }))(ctx({ amount: "1000000" }));
  assert.equal(out.abort, true);
  assert.equal(r.decisions[0].checks[0].reason, "pay_to_differs");
});

// ── spend cap ───────────────────────────────────────────────────────────────────────────────────────────

const capPP = { cap_id: "per-call", amount: "1.00", currency: "USD", scope: "per_purchase" };

test("over cap aborts; exactly at cap is allowed", async () => {
  const over = await taniloGuard({ assets: ASSETS, now: NOW, cap: capPP })(ctx({ amount: "1000001" }));
  assert.match(over.reason, /spend_cap contradicted: offered total 1\.000001 USD exceeds the remaining supplied cap 1\.00 by 0\.000001 under spend-cap\/v0\.1/);
  const r = recorder();
  assert.equal(await taniloGuard({ assets: ASSETS, now: NOW, cap: capPP, ...r })(ctx({ amount: "1000000" })), undefined);
  assert.equal(status(r.decisions[0], "spend_cap"), "verified");
  assert.match(r.decisions[0].checks.find((c) => c.check_type === "spend_cap").summary, /fits within the remaining supplied cap under spend-cap\/v0\.1/);
});

test("per_period uses alreadySpent() for every payment", async () => {
  const seen = [];
  const cap = { cap_id: "october", amount: "10.00", currency: "USD", scope: "per_period", period: { from: "2026-10-01T00:00:00Z", to: "2026-11-01T00:00:00Z" },
    alreadySpent: async (info) => { seen.push(info); return "9.50"; } };
  const g = taniloGuard({ assets: ASSETS, now: NOW, cap });
  assert.equal(await g(ctx({ amount: "500000" })), undefined);             // 9.50 + 0.50 = 10.00: at cap
  const out = await g(ctx({ amount: "500001" }));
  assert.match(out.reason, /exceeds the remaining supplied cap 0\.50 by 0\.000001/);
  assert.equal(seen.length, 2);
  assert.equal(seen[0].cap_id, "october");
  assert.equal(seen[0].offered_at, "2026-10-14T12:00:00.000Z");
  // outside the period: indeterminate, blocked by default
  const late = await taniloGuard({ assets: ASSETS, now: () => new Date("2026-11-02T00:00:00Z"), cap })(ctx());
  assert.match(late.reason, /spend_cap indeterminate: offer_outside_period/);
});

test("alreadySpent() that throws or returns a number is indeterminate, not a guess", async () => {
  const mk = (fn) => ({ amount: "10.00", currency: "USD", scope: "per_period", period: { from: "2026-10-01T00:00:00Z", to: "2026-11-01T00:00:00Z" }, alreadySpent: fn });
  for (const fn of [async () => { throw new Error("ledger down"); }, () => 3]) {
    const r = recorder();
    const out = await taniloGuard({ assets: ASSETS, now: NOW, cap: mk(fn), ...r })(ctx());
    assert.equal(out.abort, true);
    assert.equal(r.decisions[0].checks.find((c) => c.check_type === "spend_cap").reason, "already_spent_unavailable");
  }
});

test("a per_period cap without alreadySpent() is refused at setup", () => {
  assert.throws(() => taniloGuard({ cap: { amount: "1", currency: "USD", scope: "per_period", period: { from: "2026-10-01T00:00:00Z", to: "2026-11-01T00:00:00Z" } } }), /alreadySpent/);
});

// ── policies ────────────────────────────────────────────────────────────────────────────────────────────

const indeterminateCtx = () => ctx({ amount: "1000000", url: URL_WEATHER });
const indeterminateTerms = [{ ...TERMS[0], terms: [{ ...TERMS[0].terms[0], currency: "EUR" }] }];   // currency_mismatch

test("indeterminate: blocked by default, allowed under onIndeterminate: allow, always reported", async () => {
  const r1 = recorder();
  const out1 = await taniloGuard(base({ terms: indeterminateTerms, ...r1 }))(indeterminateCtx());
  assert.equal(out1.abort, true);
  assert.match(out1.reason, /contract_price_match indeterminate: currency_mismatch/);
  assert.deepEqual(r1.decisions[0].policy.applied, ["indeterminate: onIndeterminate = block", "not_evaluated: onNotEvaluated = allow"]);
  const r2 = recorder();
  assert.equal(await taniloGuard(base({ terms: indeterminateTerms, onIndeterminate: "allow", ...r2 }))(indeterminateCtx()), undefined);
  assert.equal(status(r2.decisions[0], "contract_price_match"), "indeterminate");
});

test("not_evaluated (no terms for the resource): allowed by default, blocked under onNotEvaluated: block, always reported", async () => {
  const r1 = recorder();
  assert.equal(await taniloGuard(base(r1))(ctx({ url: "https://other.example/x" })), undefined);
  assert.equal(status(r1.decisions[0], "contract_price_match"), "not_evaluated");
  assert.match(r1.decisions[0].checks[0].summary, /no supplied terms for https:\/\/other\.example\/x/);
  const out = await taniloGuard(base({ onNotEvaluated: "block" }))(ctx({ url: "https://other.example/x" }));
  assert.equal(out.abort, true);
  assert.match(out.reason, /contract_price_match not evaluated/);
});

test("contradicted aborts even when every other policy is allow", async () => {
  const out = await taniloGuard(base({ onIndeterminate: "allow", onNotEvaluated: "allow", onUnavailable: "allow" }))(ctx({ amount: "2000000" }));
  assert.equal(out.abort, true);
});

// ── assets ──────────────────────────────────────────────────────────────────────────────────────────────

test("an unmapped asset is indeterminate: no decimals or currency are guessed", async () => {
  const r = recorder();
  const out = await taniloGuard(base({ cap: capPP, ...r }))(ctx({ asset: "0x9999999999999999999999999999999999999999" }));
  assert.equal(out.abort, true);
  const d = r.decisions[0];
  assert.equal(status(d, "contract_price_match"), "indeterminate");
  assert.equal(status(d, "spend_cap"), "indeterminate");
  assert.match(d.checks[0].summary, /is not in the supplied assets map/);
  assert.equal(d.amount, null);
  // same address on another network is also unmapped
  const out2 = await taniloGuard(base())(ctx({ network: "eip155:1" }));
  assert.equal(out2.abort, true);
});

test("USDC is USD only if the customer's map says so", async () => {
  const eurMap = { [NET]: { [USDC_BASE]: { currency: "EUR", decimals: 6 } } };
  const r = recorder();
  const out = await taniloGuard(base({ assets: eurMap, ...r }))(ctx());
  assert.equal(out.abort, true);
  assert.equal(r.decisions[0].checks[0].reason, "currency_mismatch");
});

test("EVM asset addresses match case-insensitively; other formats exactly", async () => {
  assert.equal(await taniloGuard(base())(ctx({ asset: USDC_BASE.toLowerCase() })), undefined);
  const sol = { "solana:mainnet": { EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: { currency: "USD", decimals: 6 } } };
  const r = recorder();
  await taniloGuard({ assets: sol, now: NOW, cap: capPP, ...r })(ctx({ network: "solana:mainnet", asset: "epjfwdd5aufqssqem2qn1xzybapc8g4wEGGkZwyTDt1v" }));
  assert.equal(r.decisions[0].checks[1].reason, "amount_unreadable");
});

test("amounts are exact: no floats, no rounding", () => {
  assert.deepEqual(atomicToDecimal("1000000", 6), { ok: true, value: "1" });
  assert.deepEqual(atomicToDecimal("1", 6), { ok: true, value: "0.000001" });
  assert.deepEqual(atomicToDecimal("123456789012345678901234", 6), { ok: true, value: "123456789012345678.901234" });
  assert.equal(atomicToDecimal("1", 18).ok, false);                       // 18 significant fraction digits: not rounded
  assert.deepEqual(atomicToDecimal("1000000000000", 18), { ok: true, value: "0.000001" });
  assert.equal(atomicToDecimal("0.1", 6).ok, false);
  assert.equal(atomicToDecimal("-1", 6).ok, false);
  assert.equal(atomicToDecimal("01", 6).ok, false);
  assert.equal(atomicToDecimal("1", 6.5).ok, false);
  assert.equal(divideExact("1", "3"), null);
  assert.equal(divideExact("0.3", "3"), "0.1");
  // 0.1 + 0.2 style traps never arise: the cap compare is exact
  assert.equal(divideExact("0.30000001", "1"), "0.30000001");
});

// ── the hook never throws ───────────────────────────────────────────────────────────────────────────────

const MALFORMED = [
  undefined, null, 5, "x", [], {}, { selectedRequirements: null }, { selectedRequirements: [] },
  { paymentRequired: null, selectedRequirements: {} },
  { paymentRequired: { x402Version: 2 }, selectedRequirements: { network: NET, asset: USDC_BASE, amount: 1000000, payTo: "0x1" } },
  { paymentRequired: { x402Version: 2, resource: "not-an-object" }, selectedRequirements: { network: NET, asset: USDC_BASE, amount: "1e6", payTo: "0x1" } },
  { paymentRequired: { x402Version: 1 }, selectedRequirements: { network: NET, asset: USDC_BASE, maxAmountRequired: "1000000", payTo: "0x1" } },
  ctx({ amount: "-5" }), ctx({ amount: "" }), ctx({ amount: "1".repeat(100) }), ctx({ amount: "1.5" }),
  ctx({ url: 42 }), ctx({ payTo: null }), ctx({ asset: { toString: () => { throw new Error("boom"); } } }),
];

test("malformed requirements never throw; they are aborted under the default policy and allowed under allow", async () => {
  for (const policy of ["block", "allow"]) {
    const r = recorder();
    const g = taniloGuard(base({ cap: capPP, onIndeterminate: policy, ...r }));
    for (const c of MALFORMED) {
      const out = await g(c);
      if (policy === "block") assert.equal(out?.abort, true, `expected abort for ${JSON.stringify(c)?.slice(0, 80)}`);
      else assert.equal(out, undefined);
    }
    assert.equal(r.decisions.length, MALFORMED.length);
    for (const d of r.decisions) assert.ok(d.checks.every((c) => typeof c.summary === "string" && c.summary.length > 0));
  }
});

test("an onDecision that throws does not change the outcome or escape the hook", async () => {
  const out = await taniloGuard(base({ onDecision: () => { throw new Error("logger down"); } }))(ctx({ amount: "2000000" }));
  assert.equal(out.abort, true);
  assert.equal(await taniloGuard(base({ onDecision: async () => { throw new Error("x"); } }))(ctx()), undefined);
});

test("local mode makes no network call", async () => {
  const saved = globalThis.fetch;
  globalThis.fetch = () => { throw new Error("network used"); };
  try {
    assert.equal(await taniloGuard(base({ cap: capPP }))(ctx()), undefined);
  } finally { globalThis.fetch = saved; }
});

// ── wording ─────────────────────────────────────────────────────────────────────────────────────────────

test("no result says safe, approved or verified seller", () => {
  for (const f of ["src/index.js", "src/signed.js", "src/amount.js", "README.md"]) {
    const s = fs.readFileSync(new URL(`../${f}`, import.meta.url), "utf8").toLowerCase();
    for (const w of ["safe", "approved", "verified seller"]) {
      const hits = s.split("\n").filter((l) => l.includes(w) && !l.includes("not approved") && !l.includes("or approved") && !l.includes("never \"safe\""));
      assert.deepEqual(hits, [], `${f} says "${w}"`);
    }
  }
});

test("the copied rules are byte-identical to the published ones", () => {
  const sums = fs.readFileSync(new URL("../src/rules/SHA256SUMS", import.meta.url), "utf8").trim().split("\n");
  for (const line of sums) {
    const [hash, name] = line.split(/\s+/);
    const got = crypto.createHash("sha256").update(fs.readFileSync(new URL(`../src/rules/${name}`, import.meta.url))).digest("hex");
    assert.equal(got, hash, name);
  }
  assert.equal(sums.length, 3);
});
