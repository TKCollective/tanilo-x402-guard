# Changelog

## 0.1.1 (2026-10-15)

- Package metadata only: npm keywords. No behavior change: the code, the types and the copied published rules are
  the same as in 0.1.0.
- Signed mode was smoke-tested against the live Tanilo API (https://api.tanilo.io) on 2026-10-15, with 0.1.0
  installed from npm: a matching and a contradicted contract price, and a spend cap within and over the cap. Each
  signed result equaled local mode on the same inputs, and each receipt verified offline with
  tanilo-receipt-verify 0.2.1.

## 0.1.0 (2026-10-14)

- First release.
