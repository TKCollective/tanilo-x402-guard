// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 TK Collective LLC
//
// Signed mode: one POST /v1/verify-facts per payment, carrying the checks that could be evaluated. The guard
// reads each check's state from the SIGNED payload, never from the unsigned wrapper around it. Anything it
// cannot read is "unavailable"; it never makes up a state the service did not sign.

import crypto from "node:crypto";
import { jcs } from "./rules/contract-price-jcs.js";

const STATES = new Set(["verified", "contradicted", "indeterminate"]);

const b64uDecode = (s) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
const isB64u = (s) => typeof s === "string" && s.length > 0 && /^[A-Za-z0-9_-]+$/.test(s);
const sha256 = (buf) => `sha256-${crypto.createHash("sha256").update(buf).digest("hex")}`;

/**
 * callService({ baseUrl, timeoutMs, fetchImpl, jwks, agentId, checks }) ->
 *   { ok: true, states: [{ state, reason, evidence }], receipt: { jws, canonical_sha256, kid }, signature_checked }
 *   { ok: false, why }   the service did not give a readable signed answer (timeout, network error, non-200,
 *                        malformed or unsigned response, a check missing, a bad signature when jwks was given)
 * Never throws.
 */
/**
 * subject.claim_hash, which the API requires (HTTP 400 missing_subject_claim_hash without it).
 * One check: "sha256-" + SHA-256 hex of the RFC 8785 canonical JSON of that check's input object, the same value
 * tanilo-mcp and the hosted MCP endpoint compute. Two checks: the same over the whole checks array as sent,
 * [{ check_type, input }, ...]. No claim text is sent.
 */
export function claimHashFor(checks) {
  const target = checks.length === 1 ? checks[0].input : checks;
  return sha256(Buffer.from(jcs(target), "utf8"));
}

export async function callService({ baseUrl, timeoutMs, fetchImpl, jwks, agentId, checks }) {
  const body = {
    subject: { claim_hash: claimHashFor(checks) },
    ...(agentId ? { agent_id: agentId } : {}),
    checks,
  };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res, text;
  try {
    res = await fetchImpl(`${baseUrl.replace(/\/+$/, "")}/v1/verify-facts`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    text = await res.text();
  } catch (e) {
    return { ok: false, why: ctrl.signal.aborted ? `no answer within ${timeoutMs} ms (timeout)` : `network error: ${e?.message || String(e)}` };
  } finally {
    clearTimeout(timer);
  }
  if (res.status !== 200) {
    let detail = "";
    try { const j = JSON.parse(text); if (j && j.status === "not_signed") detail = " (the service ran the checks but signed nothing: not_signed)"; } catch { /* not JSON */ }
    return { ok: false, why: `the service answered HTTP ${res.status}${detail}` };
  }
  let json;
  try { json = JSON.parse(text); } catch { return { ok: false, why: "the service's answer was not JSON" }; }
  return readSignedAnswer(json, checks, jwks);
}

export function readSignedAnswer(json, checks, jwks) {
  if (!json || typeof json !== "object") return { ok: false, why: "the service's answer was not a JSON object" };
  const jws = json.jws;
  const sig = jws && Array.isArray(jws.signatures) && jws.signatures.length === 1 ? jws.signatures[0] : null;
  if (!jws || !isB64u(jws.payload) || !sig || !isB64u(sig.protected) || !isB64u(sig.signature)) {
    return { ok: false, why: "the answer carries no signed receipt (jws with one signature)" };
  }
  let header, payloadBytes, payload;
  try {
    header = JSON.parse(b64uDecode(sig.protected).toString("utf8"));
    payloadBytes = b64uDecode(jws.payload);
    payload = JSON.parse(payloadBytes.toString("utf8"));
  } catch {
    return { ok: false, why: "the receipt's protected header or payload is not readable JSON" };
  }
  if (!header || header.alg !== "EdDSA" || typeof header.kid !== "string") return { ok: false, why: "the receipt's protected header carries no EdDSA kid" };
  const canonical_sha256 = sha256(payloadBytes);
  if (json.canonical_sha256 !== canonical_sha256) return { ok: false, why: "canonical_sha256 does not match the receipt's payload bytes" };
  if (json.kid !== undefined && json.kid !== header.kid) return { ok: false, why: "the answer's kid differs from the receipt's protected header" };

  let signature_checked = false;
  if (jwks) {
    const jwk = Array.isArray(jwks.keys) ? jwks.keys.find((k) => k && k.kid === header.kid) : null;
    if (!jwk || jwk.kty !== "OKP" || jwk.crv !== "Ed25519") return { ok: false, why: `the supplied key set has no Ed25519 key for kid ${header.kid}` };
    try {
      const key = crypto.createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: jwk.x }, format: "jwk" });
      const ok = crypto.verify(null, Buffer.from(`${sig.protected}.${jws.payload}`, "ascii"), key, b64uDecode(sig.signature));
      if (!ok) return { ok: false, why: "the receipt's signature does not verify against the supplied key set" };
    } catch {
      return { ok: false, why: "the receipt's signature could not be checked against the supplied key set" };
    }
    signature_checked = true;
  }

  const results = payload && Array.isArray(payload.check_results) ? payload.check_results : null;
  if (!results || results.length !== checks.length) return { ok: false, why: "the signed payload does not carry one result per check sent" };
  const states = [];
  for (let i = 0; i < checks.length; i++) {
    const r = results[i];
    if (!r || r.check_type !== checks[i].check_type || !STATES.has(r.state)) {
      return { ok: false, why: `the signed payload has no readable state for ${checks[i].check_type}` };
    }
    const reason = r.state === "verified" ? null : (r.failure_reason ?? r.indeterminate_reason ?? r.evidence?.reason ?? null);
    states.push({ state: r.state, reason, evidence: r.evidence ?? null });
  }
  return { ok: true, states, receipt: { jws, canonical_sha256, kid: header.kid }, signature_checked };
}
