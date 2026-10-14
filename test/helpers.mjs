// Test helpers: x402 contexts, a customer's configuration, and a mock of POST /v1/verify-facts that runs the
// published rule and signs the result with a throwaway Ed25519 key, in the response shape of the live route.
import crypto from "node:crypto";
import { jcs } from "../src/rules/contract-price-jcs.js";
import { evaluateLocal } from "../src/index.js";

export const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
export const NET = "eip155:8453";
export const URL_WEATHER = "https://seller.example/weather";
export const ASSETS = { [NET]: { [USDC_BASE]: { currency: "USD", decimals: 6 } } };
export const NOW = () => new Date("2026-10-14T12:00:00.000Z");

export const TERMS = [{
  resource: URL_WEATHER,
  seller: "seller.example",
  sku: "api.weather.v1",
  unit: "call",
  terms: [{ agreement_id: "MSA-2026-014", version: "1", seller: "seller.example", product_scope: { skus: ["api.weather.v1"] }, currency: "USD", unit: "call", price_per_unit: "1.00", effective_from: "2026-01-01T00:00:00Z" }],
}];

export function ctx({ amount = "1000000", url = URL_WEATHER, asset = USDC_BASE, network = NET, payTo = "0x1111111111111111111111111111111111111111", ...rest } = {}) {
  const req = { scheme: "exact", network, asset, amount, payTo, maxTimeoutSeconds: 60, extra: {}, ...rest };
  return { paymentRequired: { x402Version: 2, resource: { url }, accepts: [req] }, selectedRequirements: req };
}

export function recorder() {
  const decisions = [];
  return { decisions, onDecision: (d) => { decisions.push(d); } };
}

// ── mock API ────────────────────────────────────────────────────────────────────────────────────────────────

const b64u = (b) => Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export const TEST_KEY = crypto.generateKeyPairSync("ed25519");
export const TEST_KID = "test-only-ed25519-guard";
export const TEST_JWKS = { keys: [{ ...TEST_KEY.publicKey.export({ format: "jwk" }), kid: TEST_KID }] };

/** What the live route returns for a 200, built from the published rule's output. */
export function signedAnswer(body, { key = TEST_KEY.privateKey, kid = TEST_KID, tamper } = {}) {
  const check_results = body.checks.map((c) => {
    const r = evaluateLocal(c.check_type, c.input);
    const ok = r.state === "verified", ind = r.state === "indeterminate";
    const out = { check_type: c.check_type, outcome: ok ? "pass" : ind ? "indeterminate" : "fail", state: r.state, recommendation: "test", evidence: r.evidence };
    if (!ok) out[ind ? "indeterminate_reason" : "failure_reason"] = r.reason;
    return out;
  });
  if (tamper) tamper(check_results);
  const verdict = check_results.every((c) => c.state === "verified") ? "act" : "halt";
  const payload = { agent_id: "urn:tanilo:verify-facts:anonymous", check_mode: "deterministic", check_results, subject: body.subject, timestamp: "2026-10-14T12:00:00.000Z", v_gate: { verdict } };
  const bytes = Buffer.from(jcs(payload), "utf8");
  const prot = b64u(JSON.stringify({ alg: "EdDSA", kid, typ: "application/vnd.verification.v0.3+composed+jws", role: "evaluated" }));
  const pl = b64u(bytes);
  const sig = b64u(crypto.sign(null, Buffer.from(`${prot}.${pl}`, "ascii"), key));
  return {
    jws: { payload: pl, signatures: [{ protected: prot, signature: sig }] },
    canonical_sha256: `sha256-${crypto.createHash("sha256").update(bytes).digest("hex")}`,
    canonical_bytes_length: bytes.length,
    verdict, check_mode: "deterministic", check_results, kid,
  };
}

/** A fetch that answers like the live route. `behave` can replace the answer. Records every request body. */
export function mockApi(behave) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body });
    if (behave) return behave(body, init);
    return new Response(JSON.stringify(signedAnswer(body)), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { calls, fetchImpl };
}

export const hang = (_body, init) => new Promise((_, reject) => {
  init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
});
