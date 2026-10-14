// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 TK Collective LLC
// ═══════════════════════════════════════════════════════════════════
//  spend_cap — deterministic spend-cap check (v0.1)
//
//  Question answered: does the total of an offer (unit price times quantity)
//  fit within the remaining cap the caller supplied?
//
//  PURE: no network, no clock, no randomness, no model. The result is a
//  function of the input alone, so anyone holding the same input and this
//  rule can recompute it.
//
//  WHAT IT DOES NOT ESTABLISH. The cap and already_spent are
//  caller-supplied. This check does not establish that the cap is
//  authentic, approved or applicable to this purchase, or that
//  already_spent is complete or current. It does not authenticate the
//  supplied offer time or establish that the offer is still current. It
//  does not retrieve budget balances, maintain a running balance or
//  reserve funds: it keeps no state between calls and does not record this
//  offer against the cap. It does not judge whether the purchase is
//  sensible.
//
//  Three states, never a guess:
//    verified       total <= remaining cap
//    contradicted   total > remaining cap; total, remaining and excess recorded;
//                   cap_already_exhausted is true when remaining <= 0, that is,
//                   the supplied inputs leave no positive allowance before
//                   including this offer
//    indeterminate  the comparison could not be made; a reason code says why
//
//  Conventions (the same as contract_price_match):
//    - decimals are strings, compared by exact value ("1" equals "1.00");
//      no floating point, no rounding; a product keeps every digit
//    - instants are RFC 3339 UTC ("...Z"), years 0100 through 9999; nothing reads a clock
//    - the period is lower-inclusive, upper-exclusive
//    - no currency conversion
// ═══════════════════════════════════════════════════════════════════

import crypto from "node:crypto";
import { jcs } from "./contract-price-jcs.js";

export const SPEND_CAP_RULE_ID = "spend-cap/v0.1";

export const SPEND_CAP_STATES = Object.freeze(["verified", "contradicted", "indeterminate"]);

export const SPEND_CAP_SCOPES = Object.freeze(["per_purchase", "per_period"]);

export const SPEND_CAP_REASONS = Object.freeze({
  // contradicted
  cap_exceeded: "the offer's total exceeds the remaining cap",
  // indeterminate
  currency_mismatch: "the cap is in a different currency from the offer; no conversion is made",
  quantity_missing: "the offer carries no quantity, so no total can be computed",
  period_bounds_missing: "the cap is per period but carries no period bounds",
  offer_time_missing: "the cap is per period but the offer carries no offered_at, so it cannot be placed in the period",
  offer_outside_period: "the offer time falls outside the cap's period",
});

export const SPEND_CAP_LIMITS = Object.freeze({
  max_string_length: 200,
  max_integer_digits: 18,
  max_fraction_digits: 8,
});

// A complete, valid input. Returned with every "cannot be read" answer and
// shown in the catalog, so the right shape is always one glance away.
export const SPEND_CAP_EXAMPLE_INPUT = Object.freeze({
  offer: { unit_price: "12.50", currency: "USD", quantity: "3", offered_at: "2026-10-10T12:00:00Z", seller: "seller.example", sku: "api.weather.v1" },
  cap: { cap_id: "api-budget-2026-10", amount: "100.00", currency: "USD", scope: "per_period", already_spent: "70.00", period: { from: "2026-10-01T00:00:00Z", to: "2026-11-01T00:00:00Z" } },
});

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

// Inputs carry up to 8 fraction digits; a product of two carries up to 16.
// Every amount is held at scale 16 so totals, caps and differences share one scale.
const SCALE = 16n;
const SCALE_FACTOR = 10n ** SCALE;

class InvalidInput extends Error {
  constructor(path, message) { super(`${path}: ${message}`); this.path = path; }
}

const sha256 = (s) => `sha256-${crypto.createHash("sha256").update(Buffer.from(s, "utf8")).digest("hex")}`;

// ── strict parsing ────────────────────────────────────────────────

const DECIMAL_RE = /^(0|[1-9]\d{0,17})(?:\.(\d{1,8}))?$/;

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
    if (/T.*[+-]\d{2}(:?\d{2})?$/.test(v)) {
      throw new InvalidInput(path, `must be a UTC time ending in Z, for example "2026-10-01T00:00:00Z"; got ${got(v)}. An explicit offset such as +02:00 is unsupported by this Z-only schema. Convert the time to UTC and end it with Z.`);
    }
    throw new InvalidInput(path, `must be a full UTC time ending in Z, for example "2026-10-01T00:00:00Z"; got ${got(v)}. A date with no time, and a time with no Z, are refused, because the exact instant would have to be guessed. For "from the start of 1 January 2026 UTC" send "2026-01-01T00:00:00Z".`);
  }
  const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number);
  const ms = Number((m[7] || "").padEnd(3, "0"));
  const t = Date.UTC(y, mo - 1, d, h, mi, s, ms);
  const back = new Date(t);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d ||
      back.getUTCHours() !== h || back.getUTCMinutes() !== mi || back.getUTCSeconds() !== s) {
    throw new InvalidInput(path, `is not a real calendar date and time; got ${got(v)}.`);
  }
  return t;
}

