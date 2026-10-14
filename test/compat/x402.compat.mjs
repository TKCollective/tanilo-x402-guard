// Runs the guard inside the real x402 client and @x402/fetch, at the version installed in X402_DIR
// (test/compat/<version>/node_modules). Started by test/compat/run.mjs for each version.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { createRequire } from "node:module";
import { taniloGuard } from "../../src/index.js";
import { startMockSeller, mockScheme } from "../../examples/mock-seller.mjs";

const DIR = process.env.X402_DIR;
const require = createRequire(path.join(DIR, "noop.js"));
const { wrapFetchWithPayment, x402Client } = require("@x402/fetch");
const { encodePaymentRequiredHeader } = require("@x402/core/http");
const VERSION = JSON.parse(fs.readFileSync(path.join(DIR, "@x402", "core", "package.json"), "utf8")).version;

const NET = "eip155:8453";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const PAY_TO = "0x1111111111111111111111111111111111111111";
const ASSETS = { [NET]: { [USDC]: { currency: "USD", decimals: 6 } } };

async function setup(guardOptions) {
  let price = "2000000";
  const seller = await startMockSeller({ encodePaymentRequiredHeader, price: () => price, network: NET, asset: USDC, payTo: PAY_TO });
  const decisions = [];
  const client = new x402Client();
  // 2.28.0 filters requirements by its own spend controls before any hook runs, and by default allows only the
  // assets its scheme recognizes. The mock scheme recognizes none, so allow any asset here (its USD cap then
  // applies to nothing). 2.19.0 has no spend controls.
  if (typeof client.setSpendControls === "function") client.setSpendControls({ allowedAssets: true });
  const chained = client.register(NET, mockScheme).onBeforePaymentCreation(taniloGuard({
    assets: ASSETS,
    terms: [{ resource: seller.url, seller: "seller.example", sku: "api.weather.v1", unit: "call",
      terms: [{ agreement_id: "MSA-2026-014", version: "1", seller: "seller.example", product_scope: { skus: ["api.weather.v1"] }, currency: "USD", unit: "call", price_per_unit: "1.00", effective_from: "2026-01-01T00:00:00Z" }] }],
    onDecision: (d) => decisions.push(d),
    ...guardOptions,
  }));
  return { seller, decisions, client, chained, fetchWithPay: wrapFetchWithPayment(fetch, client), setPrice: (p) => { price = p; } };
}

test(`@x402/core ${VERSION}: onBeforePaymentCreation accepts the guard and returns the client`, async () => {
  const s = await setup();
  try { assert.equal(s.chained, s.client); } finally { await s.seller.close(); }
});

test(`@x402/core ${VERSION}: a wrong price is stopped before any payment is created; the corrected price goes through`, async () => {
  const s = await setup();
  try {
    await assert.rejects(s.fetchWithPay(s.seller.url), (e) => {
      assert.match(e.message, /Payment creation aborted: @tanilo\/x402-guard: contract_price_match contradicted: offered 2\.00 USD above term price 1\.00/);
      return true;
    });
    assert.equal(s.seller.seen.paid, 0);
    assert.equal(s.decisions.at(-1).allow, false);

    s.setPrice("1000000");
    const res = await s.fetchWithPay(s.seller.url);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { forecast: "sunny", paid: true });
    assert.equal(s.seller.seen.paid, 1);
    assert.equal(s.decisions.at(-1).allow, true);
    assert.equal(s.decisions.at(-1).requirement.resource, s.seller.url);
  } finally { await s.seller.close(); }
});

test(`@x402/core ${VERSION}: a resource with no terms is allowed (not_evaluated) and reported`, async () => {
  const s = await setup({ terms: [] });
  try {
    s.setPrice("1000000");
    const res = await s.fetchWithPay(s.seller.url);
    assert.equal(res.status, 200);
    assert.equal(s.decisions.at(-1).checks[0].status, "not_evaluated");
  } finally { await s.seller.close(); }
});

test(`@x402/core ${VERSION}: the hook context carries what the guard reads`, async () => {
  const s = await setup();
  try {
    s.setPrice("1000000");
    await s.fetchWithPay(s.seller.url);
    const r = s.decisions.at(-1).requirement;
    assert.deepEqual({ network: r.network, asset: r.asset, amount: r.amount, payTo: r.payTo, scheme: r.scheme }, { network: NET, asset: USDC, amount: "1000000", payTo: PAY_TO, scheme: "exact" });
  } finally { await s.seller.close(); }
});

test(`@x402/core ${VERSION}: signed mode inside the client (mock API): a contradicted receipt stops the payment and reaches onDecision`, async () => {
  const { mockApi, TEST_JWKS } = await import("../helpers.mjs");
  const api = mockApi();
  const s = await setup({ mode: "signed", fetch: api.fetchImpl, baseUrl: "https://api.test", jwks: TEST_JWKS });
  try {
    await assert.rejects(s.fetchWithPay(s.seller.url), /contract_price_match contradicted: offered 2\.00 USD above term price 1\.00 under contract-price-match\/v0\.1 \(signed receipt\)/);
    const d = s.decisions.at(-1);
    assert.equal(d.receipt.signature_checked, true);
    assert.equal(api.calls.length, 1);
    assert.equal(s.seller.seen.paid, 0);
  } finally { await s.seller.close(); }
});
