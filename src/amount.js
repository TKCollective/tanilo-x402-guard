// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 TK Collective LLC
//
// Exact conversion of an x402 atomic amount (an integer string) into the decimal string the published
// rules read. BigInt only: no floating point anywhere.

const ATOMIC_RE = /^(0|[1-9]\d{0,77})$/;
// What the published rules accept: at most 18 digits before the point and 8 after.
const MAX_INT_DIGITS = 18;
const MAX_FRACTION_DIGITS = 8;

/**
 * atomicToDecimal("2000000", 6) -> { ok: true, value: "2" }
 * The value is the exact amount with trailing fraction zeros removed. Returns { ok: false, why } when the
 * string is not an atomic amount, the decimals are not a sane integer, or the exact value cannot be written
 * in the rules' format (more than 18 integer digits or more than 8 fraction digits after removing zeros).
 */
export function atomicToDecimal(atomic, decimals) {
  if (typeof atomic !== "string" || !ATOMIC_RE.test(atomic)) {
    return { ok: false, why: `the requirement's amount must be an integer string of atomic units; got ${describe(atomic)}` };
  }
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    return { ok: false, why: `the asset's decimals must be an integer from 0 to 36; got ${describe(decimals)}` };
  }
  const padded = atomic.padStart(decimals + 1, "0");
  const intPart = padded.slice(0, padded.length - decimals).replace(/^0+(?=\d)/, "");
  const fracPart = decimals === 0 ? "" : padded.slice(padded.length - decimals).replace(/0+$/, "");
  if (intPart.length > MAX_INT_DIGITS) {
    return { ok: false, why: `the amount has more than ${MAX_INT_DIGITS} digits before the point, which the published rules do not read` };
  }
  if (fracPart.length > MAX_FRACTION_DIGITS) {
    return { ok: false, why: `the amount has ${fracPart.length} significant digits after the point; the published rules read at most ${MAX_FRACTION_DIGITS}, and nothing is rounded` };
  }
  return { ok: true, value: fracPart ? `${intPart}.${fracPart}` : intPart };
}

// Exact division of a decimal string by a positive decimal quantity, for a unit price. Returns null when the
// quotient is not exact within 8 fraction digits (nothing is rounded).
export function divideExact(total, quantity) {
  const t = toScaled(total), q = toScaled(quantity);
  if (t === null || q === null || q === 0n) return null;
  const S = 10n ** 8n;
  const num = t * S;
  if (num % q !== 0n) return null;
  return fromScaled(num / q);
}

function toScaled(s) {
  const m = /^(0|[1-9]\d{0,17})(?:\.(\d{1,8}))?$/.exec(s);
  if (!m) return null;
  return BigInt(m[1]) * 10n ** 8n + BigInt((m[2] || "").padEnd(8, "0"));
}

function fromScaled(v) {
  const S = 10n ** 8n;
  const int = v / S;
  const frac = (v % S).toString().padStart(8, "0").replace(/0+$/, "");
  return frac ? `${int}.${frac}` : `${int}`;
}

// Two decimal places at least, for messages ("2" -> "2.00", "0.125" -> "0.125").
export function display(dec) {
  if (typeof dec !== "string") return String(dec);
  const [i, f = ""] = dec.split(".");
  return `${i}.${f.padEnd(2, "0")}`;
}

function describe(v) {
  if (v === undefined) return "nothing";
  if (v === null) return "null";
  if (typeof v === "string") return JSON.stringify(v.length > 40 ? v.slice(0, 40) + "…" : v);
  if (typeof v === "number") return `the number ${v}`;
  return typeof v;
}
