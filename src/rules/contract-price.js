// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 TK Collective LLC
// ═══════════════════════════════════════════════════════════════════
//  contract_price_match — deterministic contract-price check (MVP)
//
//  Question answered: does the unit price in an offer match the price in
//  the applicable term, among the terms the caller supplied?
//
//  PURE: no network, no clock, no randomness, no model. The result is a
//  function of the input alone, so anyone holding the same input and this
//  rule can recompute it.
//
//  WHAT IT DOES NOT ESTABLISH. The terms are supplied by the caller. This
//  check does not establish that they are genuine, complete, validly
//  executed or approved by anyone. It compares an offer with the supplied
//  terms and says which term it used and why.
//
//  Three states, never a guess:
//    verified       the offer price equals the applicable term's price
//    contradicted   the offer price differs; expected and offered recorded
//    indeterminate  the applicable price could not be established; a reason
//                   code says why
//
//  Conventions:
//    - decimals are strings, compared by exact value ("10" equals "10.00");
//      no floating point, no rounding
//    - instants are RFC 3339 UTC ("...Z"); nothing reads a clock
//    - intervals and quantity tiers are lower-inclusive, upper-exclusive;
//      a null upper bound means unbounded
//    - precedence between overlapping terms is declared, never inferred
//    - no unit conversion and no currency conversion
// ═══════════════════════════════════════════════════════════════════

import crypto from "node:crypto";
import { jcs } from "./contract-price-jcs.js";

export const CONTRACT_PRICE_RULE_ID = "contract-price-match/v0.1";

export const CONTRACT_PRICE_STATES = Object.freeze(["verified", "contradicted", "indeterminate"]);

export const CONTRACT_PRICE_REASONS = Object.freeze({
  // contradicted
  price_mismatch: "the offer's unit price differs from the applicable term's price",
  // indeterminate
  no_applicable_term: "no supplied term covers this seller and product",
  effective_interval_unresolved: "no supplied term for this seller and product is in effect at the offer time",
  precedence_unresolved: "more than one supplied term applies and no declared precedence settles which",
  currency_mismatch: "the applicable term is priced in a different currency; no conversion is made",
  unit_mismatch: "the applicable term is priced in a different unit; no conversion is made",
  tier_selection_unresolved: "the quantity falls in no tier, or in more than one tier, of the applicable term",
});

export const CONTRACT_PRICE_LIMITS = Object.freeze({
  max_terms: 200,
  max_tiers_per_term: 50,
  max_skus_per_term: 500,
  max_string_length: 200,
  max_integer_digits: 18,
  max_fraction_digits: 8,
});

// A complete, valid input. Returned with every "cannot be read" answer and
// shown in the catalog, so the right shape is always one glance away.
export const CONTRACT_PRICE_EXAMPLE_INPUT = Object.freeze({
  offer: { unit_price: "2.00", currency: "USD", unit: "call", quantity: "1", seller: "seller.example", sku: "api.weather.v1", offered_at: "2026-10-01T12:00:00Z" },
  terms: [
    { agreement_id: "MSA-2026-014", version: "1", seller: "seller.example", product_scope: { skus: ["api.weather.v1"] }, currency: "USD", unit: "call", price_per_unit: "1.00", effective_from: "2026-01-01T00:00:00Z" },
  ],
});

// Says what was actually received, so the message can be acted on without
// guessing. Strings are quoted and cut at 40 characters.
function got(v) {
  if (v === undefined) return "nothing";
  if (v === null) return "null";
  if (Array.isArray(v)) return "an array";
  if (typeof v === "number") return `the JSON number ${v}`;
  if (typeof v === "boolean") return `the JSON value ${v}`;
  if (typeof v === "object") return "an object";
  const t = String(v);
  return `the string ${JSON.stringify(t.length > 40 ? t.slice(0, 40) + "…" : t)}`;
}

const SCALE = 8n;
const SCALE_FACTOR = 10n ** SCALE;

class InvalidInput extends Error {
  constructor(path, message) { super(`${path}: ${message}`); this.path = path; }
}

const sha256 = (s) => `sha256-${crypto.createHash("sha256").update(Buffer.from(s, "utf8")).digest("hex")}`;

// ── strict parsing ────────────────────────────────────────────────

const DECIMAL_RE = /^(0|[1-9]\d{0,17})(?:\.(\d{1,8}))?$/;

