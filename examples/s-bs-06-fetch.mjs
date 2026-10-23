// End-to-end replay of x402 issue #3866 / S-BS-06 through the real @x402/fetch client (2.28.0) with the guard
// in local mode: a mock seller on 127.0.0.1 declares a ×10 requirement for a resource whose supplied term says
// 0.01 USD per call. No keys, no chain, no network beyond loopback (run it with the local-only guard preloaded
// to prove that). The mock scheme produces a placeholder payload instead of an EIP-3009 signature; the fact
// under test is whether the client reaches payment creation at all.
//
//   cd examples && NODE_OPTIONS="--require <local-only-guard.cjs>" node s-bs-06-fetch.mjs
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { encodePaymentRequiredHeader } from "@x402/core/http";
import { taniloGuard } from "@tanilo/x402-guard";
import { startMockSeller, mockScheme } from "./mock-seller.mjs";

const NET = "eip155:84532";                                         // Base Sepolia, as in the issue
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const PAY_TO = "0x9999999999999999999999999999999999999999";
let price = "100000";                                               // ×10 the canonical 10000 (0.01 USDC)
const seller = await startMockSeller({ encodePaymentRequiredHeader, price: () => price, network: NET, asset: USDC, payTo: PAY_TO });

function makeClient(guardOptions, label) {
  const client = new x402Client();
  client.setSpendControls?.({ allowedAssets: true, maxAmountPerPayment: "$1" });   // the issue's caller-side cap
  client.register(NET, mockScheme);
  let scheme_called = 0; const scheme = { ...mockScheme, async createPaymentPayload(v, req) { scheme_called++; return mockScheme.createPaymentPayload(v, req); } };
  client.register(NET, scheme);
  client.onBeforePaymentCreation(taniloGuard({ mode: "local", assets: { [NET]: { [USDC]: { currency: "USD", decimals: 6 } } }, ...guardOptions, onDecision: (d) => { console.log(`  [${label}] decision: ${d.allow ? "allow" : "abort"}`); for (const c of d.checks) console.log(`    ${c.summary}`); } }));
  return { fetchWithPay: wrapFetchWithPayment(fetch, client), schemeCalls: () => scheme_called };
}
const TERMS = [{ resource: seller.url, seller: "seller.example", sku: "api.weather.v1", unit: "call",
  terms: [{ agreement_id: "BLOCK-B-001", version: "1", seller: "seller.example", product_scope: { skus: ["api.weather.v1"] }, currency: "USD", unit: "call", price_per_unit: "0.01", effective_from: "2026-01-01T00:00:00Z" }] }];
const CAP = { cap_id: "per-payment", amount: "1.00", currency: "USD", scope: "per_purchase" };
const results = [];

console.log("1. Guard with terms + cap; seller declares 100000 (×10).");
{ const c = makeClient({ terms: TERMS, cap: CAP }, "terms+cap");
  try { await c.fetchWithPay(seller.url); results.push(["×10 with terms+cap", "PAID (unexpected)"]); }
  catch (e) { results.push(["×10 with terms+cap", `stopped before payment creation: ${e.message.slice(0, 90)}`]); }
  console.log(`  scheme asked to create a payload: ${c.schemeCalls()} time(s); seller saw paid requests: ${seller.seen.paid}`); }

console.log("\n2. Guard with cap only (the issue's configuration); seller declares 100000 (×10).");
{ const c = makeClient({ cap: CAP }, "cap-only");
  try { const res = await c.fetchWithPay(seller.url); results.push(["×10 with cap only", `PAID: HTTP ${res.status} (the cap alone does not stop it)`]); }
  catch (e) { results.push(["×10 with cap only", `stopped: ${e.message.slice(0, 90)}`]); }
  console.log(`  scheme asked to create a payload: ${c.schemeCalls()} time(s); seller saw paid requests: ${seller.seen.paid}`); }

console.log("\n3. Guard with terms + cap; seller declares the canonical 10000.");
price = "10000";
{ const c = makeClient({ terms: TERMS, cap: CAP }, "terms+cap");
  try { const res = await c.fetchWithPay(seller.url); results.push(["canonical with terms+cap", `paid as expected: HTTP ${res.status}`]); }
  catch (e) { results.push(["canonical with terms+cap", `stopped (unexpected): ${e.message.slice(0, 90)}`]); }
  console.log(`  scheme asked to create a payload: ${c.schemeCalls()} time(s); seller saw paid requests: ${seller.seen.paid}`); }

await seller.close();
console.log("\nRESULTS"); for (const [k, v] of results) console.log(`  ${k}: ${v}`);
console.log(`seller totals: unpaid ${seller.seen.unpaid}, paid ${seller.seen.paid}`);