function parseText(v, path) {
  if (typeof v !== "string" || v.length === 0) throw new InvalidInput(path, `must be a non-empty string; got ${got(v)}.`);
  if (v.length > SPEND_CAP_LIMITS.max_string_length) throw new InvalidInput(path, `must be at most ${SPEND_CAP_LIMITS.max_string_length} characters`);
  if (v !== v.trim()) throw new InvalidInput(path, `must not start or end with a space; got ${got(v)}. Identifiers are compared as exact strings.`);
  return v;
}

function parseCurrency(v, path) {
  if (typeof v !== "string" || !/^[A-Z]{3}$/.test(v)) throw new InvalidInput(path, `must be a three-letter upper-case currency code, for example "USD"; got ${got(v)}.`);
  return v;
}

function isPlainObject(v) { return v !== null && typeof v === "object" && !Array.isArray(v); }

// Closed objects: an unknown member is rejected, so nothing the caller
// sent (a discount, a note, an approval) is silently ignored.
function closed(obj, path, allowed) {
  if (!isPlainObject(obj)) throw new InvalidInput(path, `must be an object; got ${got(obj)}.`);
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) throw new InvalidInput(`${path}.${k}`, `is not a recognised member, and nothing is silently ignored. Recognised members here are: ${allowed.join(", ")}.`);
  }
}

function required(obj, path, keys) {
  for (const k of keys) if (obj[k] === undefined) throw new InvalidInput(`${path}.${k}`, "is required and is missing.");
}

const OFFER_KEYS = ["unit_price", "currency", "quantity", "offered_at", "seller", "sku"];
const CAP_KEYS = ["cap_id", "amount", "currency", "scope", "already_spent", "period"];
const PERIOD_KEYS = ["from", "to"];

const present = (v) => v !== undefined && v !== null;

function parseOffer(o) {
  closed(o, "offer", OFFER_KEYS);
  required(o, "offer", ["unit_price", "currency"]);
  let quantity = null;
  if (present(o.quantity)) {
    quantity = parseDecimal(o.quantity, "offer.quantity");
    if (quantity <= 0n) throw new InvalidInput("offer.quantity", `must be greater than zero; got ${got(o.quantity)}.`);
  }
  return {
    unit_price: parseDecimal(o.unit_price, "offer.unit_price"),
    currency: parseCurrency(o.currency, "offer.currency"),
    quantity,
    offered_at: present(o.offered_at) ? parseInstant(o.offered_at, "offer.offered_at") : null,
    seller: present(o.seller) ? parseText(o.seller, "offer.seller") : null,
    sku: present(o.sku) ? parseText(o.sku, "offer.sku") : null,
  };
}

function parseCap(c) {
  closed(c, "cap", CAP_KEYS);
  required(c, "cap", ["amount", "currency", "scope"]);
  if (typeof c.scope !== "string" || !SPEND_CAP_SCOPES.includes(c.scope)) {
    throw new InvalidInput("cap.scope", `must be "per_purchase" (the cap applies to this offer alone) or "per_period" (the cap applies to a period, with already_spent counting what it has already consumed); got ${got(c.scope)}.`);
  }
  if (c.scope === "per_purchase") {
    if (present(c.already_spent)) throw new InvalidInput("cap.already_spent", `belongs to a per_period cap; a per_purchase cap applies to this offer alone, so nothing can already be spent against it; got ${got(c.already_spent)}.`);
    if (present(c.period)) throw new InvalidInput("cap.period", "belongs to a per_period cap; a per_purchase cap has no period.");
  }
  let period = null;
  if (present(c.period)) {
    closed(c.period, "cap.period", PERIOD_KEYS);
    required(c.period, "cap.period", PERIOD_KEYS);
    const from = parseInstant(c.period.from, "cap.period.from");
    const to = parseInstant(c.period.to, "cap.period.to");
    if (to <= from) throw new InvalidInput("cap.period.to", `must be later than cap.period.from; got from ${got(c.period.from)} and to ${got(c.period.to)}. The period runs from "from" up to, but not including, "to".`);
    period = { from, to };
  }
  return {
    cap_id: present(c.cap_id) ? parseText(c.cap_id, "cap.cap_id") : null,
    amount: parseDecimal(c.amount, "cap.amount"),
    currency: parseCurrency(c.currency, "cap.currency"),
    scope: c.scope,
    already_spent: present(c.already_spent) ? parseDecimal(c.already_spent, "cap.already_spent") : 0n,
    already_spent_given: present(c.already_spent),
    period,
  };
}