// Exact decimal → BigInt scaled by 10^8. No floats anywhere.
function parseDecimal(v, path) {
  if (typeof v !== "string") {
    throw new InvalidInput(path, `must be a decimal number written as a string, in quotes, for example "1.00"; got ${got(v)}. JSON numbers are refused so that no amount is ever rounded.`);
  }
  const m = DECIMAL_RE.exec(v);
  if (!m) {
    throw new InvalidInput(path, `must be a plain non-negative decimal such as "1.00" or "1250.5": digits, then optionally a point and 1 to 8 more digits; no sign, no currency symbol, no thousands separator, no exponent, no leading zeros, at most 18 digits before the point; got ${got(v)}.`);
  }
  return BigInt(m[1]) * SCALE_FACTOR + BigInt((m[2] || "").padEnd(Number(SCALE), "0"));
}

function formatDecimal(scaled) {
  const neg = scaled < 0n;
  const abs = neg ? -scaled : scaled;
  const int = abs / SCALE_FACTOR;
  let frac = (abs % SCALE_FACTOR).toString().padStart(Number(SCALE), "0").replace(/0+$/, "");
  if (frac.length < 2) frac = frac.padEnd(2, "0");
  return `${neg ? "-" : ""}${int}.${frac}`;
}

const INSTANT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/;

function parseInstant(v, path) {
  if (typeof v !== "string") throw new InvalidInput(path, `must be a UTC time written as a string, for example "2026-10-01T00:00:00Z"; got ${got(v)}.`);
  const m = INSTANT_RE.exec(v);
  if (!m) {
    // A time that carries an explicit offset names an exact instant; it is
    // refused only because this schema accepts the Z form and no other.
    if (/T.*[+-]\d{2}(:?\d{2})?$/.test(v)) {
      throw new InvalidInput(path, `must be a UTC time ending in Z, for example "2026-10-01T00:00:00Z"; got ${got(v)}. An explicit offset such as +02:00 is unsupported by this Z-only schema. Convert the time to UTC and end it with Z.`);
    }
    throw new InvalidInput(path, `must be a full UTC time ending in Z, for example "2026-10-01T00:00:00Z"; got ${got(v)}. A date with no time, and a time with no Z, are refused, because the exact instant would have to be guessed. For "from the start of 1 January 2026 UTC" send "2026-01-01T00:00:00Z".`);
  }
  const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number);
  const ms = Number((m[7] || "").padEnd(3, "0"));
  const t = Date.UTC(y, mo - 1, d, h, mi, s, ms);
  const back = new Date(t);
  // Round-trip guard rejects impossible dates such as 2026-02-30.
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d ||
      back.getUTCHours() !== h || back.getUTCMinutes() !== mi || back.getUTCSeconds() !== s) {
    throw new InvalidInput(path, `is not a real calendar date and time; got ${got(v)}.`);
  }
  return t;
}

function parseText(v, path) {
  if (typeof v !== "string" || v.length === 0) throw new InvalidInput(path, `must be a non-empty string; got ${got(v)}.`);
  if (v.length > CONTRACT_PRICE_LIMITS.max_string_length) throw new InvalidInput(path, `must be at most ${CONTRACT_PRICE_LIMITS.max_string_length} characters`);
  if (v !== v.trim()) throw new InvalidInput(path, `must not start or end with a space; got ${got(v)}. Identifiers are compared as exact strings.`);
  return v;
}

function parseCurrency(v, path) {
  if (typeof v !== "string" || !/^[A-Z]{3}$/.test(v)) throw new InvalidInput(path, `must be a three-letter upper-case currency code, for example "USD"; got ${got(v)}.`);
  return v;
}

function isPlainObject(v) { return v !== null && typeof v === "object" && !Array.isArray(v); }

// Closed objects: an unknown member is rejected, so nothing the caller
// sent (a discount, a surcharge, a note) is silently ignored.
function closed(obj, path, allowed) {
  if (!isPlainObject(obj)) throw new InvalidInput(path, `must be an object; got ${got(obj)}.`);
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) throw new InvalidInput(`${path}.${k}`, `is not a recognised member, and nothing is silently ignored. Recognised members here are: ${allowed.join(", ")}.`);
  }
}

function required(obj, path, keys) {
  for (const k of keys) if (obj[k] === undefined) throw new InvalidInput(`${path}.${k}`, "is required and is missing.");
}

