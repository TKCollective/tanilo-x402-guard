// Runnable example: @x402/fetch + the guard in local mode + a mock 402 seller on localhost.
// No keys, no chain, no network beyond 127.0.0.1. The seller first asks 2.00 USD for a call your terms price
// at 1.00: the guard stops it. Then it asks 1.00: the payment goes ahead.
//
//   cd examples && npm install && node fetch-local.mjs
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { encodePaymentRequiredHeader } from "@x402/core/http";
import { taniloGuard } from "tanilo-x402-guard";
import { startMockSeller, mockScheme } from "./mock-seller.mjs";

const NET = "eip155:8453";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";   // USDC on Base; 6 decimals, counted as USD because this map says so

let price = "2000000";                                          // 2.00 USDC, in atomic units
const seller = await startMockSeller({ encodePaymentRequiredHeader, price: () => price, network: NET, asset: USDC, payTo: "0x1111111111111111111111111111111111111111" });

const client = new x402Client();
client.setSpendControls?.({ allowedAssets: true });             // @x402/core 2.28+: the mock scheme recognizes no default asset
client.register(NET, mockScheme);
client.onBeforePaymentCreation(taniloGuard({
  mode: "local",
  assets: { [NET]: { [USDC]: { currency: "USD", decimals: 6 } } },
  terms: [{
    resource: seller.url,
    seller: "seller.example", sku: "api.weather.v1", unit: "call",
    terms: [{ agreement_id: "MSA-2026-014", version: "1", seller: "seller.example", product_scope: { skus: ["api.weather.v1"] },
              currency: "USD", unit: "call", price_per_unit: "1.00", effective_from: "2026-01-01T00:00:00Z" }],
  }],
  cap: { cap_id: "per-call", amount: "5.00", currency: "USD", scope: "per_purchase" },
  onDecision: (d) => {
    console.log(`  decision: ${d.allow ? "allow" : "abort"} (${d.mode})`);
    for (const c of d.checks) console.log(`    ${c.summary}`);
  },
}));
const fetchWithPay = wrapFetchWithPayment(fetch, client);

console.log(`1. The seller asks 2.00 USD; the supplied term says 1.00.`);
try {
  await fetchWithPay(seller.url);
  console.log("  unexpected: the payment went ahead");
} catch (e) {
  console.log(`  stopped: ${e.message}`);
}

price = "1000000";
console.log(`\n2. The seller asks 1.00 USD.`);
const res = await fetchWithPay(seller.url);
console.log(`  HTTP ${res.status}: ${await res.text()}`);

console.log(`\nPaid requests the seller received: ${seller.seen.paid}`);
await seller.close();