function parseInput(input) {
  closed(input, "input", ["offer", "cap"]);
  required(input, "input", ["offer", "cap"]);
  return { offer: parseOffer(input.offer), cap: parseCap(input.cap) };
}

// ── the rule ──────────────────────────────────────────────────────

/**
 * Evaluate the check. Returns either
 *   { invalid: true, path, message }       the input could not be read as declared
 *   { state, reason, evidence }            the check ran
 */
export function evaluateSpendCap(input) {
  let parsed;
  try { parsed = parseInput(input); }
  catch (e) {
    if (e instanceof InvalidInput) return { invalid: true, path: e.path, message: e.message };
    throw e;
  }
  const { offer, cap } = parsed;
  const steps = [];
  const base = {
    rule_id: SPEND_CAP_RULE_ID,
    cap_source: "caller_supplied",
    offer_sha256: sha256(jcs(input.offer)),
    cap_sha256: sha256(jcs(input.cap)),
    offer: input.offer,
    cap: input.cap,
  };
  let offer_total = null, remaining = null;
  const done = (state, reason, extra) => ({
    state,
    reason,
    evidence: {
      ...base,
      state,
      reason,
      reason_text: reason ? SPEND_CAP_REASONS[reason] : null,
      offer_total,
      remaining,
      excess: null,
      cap_already_exhausted: false,
      ...extra,
      steps,
    },
  });

  // 1. currency (no conversion)
  steps.push({ step: "currency", rule: "cap.currency equals offer.currency; no conversion", matches: cap.currency === offer.currency });
  if (cap.currency !== offer.currency) return done("indeterminate", "currency_mismatch", { offer_currency: offer.currency, cap_currency: cap.currency });

  // 2. quantity present
  steps.push({ step: "quantity", rule: "offer.quantity is present; without it no total can be computed", present: offer.quantity !== null });
  if (offer.quantity === null) return done("indeterminate", "quantity_missing");

  // 3. total, exact
  const totalScaled = (offer.unit_price * offer.quantity) / SCALE_FACTOR;   // both at scale 16, product at scale 32, back to 16: exact, since inputs carry at most 8 fraction digits
  offer_total = formatDecimal(totalScaled);
  steps.push({ step: "total", rule: "offer_total = unit_price × quantity by exact decimal arithmetic; nothing is rounded", offer_total });

  // 4. remaining cap
  if (cap.scope === "per_purchase") {
    remaining = formatDecimal(cap.amount);
    steps.push({ step: "remaining_cap", rule: "per_purchase: remaining = cap.amount", scope: "per_purchase", remaining });
  } else {
    if (cap.period === null) {
      steps.push({ step: "remaining_cap", rule: "per_period: cap.period.from and cap.period.to are required", scope: "per_period", period_present: false });
      return done("indeterminate", "period_bounds_missing");
    }
    if (offer.offered_at === null) {
      steps.push({ step: "remaining_cap", rule: "per_period: offer.offered_at is required to place the offer in the period", scope: "per_period", period_present: true, offer_time_present: false });
      return done("indeterminate", "offer_time_missing");
    }
    const inPeriod = offer.offered_at >= cap.period.from && offer.offered_at < cap.period.to;
    if (!inPeriod) {
      steps.push({ step: "remaining_cap", rule: "per_period: period.from <= offered_at < period.to (end exclusive)", scope: "per_period", period_present: true, offer_time_present: true, offer_in_period: false });
      return done("indeterminate", "offer_outside_period", { period: input.cap.period, offered_at: input.offer.offered_at });
    }
    const rem = cap.amount - cap.already_spent;
    remaining = formatDecimal(rem);
    steps.push({ step: "remaining_cap", rule: "per_period: period.from <= offered_at < period.to (end exclusive); remaining = cap.amount − already_spent (already_spent defaults to 0 and may exceed amount)", scope: "per_period", period_present: true, offer_time_present: true, offer_in_period: true, already_spent: formatDecimal(cap.already_spent), already_spent_given: cap.already_spent_given, remaining });
  }

  // 5. compare
  const remScaled = cap.scope === "per_purchase" ? cap.amount : cap.amount - cap.already_spent;
  steps.push({ step: "compare", rule: "offer_total <= remaining by exact decimal value (\"1\" equals \"1.00\"); no tolerance, no rounding", fits: totalScaled <= remScaled });
  if (totalScaled <= remScaled) return done("verified", null);
  return done("contradicted", "cap_exceeded", { excess: formatDecimal(totalScaled - remScaled), cap_already_exhausted: remScaled <= 0n });
}
