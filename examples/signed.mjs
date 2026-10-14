// Signed-mode example. Documented, not run in tests: it calls the live Tanilo API.
//
// What it sends: for each payment, POST https://api.tanilo.io/v1/verify-facts with the offer built from the
// payment (price, currency, seller, sku, unit, quantity, time), your terms for that resource, your cap and what
// alreadySpent() returned. The signed receipt carries those inputs. No key is needed during the beta.
//
// What you get: decision.receipt = { jws, canonical_sha256, kid, signature_checked }, passed to onDecision.
// Keep it; tanilo-receipt-verify checks it offline (see README).
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { taniloGuard } from "@tanilo/x402-guard";

const NET = "eip155:8453";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

// Optional: check each receipt's signature against Tanilo's published key set before its result is used.
const jwks = await (await fetch("https://tanilo.io/.well-known/jwks.json")).json();

const client = new x402Client();
// client.register(NET, yourScheme)   // your real payment scheme, for example from @x402/evm
client.onBeforePaymentCreation(taniloGuard({
  mode: "signed",
  jwks,
  timeoutMs: 3000,
  onUnavailable: "block",           // no readable signed answer: do not pay
  assets: { [NET]: { [USDC]: { currency: "USD", decimals: 6 } } },
  terms: [{
    resource: "https://seller.example/weather",
    seller: "seller.example", sku: "api.weather.v1", unit: "call",
    terms: [{ agreement_id: "MSA-2026-014", version: "1", seller: "seller.example", product_scope: { skus: ["api.weather.v1"] },
              currency: "USD", unit: "call", price_per_unit: "1.00", effective_from: "2026-01-01T00:00:00Z" }],
  }],
  cap: {
    cap_id: "october", amount: "50.00", currency: "USD", scope: "per_period",
    period: { from: "2026-10-01T00:00:00Z", to: "2026-11-01T00:00:00Z" },
    alreadySpent: async () => "12.00",   // from your own ledger; the guard does not track spending
  },
  onDecision: async (d) => {
    console.log(d.allow ? "allow" : "abort", d.reason ?? "");
    if (d.receipt) console.log("receipt", d.receipt.canonical_sha256, d.receipt.kid);
  },
}));

export const fetchWithPay = wrapFetchWithPayment(fetch, client);
