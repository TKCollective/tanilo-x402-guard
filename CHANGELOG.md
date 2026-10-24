# Changelog

## 0.2.0 (2026-10-24)

- A terms entry may now name the `asset` and `network` you agreed to, alongside `payTo`. New guard checks
  `asset_match` and `network_match` compare them with the payment's; a mismatch is contradicted and always stops
  the payment, before it is created. Before this change a payment whose amount matched the supplied term but
  whose asset or network differed (among the assets in your map) was allowed; so was a changed recipient when the
  entry named no `payTo`.
- Behavior change: `payee_match`, `asset_match` and `network_match` are now reported as `not_evaluated` when the
  entry does not name the field (previously `payee_match` was simply absent), and follow `onNotEvaluated`. With the
  default onNotEvaluated: "allow", an undeclared recipient, asset or network does not itself block payment creation;
  other checks may still block it. Existing users configured with onNotEvaluated: "block" must now supply all three
  binding fields for an applicable terms entry to pass these checks.
- `decision.inputs.terms_entry` carries `asset` and `network` next to `payTo`.
- Caveat: an undeclared binding is `not_evaluated` and follows `onNotEvaluated`. To require all three bindings,
  declare payTo, asset and network in every applicable terms entry, set onNotEvaluated: "block", and keep
  onPayeeMismatch: "block" (the default). Missing declarations then block payment creation rather than supplying an
  inferred expectation. onNotEvaluated: "block" also applies to other checks reported as not_evaluated, including
  missing price terms or a missing spend cap. We recommend that setting for production. The binding checks are local
  guard checks, not sent to the API and not in the signed receipt.
- Why: a price match alone does not establish who is paid, in what, or where. Found while replaying x402 issue
  #3866 (an inflated 402 amount) against the guard: in 0.1.x a payment at the agreed price but to another
  recipient (entry without `payTo`), in another mapped asset, or on another mapped network was allowed.
- Tests: 79 (12 new in `test/terms-binding.test.mjs`, 11 of which failed on 0.1.1; among them, at the agreed
  price: a changed recipient, a changed asset, and a changed network together with that network's mapped
  asset), plus the compatibility runs inside @x402/core 2.19.0 and 2.28.0. The published rules, their copied code and the vectors are unchanged.
  Signed mode was exercised with a mocked API in the local suite, including assertions that binding checks are
  excluded from API requests and receipt findings. Signed mode was not re-tested against the live API for this
  release.

## 0.1.1 (2026-10-15)

- Package metadata only: npm keywords. No behavior change: the code, the types and the copied published rules are
  the same as in 0.1.0.
- Signed mode was smoke-tested against the live Tanilo API (https://api.tanilo.io) on 2026-10-15, with 0.1.0
  installed from npm: a matching and a contradicted contract price, and a spend cap within and over the cap. Each
  signed result equaled local mode on the same inputs, and each receipt verified offline with
  tanilo-receipt-verify 0.2.1.

## 0.1.0 (2026-10-14)

- First release.
