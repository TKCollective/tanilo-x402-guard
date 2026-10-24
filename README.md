# @tanilo/x402-guard

A before-payment guard for x402 clients. Before your agent pays, it checks the payment against the terms and budget you supply, and stops the payment when a check finds they disagree. What happens when a check can't run, or when you supplied nothing to check against, is set by your policies (see Results and default policies).

```bash
npm install @tanilo/x402-guard @x402/core @x402/fetch
```

You also need the x402 payment scheme package for your network, for example `@x402/evm`.

Status: early release (0.1.x). The rules are contract-price-match/v0.1 and spend-cap/v0.1.

It plugs into x402's `onBeforePaymentCreation` hook. Supports x402 v2 only. The peer dependency range is
`@x402/core >=2.19.0 <3`; the versions actually tested are 2.19.0 and 2.28.0, and the versions in between
are not tested. The checks are Tanilo's published rules,
[contract price](https://tanilo.io/docs/contract-price-check) and
[spend cap](https://tanilo.io/docs/spend-cap-check), run unchanged. The rules and their CC0 test vectors are
published in [tanilo-receipt-spec](https://github.com/TKCollective/tanilo-receipt-spec):
[`checks/contract-price-match/`](https://github.com/TKCollective/tanilo-receipt-spec/tree/4d8ca9f498a3ff00f650db83b13dbb8f2b2448f7/checks/contract-price-match)
(`contract-price.js`, `contract-price.vectors.json`) and
[`checks/spend-cap/`](https://github.com/TKCollective/tanilo-receipt-spec/tree/4d8ca9f498a3ff00f650db83b13dbb8f2b2448f7/checks/spend-cap)
(`spend-cap.js`, `spend-cap.vectors.json`), at the commit this package copies (`4d8ca9f`). More at
[tanilo.io](https://tanilo.io).

This is an integration fragment: yourScheme is the x402 payment scheme client for your network, built with its scheme package and your signer. For a complete runnable version with a mock seller and mock scheme, see examples/fetch-local.mjs.

```js
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { taniloGuard } from "@tanilo/x402-guard";

const NET = "eip155:8453";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

const client = new x402Client();
client.register(NET, yourScheme);                             // your x402 payment scheme client
client.onBeforePaymentCreation(taniloGuard({
  mode: "local",
  assets: { [NET]: { [USDC]: { currency: "USD", decimals: 6 } } },   // your choice: this maps USDC on Base to USD
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

`x402Client` is defined in `@x402/core` (`@x402/core/client`); `@x402/fetch` re-exports the same class, so the
import above and the one in `examples/fetch-local.mjs` are the same. The example runs with a mock seller and a
mock scheme: `cd examples && npm install && node fetch-local.mjs`.

A stopped payment makes the x402 client throw `Payment creation aborted: <reason>`. Through `@x402/fetch` the
message starts `Failed to create payment payload:`.

The guard sees the one payment option the client has already chosen. In 2.28.0 (not in 2.19.0; versions in between not checked), the x402 client applies its own
spend controls first (by default a $1 cap per payment on the assets it recognizes); a payment they reject never
reaches the guard.

## What it checks

- **Contract price** (`contract-price-match/v0.1`): whether the price the seller asks for matches the price in
  the terms you supplied for that resource. The unit price is the payment's amount divided by the quantity you
  set for that resource (default 1).
- **Spend cap** (`spend-cap/v0.1`): whether the payment fits within the cap you supplied. For a cap per period,
  you supply `alreadySpent()`, which is called for every payment.
- **Payment address, asset and network** (`payee_match`, `asset_match`, `network_match`: guard checks, not
  published Tanilo rules): your terms entry may name the `payTo`, `asset` and `network` you agreed to. Each one
  named is compared with the payment's (EVM addresses without regard to letter case, other addresses and the
  network exactly). A different address, asset or network is contradicted, with both values named, and stops the
  payment; for the address only, `onPayeeMismatch: "allow"` lets it through. One you do not name is
  not_evaluated and follows `onNotEvaluated`, like a resource you gave no terms for. A price match alone does
  not establish who is paid or in what: a seller can keep the amount and change the recipient. These checks are
  never sent to the Tanilo API and never appear in a receipt.

Each result names what it compared, for example "the offered price matches the supplied term under
contract-price-match/v0.1". Results computed in local mode are labeled unsigned.

The offer time is the time the hook runs, from the system clock, or from your `now()` option if you give one.
The rules read no clock, so the guard supplies it. The time used, and where it came from, are in
`decision.inputs`.

## What it does not check

- Whether your terms or your cap are authentic, complete or current. You supply them.
- Who the seller is. `payee_match` only compares two addresses; it does not establish who controls either.
  `asset_match` and `network_match` likewise compare identifiers you supplied; they do not establish what the
  asset is worth or that the network is the one you think.
- Whether anything will be delivered, or whether paying is a good idea.
- It does not reserve funds or keep track of spending. Your system supplies `alreadySpent()` and must handle purchases made at the same time: two payments checked against the same remaining budget can both pass and together exceed it.

## Amounts

The payment's atomic amount is converted with exact decimal arithmetic, using the decimals in your `assets` map.
Nothing is assumed: an asset that is not in your map gives an indeterminate result, and a stablecoin counts as
USD only if your map says so. Amounts the published rules cannot hold exactly (more than 8 digits after the
point) are indeterminate, never rounded.

## Results and default policies

| Check state | Meaning | Default |
| --- | --- | --- |
| verified | the check matched what you supplied: the price term, the cap, or the payment address, asset or network | doesn't allow the payment by itself; the other checks and policies still apply |
| contradicted | the check ran and the payment disagrees | always stops, except `payee_match`, which follows `onPayeeMismatch` (default block) |
| indeterminate | the check could not compare (for example no term in effect, an unmapped asset) | `onIndeterminate: "block"` |
| not_evaluated | you supplied no terms for this resource, or no cap, or your terms entry names no `payTo`, `asset` or `network` | `onNotEvaluated: "allow"` |

unavailable is a guard outcome in signed mode, not a check state: the Tanilo API gave no readable signed answer.
Default `onUnavailable: "block"`.

Why: a payment that could not be compared is stopped, because the guard cannot tell a harmless gap from a
wrong price. A resource you gave no terms for is allowed, because otherwise every unlisted purchase would stop.
Set `onNotEvaluated: "block"` to stop the payment whenever a check is not evaluated, including when no terms entry matches or no cap is supplied. Every result is passed to `onDecision`, whatever
the policy.

## Finding your terms for a payment

Each `terms` entry has a `resource` URL. By default it must equal the resource URL in the seller's 402
response exactly. With `match: "prefix"`, the entry also covers URLs below it, but only on the same origin
(scheme, host and port) and only at a path-segment boundary: `https://seller.example/api/a` covers
`/api/a` and `/api/a/x`, never `/api/ab`. Prefix matching ignores the resource URL's query string, and a prefix you configure may not contain a query string or fragment. An exact entry beats a prefix entry, and the longest prefix wins. Two
entries that match equally well give an indeterminate result. A payment with no matching entry is
not_evaluated for the contract price.

## Modes

- **`mode: "local"`** (default): the rules run inside your process. The guard makes no network requests and sends nothing to Tanilo. Results are unsigned.
- **`mode: "signed"`**: the guard sends the payment's terms and the inputs you supplied (the offer, your terms,
  your cap and what `alreadySpent()` returned) to the Tanilo API, `POST https://api.tanilo.io/v1/verify-facts`,
  and gets a signed receipt back. The receipt carries those inputs. No key is needed during the beta; requests
  are rate-limited. The guard also runs the rules locally, sends only input they can read, and reads each
  result from the signed payload. If the API does not answer in `timeoutMs` (default 3000), answers anything
  but 200, or gives no readable signed receipt, the result is unavailable; no result is assumed. If you pass `jwks`, use a copy of Tanilo's key set you have obtained over HTTPS from tanilo.io and trust; the receipt's signature is checked against it before its result is used. Without it, signed
  mode uses the API's result after cross-checking it against the local rule (a different result is treated as
  unavailable), and the receipt can be verified offline later.

A signed receipt contains the inputs sent for the checks it covers: the offer, plus your terms, your cap and the amount already spent where those checks ran. Anyone you share a receipt with can read them. What the Tanilo API keeps is described in Tanilo's [privacy notice](https://tanilo.io/privacy).

The API requires `subject.claim_hash`. The guard sets it to `sha256-` followed by the SHA-256 hex digest of the
RFC 8785 canonical JSON of the one check's `input` object when it sends one check (the same value tanilo-mcp
computes), and of the whole `checks` array when it sends two.

The hook can only allow or stop a payment, so receipts come out through `onDecision(decision)`:
`decision.receipt` holds `jws`, `canonical_sha256` and `kid`.

## Checking a receipt offline

In signed mode, receipts come out through `onDecision`. For a one-receipt demo, use this callback (import fs at the top of your module). It overwrites receipt.json each time; in real use, store each receipt separately.

```js
import fs from "node:fs";

// in taniloGuard({ ..., onDecision })
onDecision: (decision) => {
  if (decision.receipt) fs.writeFileSync("receipt.json", JSON.stringify(decision.receipt, null, 2));
},
```

Get Tanilo's key set over HTTPS from tanilo.io and keep that copy for offline checks. If a later receipt was signed with a newer key, fetch the key set again.

```bash
curl -sS -o jwks.json https://tanilo.io/.well-known/jwks.json
```

Then check the receipt with [tanilo-receipt-verify](https://pypi.org/project/tanilo-receipt-verify/)
(`pip install tanilo-receipt-verify`). The verify step itself makes no network call:

```python
import json
from tanilo_receipt_verify import verify

with open("receipt.json") as f:
    receipt = json.load(f)
with open("jwks.json") as f:
    keys = json.load(f)

result = verify(receipt, jwks_by_issuer={"https://tanilo.io/.well-known/jwks.json": keys})
print(result.status, result.errors)
```

Only `status == "valid"` means the receipt verified. An empty error list on its own does not. A valid receipt shows the check ran on those inputs and was signed by Tanilo; it does not show your terms were genuine, who the seller is, or that the payment should be made.

## Options

`mode`, `terms`, `cap`, `assets`, `onIndeterminate`, `onNotEvaluated`, `onUnavailable`, `onPayeeMismatch`,
`timeoutMs`, `baseUrl`, `jwks`, `agentId`, `fetch`, `now`, `onDecision`. Types are in `src/index.d.ts`. `terms`
is a list of entries, each with `resource`, optional `match` (`"exact"` or `"prefix"`), the offer fields a
payment does not carry (`seller`, `sku`, `unit`, optional `quantity`), optional `payTo`, `asset` and `network`,
and `terms` in the contract-price-match input shape.

## License

Apache-2.0. The copied rules are Apache-2.0; the test vectors are CC0-1.0.