const OFFER_KEYS = ["unit_price", "currency", "unit", "quantity", "seller", "sku", "offered_at"];
const TERM_KEYS = ["agreement_id", "version", "seller", "product_scope", "currency", "unit", "price_per_unit", "tiers", "effective_from", "effective_to", "supersedes"];
const TIER_KEYS = ["min_quantity", "max_quantity", "price_per_unit"];

function parseOffer(o) {
  closed(o, "offer", OFFER_KEYS);
  required(o, "offer", OFFER_KEYS);
  const quantity = parseDecimal(o.quantity, "offer.quantity");
  if (quantity <= 0n) throw new InvalidInput("offer.quantity", `must be greater than zero; got ${got(o.quantity)}.`);
  return {
    unit_price: parseDecimal(o.unit_price, "offer.unit_price"),
    currency: parseCurrency(o.currency, "offer.currency"),
    unit: parseText(o.unit, "offer.unit"),
    quantity,
    seller: parseText(o.seller, "offer.seller"),
    sku: parseText(o.sku, "offer.sku"),
    offered_at: parseInstant(o.offered_at, "offer.offered_at"),
  };
}

function parseTerm(t, i) {
  const p = `terms[${i}]`;
  closed(t, p, TERM_KEYS);
  required(t, p, ["agreement_id", "version", "seller", "product_scope", "currency", "unit", "effective_from"]);
  closed(t.product_scope, `${p}.product_scope`, ["skus"]);
  const skus = t.product_scope.skus;
  if (!Array.isArray(skus) || skus.length === 0) throw new InvalidInput(`${p}.product_scope.skus`, "must be a non-empty array of product identifiers");
  if (skus.length > CONTRACT_PRICE_LIMITS.max_skus_per_term) throw new InvalidInput(`${p}.product_scope.skus`, `must list at most ${CONTRACT_PRICE_LIMITS.max_skus_per_term} products`);
  const skuList = skus.map((s, j) => parseText(s, `${p}.product_scope.skus[${j}]`));
  if (new Set(skuList).size !== skuList.length) throw new InvalidInput(`${p}.product_scope.skus`, "lists the same product twice");

  const hasFlat = t.price_per_unit !== undefined;
  const hasTiers = t.tiers !== undefined;
  if (hasFlat === hasTiers) throw new InvalidInput(p, hasFlat ? "carries both price_per_unit and tiers; a term must carry exactly one of them (price_per_unit for one price, tiers for prices by quantity)." : "carries neither price_per_unit nor tiers; a term must carry exactly one of them (price_per_unit for one price, tiers for prices by quantity).");

  let flat = null, tiers = null;
  if (hasFlat) flat = parseDecimal(t.price_per_unit, `${p}.price_per_unit`);
  else {
    if (!Array.isArray(t.tiers) || t.tiers.length === 0) throw new InvalidInput(`${p}.tiers`, "must be a non-empty array");
    if (t.tiers.length > CONTRACT_PRICE_LIMITS.max_tiers_per_term) throw new InvalidInput(`${p}.tiers`, `must hold at most ${CONTRACT_PRICE_LIMITS.max_tiers_per_term} tiers`);
    tiers = t.tiers.map((tier, j) => {
      const tp = `${p}.tiers[${j}]`;
      closed(tier, tp, TIER_KEYS);
      required(tier, tp, ["min_quantity", "price_per_unit"]);
      const min = parseDecimal(tier.min_quantity, `${tp}.min_quantity`);
      const max = tier.max_quantity === undefined || tier.max_quantity === null ? null : parseDecimal(tier.max_quantity, `${tp}.max_quantity`);
      if (max !== null && max <= min) throw new InvalidInput(`${tp}.max_quantity`, `must be greater than min_quantity; got min_quantity ${got(tier.min_quantity)} and max_quantity ${got(tier.max_quantity)}. A tier covers min_quantity up to, but not including, max_quantity.`);
      return { min, max, price: parseDecimal(tier.price_per_unit, `${tp}.price_per_unit`), raw: { min_quantity: tier.min_quantity, max_quantity: tier.max_quantity ?? null, price_per_unit: tier.price_per_unit } };
    });
  }

  const from = parseInstant(t.effective_from, `${p}.effective_from`);
  const to = t.effective_to === undefined || t.effective_to === null ? null : parseInstant(t.effective_to, `${p}.effective_to`);
  if (to !== null && to <= from) throw new InvalidInput(`${p}.effective_to`, `must be later than effective_from; got effective_from ${got(t.effective_from)} and effective_to ${got(t.effective_to)}. A term is in effect from effective_from up to, but not including, effective_to.`);

  const version = parseText(t.version, `${p}.version`);
  const supersedes = t.supersedes === undefined || t.supersedes === null ? null : parseText(t.supersedes, `${p}.supersedes`);
  if (supersedes !== null && supersedes === version) throw new InvalidInput(`${p}.supersedes`, `names the term's own version (${got(version)}); it must name the earlier version this term replaces.`);

  return {
    index: i,
    agreement_id: parseText(t.agreement_id, `${p}.agreement_id`),
    version,
    seller: parseText(t.seller, `${p}.seller`),
    skus: skuList,
    currency: parseCurrency(t.currency, `${p}.currency`),
    unit: parseText(t.unit, `${p}.unit`),
    flat, tiers, from, to, supersedes,
    effective_from: t.effective_from,
    effective_to: t.effective_to ?? null,
    term_sha256: sha256(jcs(t)),
  };
}

