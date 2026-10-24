# Changelog

## Unreleased

- A terms entry may now name the `asset` and `network` you agreed to, alongside `payTo`. New guard checks
  `asset_match` and `network_match` compare them with the payment's; a mismatch is contradicted and always stops
  the payment, before it is created. Before this change a payment whose amount matched the supplied term but
  whose asset or network differed (among the assets in your map) was allowed; so was a changed recipient when the
  entry named no `payTo`.
- Behavior change: `payee_match`, `asset_match` and `network_match` are now reported as `not_evaluated` when the
  entry does not name the field (previously `payee_match` was simply absent), and follow `onNotEvaluated`. With
  the default `onNotEvaluated: "allow"` nothing changes for such payments; with `onNotEvaluated: "block"` a terms
  entry must now name all three, or those payments stop.
- `decision.inputs.terms_entry` carries `asset` and `network` next to `payTo`.

## 0.1.1 (2026-10-15)

- Package metadata only: npm keywords. No behavior change: the code, the types and the copied published rules are
  the same as in 0.1.0.
- Signed mode was smoke-tested against the live Tanilo API (https://api.tanilo.io) on 2026-10-15, with 0.1.0
  installed from npm: a matching and a contradicted contract price, and a spend cap within and over the cap. Each
  signed result equaled local mode on the same inputs, and each receipt verified offline with
  tanilo-receipt-verify 0.2.1.

## 0.1.0 (2026-10-14)

- First release.
