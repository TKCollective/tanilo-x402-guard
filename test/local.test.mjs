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

// ── terms lookup ────────────────────────────────────────────────────────────────────────────────────────

const entry = (resource, extra = {}) => ({ ...TERMS[0], resource, ...extra });
async function lookup(terms, url) {
  const r = recorder();
  await taniloGuard(base({ terms, ...r }))(ctx({ url, amount: "1000000" }));
  const d = r.decisions[0];
  return { status: d.checks[0].status, reason: d.checks[0].reason, used: d.inputs.terms_entry, how: d.inputs.terms_lookup };
}

test("lookup is exact by default: a longer URL does not match an exact entry", async () => {
  assert.equal((await lookup([entry("https://seller.example/api/a")], "https://seller.example/api/a")).status, "verified");
  assert.equal((await lookup([entry("https://seller.example/api/a")], "https://seller.example/api/a/x")).status, "not_evaluated");
  assert.equal((await lookup([entry("https://seller.example/api/a")], "https://seller.example/api/a?x=1")).status, "not_evaluated");
});

test("prefix only with match: \"prefix\", at a path-segment boundary", async () => {
  const p = [entry("https://seller.example/api/a", { match: "prefix" })];
  for (const url of ["https://seller.example/api/a", "https://seller.example/api/a/x", "https://seller.example/api/a/x/y?q=1"]) {
    const got = await lookup(p, url);
    assert.equal(got.status, "verified", url);
    assert.equal(got.how, "prefix");
  }
  for (const url of ["https://seller.example/api/ab", "https://seller.example/api/", "https://seller.example/api"]) {
    assert.equal((await lookup(p, url)).status, "not_evaluated", url);
  }
  // a trailing slash on the prefix means the same segment
  assert.equal((await lookup([entry("https://seller.example/api/a/", { match: "prefix" })], "https://seller.example/api/a/x")).status, "verified");
  assert.equal((await lookup([entry("https://seller.example/api/a/", { match: "prefix" })], "https://seller.example/api/ab")).status, "not_evaluated");
});

test("prefix only on the same origin: scheme, host and port", async () => {
  const p = [entry("https://seller.example/api", { match: "prefix" })];
  for (const url of ["http://seller.example/api/x", "https://evil.example/api/x", "https://seller.example:8443/api/x", "https://seller.example.evil.example/api/x", "https://sub.seller.example/api/x"]) {
    assert.equal((await lookup(p, url)).status, "not_evaluated", url);
  }
  // the default port is the same origin
  assert.equal((await lookup(p, "https://seller.example:443/api/x")).status, "verified");
});

test("exact beats prefix; longest prefix wins; equal-length prefixes are indeterminate", async () => {
  const exactWins = [entry("https://seller.example/api", { match: "prefix", terms: [{ ...TERMS[0].terms[0], price_per_unit: "9.00" }] }), entry("https://seller.example/api/a/x")];
  const e1 = await lookup(exactWins, "https://seller.example/api/a/x");
  assert.equal(e1.status, "verified");
  assert.equal(e1.how, "exact");

  const longest = [entry("https://seller.example/api", { match: "prefix", terms: [{ ...TERMS[0].terms[0], price_per_unit: "9.00" }] }), entry("https://seller.example/api/a", { match: "prefix" })];
  const e2 = await lookup(longest, "https://seller.example/api/a/x");
  assert.equal(e2.status, "verified");
  assert.equal(e2.used.resource, "https://seller.example/api/a");

  const tie = [entry("https://seller.example/api/a", { match: "prefix" }), entry("https://seller.example/api/a/", { match: "prefix", sku: "other" })];
  const e3 = await lookup(tie, "https://seller.example/api/a/x");
  assert.equal(e3.status, "indeterminate");
  assert.equal(e3.reason, "terms_entry_ambiguous");

  const twoExact = [entry(URL_WEATHER), entry(URL_WEATHER, { sku: "other" })];
  assert.equal((await lookup(twoExact, URL_WEATHER)).reason, "terms_entry_ambiguous");
});

test("terms entries are checked at setup", () => {
  assert.throws(() => taniloGuard({ terms: [{ ...TERMS[0], resource: undefined, resourcePrefix: "https://x/" }] }), /resource/);
  assert.throws(() => taniloGuard({ terms: [entry("https://seller.example/a", { match: "glob" })] }), /match must be/);
  assert.throws(() => taniloGuard({ terms: [entry("/relative", { match: "prefix" })] }), /absolute http\(s\) URL/);
  assert.throws(() => taniloGuard({ terms: [entry("https://seller.example/a?x=1", { match: "prefix" })] }), /no query/);
  assert.throws(() => taniloGuard({ terms: [entry("ftp://seller.example/a", { match: "prefix" })] }), /absolute http\(s\) URL/);
});

// ── payee_match ─────────────────────────────────────────────────────────────────────────────────────────

const PAYEE = "0x1111111111111111111111111111111111111111";