function parseInput(input) {
  closed(input, "input", ["offer", "terms"]);
  required(input, "input", ["offer", "terms"]);
  const offer = parseOffer(input.offer);
  if (!Array.isArray(input.terms)) throw new InvalidInput("terms", `must be an array of terms (it may be empty); got ${got(input.terms)}.`);
  if (input.terms.length > CONTRACT_PRICE_LIMITS.max_terms) throw new InvalidInput("terms", `must hold at most ${CONTRACT_PRICE_LIMITS.max_terms} terms`);
  const terms = input.terms.map(parseTerm);
  const seen = new Set();
  for (const t of terms) {
    const k = jcs([t.agreement_id, t.version]);
    if (seen.has(k)) throw new InvalidInput(`terms[${t.index}]`, `repeats agreement ${JSON.stringify(t.agreement_id)} version ${JSON.stringify(t.version)}; each agreement version may appear once`);
    seen.add(k);
  }
  // A declared precedence cycle (A supersedes B, B supersedes A) has no reading.
  const byKey = new Map(terms.map((t) => [jcs([t.agreement_id, t.version]), t]));
  for (const t of terms) {
    const walked = new Set([t.version]);
    let cur = t;
    while (cur && cur.supersedes !== null) {
      if (walked.has(cur.supersedes)) throw new InvalidInput(`terms[${t.index}].supersedes`, "is part of a loop of terms that each say they replace another; no reading of that is possible.");
      walked.add(cur.supersedes);
      cur = byKey.get(jcs([cur.agreement_id, cur.supersedes]));
    }
  }
  return { offer, terms };
}

// ── the rule ──────────────────────────────────────────────────────

const ref = (t) => ({ agreement_id: t.agreement_id, version: t.version, term_sha256: t.term_sha256 });
const inInterval = (x, from, to) => x >= from && (to === null || x < to);

/**
 * Evaluate the check. Returns either
 *   { invalid: true, path, message }                      the input could not be read as declared
 *   { state, reason, evidence }                           the check ran
 */
