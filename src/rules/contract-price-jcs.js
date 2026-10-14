// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 TK Collective LLC
//
// Canonical JSON (RFC 8785, JCS) for the values the contract-price rule
// hashes and returns: objects, arrays, strings, null, booleans and whole
// numbers (the result carries one count). Numbers with a fraction are refused:
// the rule accepts no JSON numbers as input, and leaving them out removes the
// one part of JCS where implementations differ (number formatting).
//
// Self-contained on purpose, so the rule and its tests can be copied and run
// anywhere with Node and nothing else.
//
// Object members are ordered by UTF-16 code units, as RFC 8785 requires.
// Strings are serialized exactly as ECMAScript JSON.stringify does.

export function jcs(value) {
  if (value === null) return "null";
  if (value === true) return "true";
  if (value === false) return "false";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error("contract-price canonical JSON: only whole numbers are supported");
    return String(value);
  }
  if (Array.isArray(value)) return "[" + value.map(jcs).join(",") + "]";
  if (typeof value === "object") {
    const keys = Object.keys(value).sort((a, b) => {
      const n = Math.min(a.length, b.length);
      for (let i = 0; i < n; i++) {
        const d = a.charCodeAt(i) - b.charCodeAt(i);
        if (d !== 0) return d;
      }
      return a.length - b.length;
    });
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + jcs(value[k])).join(",") + "}";
  }
  throw new Error(`contract-price canonical JSON: unsupported value of type ${typeof value}`);
}
