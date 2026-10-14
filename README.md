# tanilo-x402-guard

A before-payment guard for x402 clients. Before your agent pays, it checks the payment against your own
terms and your own budget, and stops the payment if they disagree.

It plugs into x402's `onBeforePaymentCreation` hook (tested with `@x402/core` 2.19.0 and 2.28.0). The checks are Tanilo's
published rules, [contract price](https://tanilo.io/docs/contract-price-check) and
[spend cap](https://tanilo.io/docs/spend-cap-check), run unchanged.

```js
import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { taniloGuard } from "tanilo-x402-guard";

const client = new x402Client();            // register your payment scheme as usual
client.onBeforePaymentCreation(taniloGuard({
  assets: { "eip155:8453": { "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913": { currency: "USD", decimals: 6 } } },
  terms: [{
    resource: "https://seller.example/weather",
    seller: "seller.example", sku: "api.weather.v1", unit: "call",
    terms: [{ agreement_id: "MSA-2026-014", version: "1", seller: "seller.example",
              product_scope: { skus: ["api.weather.v1"] }, currency: "USD", unit: "call",
              price_per_unit: "1.00", effective_from: "2026-01-01T00:00:00Z" }],
  }],
  cap: { cap_id: "per-call", amount: "5.00", currency: "USD", scope: "per_purchase" },
  onDecision: (d) => console.log(d.allow, d.reason),
}));
const fetchWithPay = wrapFetchWithPayment(fetch, client);
```

A stopped payment makes the x402 client throw `Payment creation aborted: <reason>`. Through `@x402/fetch` the
message starts `Failed to create payment payload:`.

The guard sees the one payment option the client has already chosen. From 2.28, the x402 client applies its own
spend controls first (by default a $1 cap per payment on the assets it recognizes); a payment they reject never
reaches the guard.

## What it checks

- **Contract price** (`contract-price-match/v0.1`): whether the price the seller asks for matches the price in
  the terms you supplied for that resource. The unit price is the payment's amount divided by the quantity you
  set for that resource (default 1).
- **Spend cap** (`spend-cap/v0.1`): whether the payment fits within the cap you supplied. For a cap per period,
  you supply `alreadySpent()`, which is called for every payment.

Each result names what it compared, for example "the offered price matches the supplied term under
contract-price-match/v0.1". Results computed in local mode are labelled unsigned.

## What it does not check

- Whether your terms or your cap are authentic, complete or current. You supply them.
- Who the seller is. A payment address you name next to the terms is compared as a string; nothing more.
- Whether anything will be delivered, or whether paying is a good idea.
- It does not reserve funds or keep track of spending. `alreadySpent()` is yours: count what was paid, and
  allow for payments in flight.

## Amounts

The payment's atomic amount is converted with exact decimal arithmetic, using the decimals in your `assets` map.
Nothing is assumed: an asset that is not in your map gives an indeterminate result, and a stablecoin counts as
USD only if your map says so. Amounts the published rules cannot hold exactly (more than 8 digits after the
point) are indeterminate, never rounded.

## Results and default policies

| Result | Meaning | Default |
| --- | --- | --- |
| verified | the check ran and the payment agrees with your terms or cap | allow |
| contradicted | the check ran and the payment disagrees | always stop |
| indeterminate | the check could not compare (for example no term in effect, an unmapped asset) | `onIndeterminate: "block"` |
| not_evaluated | you supplied no terms for this resource, or no cap | `onNotEvaluated: "allow"` |
| unavailable | signed mode only: the Tanilo API gave no readable signed answer | `onUnavailable: "block"` |

Why: a payment that could not be compared is stopped, because the guard cannot tell a harmless gap from a
wrong price. A resource you gave no terms for is allowed, because otherwise every unlisted purchase would stop;
set `onNotEvaluated: "block"` to allow only what you listed. Every result is passed to `onDecision`, whatever
the policy.

## Modes

- **`mode: "local"`** (default): the rules run inside your process. Nothing is sent anywhere. Results are
  unsigned.
- **`mode: "signed"`**: the guard sends the payment's terms and the inputs you supplied (the offer, your terms,
  your cap and what `alreadySpent()` returned) to the Tanilo API, `POST https://api.tanilo.io/v1/verify-facts`,
  and gets a signed receipt back. The receipt carries those inputs. No key is needed during the beta; requests
  are rate-limited. The guard also runs the rules locally, sends only input they can read, and reads each
  result from the signed payload. If the API does not answer in `timeoutMs` (default 3000), answers anything
  but 200, or gives no readable signed receipt, the result is unavailable; no result is assumed. If you pass
  `jwks`, the receipt's signature is checked before its result is used.

The hook can only allow or stop a payment, so receipts come out through `onDecision(decision)`:
`decision.receipt` holds `jws`, `canonical_sha256` and `kid`.

## Checking a receipt offline

```bash
pip install tanilo-receipt-verify
```

```python
import json, urllib.request
from tanilo_receipt_verify import verify

receipt = {"jws": decision_receipt["jws"], "canonical_sha256": decision_receipt["canonical_sha256"]}
keys = json.load(urllib.request.urlopen("https://tanilo.io/.well-known/jwks.json"))
print(verify(receipt, jwks_by_issuer={"https://tanilo.io/.well-known/jwks.json": keys}).status)
```

## Options

`mode`, `terms`, `cap`, `assets`, `onIndeterminate`, `onNotEvaluated`, `onUnavailable`, `timeoutMs`,
`baseUrl`, `jwks`, `agentId`, `fetch`, `now`, `onDecision`. Types are in `src/index.d.ts`. `terms` is a list of
entries, each with `resource` (an exact URL) or `resourcePrefix`, the offer fields a payment does not carry
(`seller`, `sku`, `unit`, optional `quantity`), optional `payTo`, and `terms` in the contract-price-match input
shape.

## Licence

Apache-2.0. The copied rules are Apache-2.0; the test vectors are CC0-1.0.