export function evaluateContractPrice(input) {
  let parsed;
  try { parsed = parseInput(input); }
  catch (e) {
    if (e instanceof InvalidInput) return { invalid: true, path: e.path, message: e.message };
    throw e;
  }
  const { offer, terms } = parsed;
  const steps = [];
  const base = {
    rule_id: CONTRACT_PRICE_RULE_ID,
    terms_source: "caller_supplied",
    terms_count: terms.length,
    terms_sha256: sha256(jcs(input.terms)),
    offer_sha256: sha256(jcs(input.offer)),
    offer: input.offer,
  };
  const done = (state, reason, extra) => ({
    state,
    reason,
    evidence: { ...base, state, reason, reason_text: reason ? CONTRACT_PRICE_REASONS[reason] : null, ...extra, steps },
  });
  const none = { matched_term: null, expected: null };

  // 1. scope: same seller, product listed in the term's scope (exact strings)
  const inScope = terms.filter((t) => t.seller === offer.seller && t.skus.includes(offer.sku));
  steps.push({ step: "scope", rule: "term.seller equals offer.seller and term.product_scope.skus contains offer.sku (exact strings)", terms_remaining: inScope.map(ref) });
  if (inScope.length === 0) return done("indeterminate", "no_applicable_term", none);

  // 2. effective at the offer time: effective_from <= offered_at < effective_to
  const effective = inScope.filter((t) => inInterval(offer.offered_at, t.from, t.to));
  steps.push({ step: "effective_at_offer_time", rule: "effective_from <= offered_at < effective_to (end exclusive; no effective_to means no end)", terms_remaining: effective.map(ref) });
  if (effective.length === 0) {
    return done("indeterminate", "effective_interval_unresolved", {
      ...none,
      terms_in_scope: inScope.map((t) => ({ ...ref(t), effective_from: t.effective_from, effective_to: t.effective_to })),
    });
  }

  // 3. declared precedence: a term drops out when another term of the same
  //    agreement that is also in effect names it in `supersedes`
  const superseded = new Set();
  for (const t of effective) {
    if (t.supersedes === null) continue;
    for (const o of effective) if (o.agreement_id === t.agreement_id && o.version === t.supersedes) superseded.add(o.index);
  }
  const standing = effective.filter((t) => !superseded.has(t.index));
  steps.push({ step: "declared_precedence", rule: "a term is set aside when another in-effect term of the same agreement names its version in supersedes; precedence is never inferred from version numbers or dates", terms_remaining: standing.map(ref) });

  // 4. exactly one term must remain BEFORE currency or unit is looked at.
  //    Two terms that both apply are unresolved even when only one of them
  //    is in the offer's currency or unit: picking that one would be a guess
  //    about which agreement governs.
  steps.push({ step: "exactly_one_term", rule: "exactly one term must remain after declared precedence; currency and unit are not used to choose between terms", terms_remaining: standing.map(ref) });
  if (standing.length > 1) {
    return done("indeterminate", "precedence_unresolved", { ...none, competing_terms: standing.map((t) => ({ ...ref(t), effective_from: t.effective_from, effective_to: t.effective_to, currency: t.currency, unit: t.unit })) });
  }
  const term = standing[0];

  // 5. currency, then unit, of that one term (no conversion)
  steps.push({ step: "currency", rule: "term.currency equals offer.currency; no conversion", matches: term.currency === offer.currency });
  if (term.currency !== offer.currency) {
    return done("indeterminate", "currency_mismatch", { ...none, term_considered: ref(term), offer_currency: offer.currency, term_currency: term.currency });
  }
  steps.push({ step: "unit", rule: "term.unit equals offer.unit (exact string); no conversion", matches: term.unit === offer.unit });
  if (term.unit !== offer.unit) {
    return done("indeterminate", "unit_mismatch", { ...none, term_considered: ref(term), offer_unit: offer.unit, term_unit: term.unit });
  }

  // 6. the term's price for this quantity
  let expected, tier = null;
  if (term.flat !== null) {
    expected = term.flat;
    steps.push({ step: "price", rule: "the term carries one price for every quantity", pricing: "flat" });
  } else {
    const hits = term.tiers.filter((b) => inInterval(offer.quantity, b.min, b.max));
    steps.push({ step: "tier", rule: "min_quantity <= quantity < max_quantity (upper bound exclusive; no max_quantity means no upper bound)", pricing: "tiered", tiers_matching: hits.map((b) => b.raw) });
    if (hits.length !== 1) {
      return done("indeterminate", "tier_selection_unresolved", {
        ...none,
        term_considered: ref(term),
        quantity: input.offer.quantity,
        detail: hits.length === 0 ? "gap: no tier contains the quantity" : "overlap: more than one tier contains the quantity",
        tiers_matching: hits.map((b) => b.raw),
      });
    }
    tier = hits[0].raw;
    expected = hits[0].price;
  }

  const matched_term = {
    ...ref(term),
    effective_from: term.effective_from,
    effective_to: term.effective_to,
    pricing: term.flat !== null ? "flat" : "tiered",
    tier: tier ? { min_quantity: tier.min_quantity, max_quantity: tier.max_quantity } : null,
  };
  const expectedOut = { price_per_unit: formatDecimal(expected), currency: term.currency, unit: term.unit };
  const offeredOut = { unit_price: formatDecimal(offer.unit_price), currency: offer.currency, unit: offer.unit, quantity: input.offer.quantity };
  steps.push({ step: "compare", rule: "offer.unit_price equals the term's price by exact decimal value (\"1\" equals \"1.00\"); no tolerance, no rounding" });

  if (offer.unit_price === expected) {
    return done("verified", null, { matched_term, expected: expectedOut, offered: offeredOut });
  }
  const diff = offer.unit_price - expected;
  return done("contradicted", "price_mismatch", {
    matched_term,
    expected: expectedOut,
    offered: offeredOut,
    difference_per_unit: formatDecimal(diff),
    offer_is: diff > 0n ? "above_term_price" : "below_term_price",
  });
}