test("payee_match: a matching payTo is verified (EVM addresses compared case-insensitively) and labelled a guard check", async () => {
  const mixed = "0xAbCdEf0000000000000000000000000000000001";
  const r = recorder();
  const out = await taniloGuard(base({ terms: [entry(URL_WEATHER, { payTo: mixed.toLowerCase() })], ...r }))(ctx({ amount: "1000000", payTo: mixed }));
  assert.equal(out, undefined);
  const p = r.decisions[0].checks.find((c) => c.check_type === "payee_match");
  assert.equal(p.status, "verified");
  assert.equal(p.rule_id, null);
  assert.equal(p.guard_check, true);
  assert.match(p.summary, /\(a guard check, not a published Tanilo rule\)$/);
  assert.equal(p.input.comparison, "EVM address, case-insensitive");
});

test("payee_match: a different payTo is contradicted and names both addresses; blocked by default", async () => {
  const other = "0x2222222222222222222222222222222222222222";
  const r = recorder();
  const out = await taniloGuard(base({ terms: [entry(URL_WEATHER, { payTo: other })], ...r }))(ctx({ amount: "1000000", payTo: PAYEE }));
  assert.equal(out.abort, true);
  assert.match(out.reason, new RegExp(`payee_match contradicted: the payment goes to ${PAYEE}, but the supplied terms name ${other} \\(a guard check, not a published Tanilo rule\\)`));
  const d = r.decisions[0];
  assert.equal(d.checks.find((c) => c.check_type === "contract_price_match").status, "verified");   // the price check is unaffected
  assert.ok(d.policy.applied.includes("payee_match contradicted: onPayeeMismatch = block"));
});

test("payee_match: onPayeeMismatch: allow lets the payment through and still reports the mismatch", async () => {
  const r = recorder();
  const out = await taniloGuard(base({ terms: [entry(URL_WEATHER, { payTo: "0x2222222222222222222222222222222222222222" })], onPayeeMismatch: "allow", ...r }))(ctx({ amount: "1000000", payTo: PAYEE }));
  assert.equal(out, undefined);
  assert.equal(r.decisions[0].checks.find((c) => c.check_type === "payee_match").status, "contradicted");
  assert.ok(r.decisions[0].policy.applied.includes("payee_match contradicted: onPayeeMismatch = allow"));
  // a contradicted price still aborts under onPayeeMismatch: allow
  const out2 = await taniloGuard(base({ terms: [entry(URL_WEATHER, { payTo: "0x2222222222222222222222222222222222222222" })], onPayeeMismatch: "allow" }))(ctx({ amount: "2000000", payTo: PAYEE }));
  assert.equal(out2.abort, true);
  assert.doesNotMatch(out2.reason, /payee_match/);
});

test("payee_match: not_evaluated when the terms entry names no payTo; follows onNotEvaluated (default allow)", async () => {
  const r = recorder();
  assert.equal(await taniloGuard(base(r))(ctx({ amount: "1000000", payTo: "0x9999999999999999999999999999999999999999" })), undefined);
  const p = r.decisions[0].checks.find((c) => c.check_type === "payee_match");
  assert.equal(p.status, "not_evaluated");
  assert.equal(p.reason, "no_payTo_in_terms");
  assert.deepEqual(r.decisions[0].checks.map((c) => c.check_type), ["contract_price_match", "spend_cap", "payee_match", "asset_match", "network_match"]);
});

test("payee_match: non-EVM addresses are compared exactly", async () => {
  const sol = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
  const out = await taniloGuard(base({ terms: [entry(URL_WEATHER, { payTo: sol.toLowerCase() })] }))(ctx({ amount: "1000000", payTo: sol }));
  assert.equal(out.abort, true);
  assert.match(out.reason, /payee_match contradicted/);
});

// ── offer time ──────────────────────────────────────────────────────────────────────────────────────────

test("the offer time comes from now() when given, else the system clock, and is recorded in decision.inputs", async () => {
  const r1 = recorder();
  await taniloGuard(base(r1))(ctx());
  assert.deepEqual({ offered_at: r1.decisions[0].inputs.offered_at, src: r1.decisions[0].inputs.offer_time_source }, { offered_at: "2026-10-14T12:00:00.000Z", src: "now() option" });
  assert.equal(r1.decisions[0].checks[0].input.offer.offered_at, "2026-10-14T12:00:00.000Z");
  const r2 = recorder();
  const before = Date.now();
  await taniloGuard({ terms: TERMS, assets: ASSETS, ...r2 })(ctx());
  const used = Date.parse(r2.decisions[0].inputs.offered_at);
  assert.equal(r2.decisions[0].inputs.offer_time_source, "system clock");
  assert.ok(used >= before && used <= Date.now());
});

test("a now() that throws or returns no valid Date is indeterminate, not a guess", async () => {
  for (const now of [() => { throw new Error("clock"); }, () => "2026-10-14T12:00:00Z", () => new Date("nonsense")]) {
    const r = recorder();
    const out = await taniloGuard(base({ now, ...r }))(ctx());
    assert.equal(out.abort, true);
    assert.equal(r.decisions[0].inputs.offered_at, null);
    assert.match(r.decisions[0].checks[0].summary, /the offer time is unknown/);
  }
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
