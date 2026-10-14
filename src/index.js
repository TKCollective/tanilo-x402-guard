// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 TK Collective LLC
//
// tanilo-x402-guard: a before-payment guard for x402 clients. It checks the payment the client is about to
// make against the customer's own supplied terms and cap, using Tanilo's published rules, and returns what
// x402's onBeforePaymentCreation hook accepts: nothing (go ahead) or { abort: true, reason }.
//
// It does not establish that the terms or the cap are authentic or current, who the seller is, or that
// anything will be delivered. It does not reserve funds or keep track of spending.

import { evaluateContractPrice, CONTRACT_PRICE_RULE_ID, CONTRACT_PRICE_REASONS } from "./rules/contract-price.js";
import { evaluateSpendCap, SPEND_CAP_RULE_ID, SPEND_CAP_REASONS } from "./rules/spend-cap.js";
import { atomicToDecimal, divideExact, display } from "./amount.js";
import { callService } from "./signed.js";

export const DEFAULT_BASE_URL = "https://api.tanilo.io";
const MODES = ["local", "signed"];
const POLICIES = ["block", "allow"];
const RULE_ID = { contract_price_match: CONTRACT_PRICE_RULE_ID, spend_cap: SPEND_CAP_RULE_ID };
const REASON_TEXT = { contract_price_match: CONTRACT_PRICE_REASONS, spend_cap: SPEND_CAP_REASONS };

class ConfigError extends Error {}

/**
 * The published rules, run in process. Same answer as the published vectors: { state, reason, evidence } or
 * { invalid: true, path, message }.
 */
export function evaluateLocal(check_type, input) {
  if (check_type === "contract_price_match") return evaluateContractPrice(input);
  if (check_type === "spend_cap") return evaluateSpendCap(input);
  throw new Error(`unknown check_type ${check_type}`);
}

export function taniloGuard(options = {}) {
  const cfg = readOptions(options);
  return async function taniloGuardHook(context) {
    let decision;
    try {
      decision = await decide(cfg, context);
    } catch (e) {
      // Not expected; kept so the hook never throws. Treated as indeterminate, under the configured policy.
      decision = fallbackDecision(cfg, `the guard could not run: ${e?.message || String(e)}`);
    }
    if (cfg.onDecision) {
      try { await cfg.onDecision(decision); } catch { /* the caller's callback must not change the outcome */ }
    }
    return decision.allow ? undefined : { abort: true, reason: decision.reason };
  };
}

// ── options ──────────────────────────────────────────────────────────────────────────────────────────────

function readOptions(o) {
  if (!o || typeof o !== "object") throw new ConfigError("taniloGuard(options): options must be an object");
  const mode = o.mode ?? "local";
  if (!MODES.includes(mode)) throw new ConfigError(`taniloGuard: mode must be "local" or "signed"; got ${JSON.stringify(mode)}`);
  const policy = (name, dflt) => {
    const v = o[name] ?? dflt;
    if (!POLICIES.includes(v)) throw new ConfigError(`taniloGuard: ${name} must be "block" or "allow"; got ${JSON.stringify(v)}`);
    return v;
  };
  const terms = o.terms ?? [];
  if (!Array.isArray(terms)) throw new ConfigError("taniloGuard: terms must be an array of entries (see README)");
  terms.forEach((t, i) => {
    if (!t || typeof t !== "object") throw new ConfigError(`taniloGuard: terms[${i}] must be an object`);
    if (typeof t.resource !== "string" || t.resource.length === 0) throw new ConfigError(`taniloGuard: terms[${i}].resource must be the resource URL`);
    if (t.resourcePrefix !== undefined) throw new ConfigError(`taniloGuard: terms[${i}].resourcePrefix is not an option; set resource and match: "prefix"`);
    const match = t.match ?? "exact";
    if (match !== "exact" && match !== "prefix") throw new ConfigError(`taniloGuard: terms[${i}].match must be "exact" or "prefix"; got ${JSON.stringify(t.match)}`);
    if (match === "prefix" && parsePrefix(t.resource) === null) throw new ConfigError(`taniloGuard: terms[${i}].resource must be an absolute http(s) URL with no query or fragment to be used as a prefix`);
    if (t.payTo !== undefined && (typeof t.payTo !== "string" || t.payTo.length === 0)) throw new ConfigError(`taniloGuard: terms[${i}].payTo must be a non-empty string`);
    if (!Array.isArray(t.terms)) throw new ConfigError(`taniloGuard: terms[${i}].terms must be an array of contract terms in the contract-price-match input shape`);
  });
  const cap = o.cap ?? null;
  if (cap !== null) {
    if (typeof cap !== "object") throw new ConfigError("taniloGuard: cap must be an object in the spend-cap input shape");
    if (cap.scope === "per_period" && typeof cap.alreadySpent !== "function") {
      throw new ConfigError("taniloGuard: a per_period cap needs alreadySpent(), a callback that returns what has already been spent in the period; the guard does not track spending");
    }
    if (cap.already_spent !== undefined) throw new ConfigError("taniloGuard: give already_spent through cap.alreadySpent(), which is called for every payment");
  }
  const assets = o.assets ?? {};
  if (typeof assets !== "object" || Array.isArray(assets)) throw new ConfigError("taniloGuard: assets must be an object keyed by network, then by asset address");
  const timeoutMs = o.timeoutMs ?? 3000;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new ConfigError("taniloGuard: timeoutMs must be a positive integer");
  if (o.onDecision !== undefined && typeof o.onDecision !== "function") throw new ConfigError("taniloGuard: onDecision must be a function");
  if (mode === "signed" && !(o.fetch ?? globalThis.fetch)) throw new ConfigError("taniloGuard: signed mode needs fetch (Node 18+, or pass options.fetch)");
  return {
    mode,
    terms,
    cap,
    assets,
    onIndeterminate: policy("onIndeterminate", "block"),
    onNotEvaluated: policy("onNotEvaluated", "allow"),
    onUnavailable: policy("onUnavailable", "block"),
    onPayeeMismatch: policy("onPayeeMismatch", "block"),
    nowSource: typeof o.now === "function" ? "now() option" : "system clock",
    timeoutMs,
    baseUrl: o.baseUrl ?? DEFAULT_BASE_URL,
    fetchImpl: o.fetch ?? globalThis.fetch,
    jwks: o.jwks ?? null,
    agentId: o.agentId ?? null,
    onDecision: o.onDecision ?? null,
    now: typeof o.now === "function" ? o.now : () => new Date(),
  };
}

// ── one payment ──────────────────────────────────────────────────────────────────────────────────────────

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function readRequirement(context) {
  if (!isObj(context)) return { ok: false, why: "the hook received no context object" };
  const pr = context.paymentRequired, req = context.selectedRequirements;
  if (!isObj(req)) return { ok: false, why: "the context carries no selectedRequirements" };
  if (!isObj(pr)) return { ok: false, why: "the context carries no paymentRequired" };
  if (pr.x402Version === 1) return { ok: false, why: "x402 version 1 requirements are not read by this guard" };
  if (!isObj(pr.resource) || typeof pr.resource.url !== "string" || pr.resource.url.length === 0) {
    return { ok: false, why: "paymentRequired.resource.url is missing or not a string, so the supplied terms cannot be looked up" };
  }
  const url = pr.resource.url;
  for (const k of ["network", "asset", "amount", "payTo"]) {
    if (typeof req[k] !== "string" || req[k].length === 0) return { ok: false, why: `selectedRequirements.${k} is missing or not a string` };
  }
  return { ok: true, url, scheme: typeof req.scheme === "string" ? req.scheme : null, network: req.network, asset: req.asset, amount: req.amount, payTo: req.payTo };
}

function findAsset(assets, network, asset) {
  const byNet = isObj(assets[network]) ? assets[network] : null;
  if (!byNet) return null;
  if (isObj(byNet[asset])) return byNet[asset];
  // EVM addresses are case-insensitive hex; other address formats (Solana base58) are matched exactly.
  if (/^0x[0-9a-fA-F]+$/.test(asset)) {
    const hit = Object.keys(byNet).find((k) => /^0x[0-9a-fA-F]+$/.test(k) && k.toLowerCase() === asset.toLowerCase());
    if (hit) return byNet[hit];
  }
  return null;
}

// A prefix entry: origin (scheme, host, port) plus a path. Query and fragment are not allowed in a prefix.
function parsePrefix(s) {
  let u;
  try { u = new URL(s); } catch { return null; }
  if ((u.protocol !== "http:" && u.protocol !== "https:") || u.search || u.hash || s.includes("?") || s.includes("#")) return null;
  const path = u.pathname.replace(/\/+$/, "");          // "/api/a/" and "/api/a" are the same prefix; "/" becomes ""
  return { origin: u.origin, path };
}

// Does the resource URL fall under the prefix, on the same origin, at a path-segment boundary?
// "/api/a" covers "/api/a" and "/api/a/x", never "/api/ab". The query string of the resource is not compared.
function underPrefix(prefix, url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.origin !== prefix.origin) return false;
  return u.pathname === prefix.path || u.pathname.startsWith(prefix.path + "/");
}

// Exact entries (match "exact", the default) compare the whole URL string. Exact beats prefix; among prefix
// entries the longest path wins; two exact entries, or two prefixes of equal length, are ambiguous.
function findTerms(entries, r) {
  const exact = entries.filter((e) => (e.match ?? "exact") === "exact" && e.resource === r.url);
  if (exact.length) return { entries: exact, how: "exact" };
  const hits = entries
    .filter((e) => e.match === "prefix")
    .map((e) => ({ e, p: parsePrefix(e.resource) }))
    .filter(({ p }) => p !== null && underPrefix(p, r.url));
  if (!hits.length) return { entries: [], how: null };
  const longest = Math.max(...hits.map(({ p }) => p.path.length));
  return { entries: hits.filter(({ p }) => p.path.length === longest).map(({ e }) => e), how: "prefix" };
}

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const samePayee = (a, b) => (EVM_ADDRESS.test(a) && EVM_ADDRESS.test(b) ? a.toLowerCase() === b.toLowerCase() : a === b);
const GUARD_CHECK_LABEL = "a guard check, not a published Tanilo rule";

async function decide(cfg, context) {
  // The offer time: the rules read no clock, so the guard supplies one (the now() option, else the system clock).
  let offered_at = null, timeProblem = null;
  try {
    const at = cfg.now();
    if (!(at instanceof Date) || Number.isNaN(at.getTime())) timeProblem = "now() did not return a valid Date";
    else offered_at = at.toISOString();
  } catch (e) {
    timeProblem = `now() failed: ${e?.message || String(e)}`;
  }
  const inputs = { offered_at, offer_time_source: cfg.nowSource };
  const r = timeProblem ? { ok: false, why: `the offer time is unknown: ${timeProblem}` } : readRequirement(context);
  const requirement = r.ok ? { resource: r.url, scheme: r.scheme, network: r.network, asset: r.asset, amount: r.amount, payTo: r.payTo } : null;
  const checks = [];
  const add = (check_type, status, reason, extra = {}) => checks.push({ check_type, rule_id: RULE_ID[check_type], status, reason, ...extra });

  if (!r.ok) {
    for (const ct of ["contract_price_match", "spend_cap"]) {
      add(ct, "indeterminate", "requirement_unreadable", { summary: `${ct} indeterminate: ${r.why}` });
    }
    return finish(cfg, { inputs, requirement, amount: null, checks, receipt: null });
  }

  // Amount, in the currency the customer's asset map names. Never guessed.
  const assetInfo = findAsset(cfg.assets, r.network, r.asset);
  let amount = null, amountProblem = null;
  if (!assetInfo) amountProblem = `asset ${r.asset} on ${r.network} is not in the supplied assets map, so its currency and decimals are unknown`;
  else if (typeof assetInfo.currency !== "string" || !/^[A-Z]{3}$/.test(assetInfo.currency)) amountProblem = `the assets map entry for ${r.asset} on ${r.network} has no three-letter currency`;
  else {
    const c = atomicToDecimal(r.amount, assetInfo.decimals);
    if (!c.ok) amountProblem = c.why;
    else amount = { value: c.value, currency: assetInfo.currency, decimals: assetInfo.decimals, atomic: r.amount };
  }

  // Which supplied terms apply to this resource.
  const t = findTerms(cfg.terms, r);
  const entry = t.entries.length === 1 ? t.entries[0] : null;
  const toEvaluate = [];   // [{ check_type, input }]
  inputs.terms_entry = entry ? { resource: entry.resource, match: entry.match ?? "exact", payTo: entry.payTo ?? null } : null;
  inputs.terms_lookup = t.entries.length === 0 ? "no entry" : t.entries.length > 1 ? `ambiguous (${t.entries.length} ${t.how} entries)` : t.how;

  // payee_match: a guard check, not a published Tanilo rule. Run only when the matched entry names a payTo.
  // Never sent to the API and never part of a receipt.
  if (entry && typeof entry.payTo === "string") {
    const same = samePayee(r.payTo, entry.payTo);
    checks.push({
      check_type: "payee_match", rule_id: null, guard_check: true, status: same ? "verified" : "contradicted",
      reason: same ? null : "payee_differs",
      input: { payment_pay_to: r.payTo, terms_pay_to: entry.payTo, comparison: EVM_ADDRESS.test(r.payTo) && EVM_ADDRESS.test(entry.payTo) ? "EVM address, case-insensitive" : "exact string" },
      summary: same
        ? `payee_match verified: the payment goes to ${r.payTo}, the address named with the supplied terms (${GUARD_CHECK_LABEL})`
        : `payee_match contradicted: the payment goes to ${r.payTo}, but the supplied terms name ${entry.payTo} (${GUARD_CHECK_LABEL})`,
    });
  }

  // contract_price_match
  if (t.entries.length === 0) {
    add("contract_price_match", "not_evaluated", "no_terms_for_resource", {
      summary: `contract_price_match not evaluated: no supplied terms for ${r.url}`,
    });
  } else if (t.entries.length > 1) {
    add("contract_price_match", "indeterminate", "terms_entry_ambiguous", { summary: `contract_price_match indeterminate: ${t.entries.length} supplied terms entries match ${r.url} equally (${t.how})` });
  } else if (amountProblem) {
    add("contract_price_match", "indeterminate", "amount_unreadable", { summary: `contract_price_match indeterminate: ${amountProblem}` });
  } else {
    const quantity = entry.quantity ?? "1";
    const unit_price = divideExact(amount.value, quantity);
    if (unit_price === null) {
      add("contract_price_match", "indeterminate", "unit_price_not_exact", { summary: `contract_price_match indeterminate: ${amount.value} ${amount.currency} divided by quantity ${quantity} is not exact to 8 places` });
    } else {
      const input = { offer: { unit_price, currency: amount.currency, unit: entry.unit, quantity, seller: entry.seller, sku: entry.sku, offered_at }, terms: entry.terms };
      toEvaluate.push({ check_type: "contract_price_match", input });
    }
  }

  // spend_cap
  if (!cfg.cap) {
    add("spend_cap", "not_evaluated", "no_cap_supplied", { summary: "spend_cap not evaluated: no cap supplied" });
  } else if (amountProblem) {
    add("spend_cap", "indeterminate", "amount_unreadable", { summary: `spend_cap indeterminate: ${amountProblem}` });
  } else {
    const { alreadySpent, ...capFields } = cfg.cap;
    let cap = capFields, spentProblem = null;
    if (cap.scope === "per_period") {
      try {
        const spent = await alreadySpent({ cap_id: cap.cap_id ?? null, currency: cap.currency, offered_at, requirement });
        if (typeof spent !== "string") spentProblem = `alreadySpent() must return a decimal string such as "12.50"; got ${typeof spent}`;
        else cap = { ...capFields, already_spent: spent };
      } catch (e) {
        spentProblem = `alreadySpent() failed: ${e?.message || String(e)}`;
      }
    }
    if (spentProblem) {
      add("spend_cap", "indeterminate", "already_spent_unavailable", { summary: `spend_cap indeterminate: ${spentProblem}` });
    } else {
      const offer = { unit_price: amount.value, currency: amount.currency, quantity: "1", offered_at };
      if (entry) { if (entry.seller) offer.seller = entry.seller; if (entry.sku) offer.sku = entry.sku; }
      toEvaluate.push({ check_type: "spend_cap", input: { offer, cap } });
    }
  }

  // The published rules, in process. Signed mode runs them too, first: input the rule cannot read is never sent.
  const local = toEvaluate.map((c) => {
    let res;
    try { res = evaluateLocal(c.check_type, c.input); } catch (e) { res = { invalid: true, path: "(rule)", message: e?.message || String(e) }; }
    return { ...c, res };
  });
  const runnable = [];
  for (const c of local) {
    if (c.res.invalid) {
      add(c.check_type, "indeterminate", "input_invalid", { input: c.input, summary: `${c.check_type} indeterminate: the supplied ${c.check_type === "spend_cap" ? "cap" : "terms"} could not be read by ${RULE_ID[c.check_type]} (${c.res.message})` });
    } else runnable.push(c);
  }

  let receipt = null;
  if (cfg.mode === "local") {
    for (const c of runnable) add(c.check_type, c.res.state, c.res.reason, { input: c.input, evidence: c.res.evidence, signed: false, summary: summarize(c.check_type, c.res.state, c.res.reason, c.res.evidence, false) });
  } else if (runnable.length > 0) {
    const ans = await callService({ baseUrl: cfg.baseUrl, timeoutMs: cfg.timeoutMs, fetchImpl: cfg.fetchImpl, jwks: cfg.jwks, agentId: cfg.agentId, checks: runnable.map((c) => ({ check_type: c.check_type, input: c.input })) });
    if (!ans.ok) {
      for (const c of runnable) add(c.check_type, "unavailable", "service_unavailable", { input: c.input, summary: `${c.check_type} unavailable: ${ans.why}; no result is assumed` });
    } else {
      // The service applies the same published rule. If its signed state differs from the rule run here, neither
      // is used: that is reported as unavailable rather than picking one.
      const differs = runnable.some((c, i) => ans.states[i].state !== c.res.state || (ans.states[i].reason ?? null) !== (c.res.reason ?? null));
      if (differs) {
        for (const c of runnable) add(c.check_type, "unavailable", "service_differs_from_rule", { input: c.input, summary: `${c.check_type} unavailable: the signed result differs from the published rule run on the same input; neither is used` });
      } else {
        receipt = { ...ans.receipt, signature_checked: ans.signature_checked };
        runnable.forEach((c, i) => {
          const s = ans.states[i];
          add(c.check_type, s.state, s.reason, { input: c.input, evidence: s.evidence, signed: true, summary: summarize(c.check_type, s.state, s.reason, s.evidence, true) });
        });
      }
    }
  }
  return finish(cfg, { inputs, requirement, amount, checks, receipt });
}

// ── wording ──────────────────────────────────────────────────────────────────────────────────────────────

function summarize(ct, state, reason, ev, signed) {
  const label = signed ? "signed receipt" : "unsigned, computed locally";
  const rule = RULE_ID[ct];
  if (ct === "contract_price_match") {
    if (state === "verified") return `contract_price_match verified: the offered price matches the supplied term under ${rule} (${label})`;
    if (state === "contradicted") {
      const o = ev?.offered, x = ev?.expected;
      const dir = ev?.offer_is === "below_term_price" ? "below" : "above";
      return `contract_price_match contradicted: offered ${display(o?.unit_price)} ${o?.currency} ${dir} term price ${display(x?.price_per_unit)} under ${rule} (${label})`;
    }
  } else {
    if (state === "verified") return `spend_cap verified: the offered total fits within the remaining supplied cap under ${rule} (${label})`;
    if (state === "contradicted") {
      return `spend_cap contradicted: offered total ${display(ev?.offer_total)} ${ev?.offer?.currency} exceeds the remaining supplied cap ${display(ev?.remaining)} by ${display(ev?.excess)} under ${rule} (${label})`;
    }
  }
  const text = REASON_TEXT[ct][reason];
  return `${ct} indeterminate: ${reason}${text ? ` (${text})` : ""} under ${rule} (${label})`;
}

// ── policy ───────────────────────────────────────────────────────────────────────────────────────────────

const ORDER = ["contract_price_match", "spend_cap", "payee_match"];

function finish(cfg, { inputs, requirement, amount, checks: unordered, receipt }) {
  const checks = [...unordered].sort((a, b) => ORDER.indexOf(a.check_type) - ORDER.indexOf(b.check_type));
  const rules = checks.filter((c) => !c.guard_check);
  const of = (s) => rules.filter((c) => c.status === s);
  const policy = { onIndeterminate: cfg.onIndeterminate, onNotEvaluated: cfg.onNotEvaluated, onUnavailable: cfg.onUnavailable, onPayeeMismatch: cfg.onPayeeMismatch, applied: [] };
  const blockers = [];
  if (of("contradicted").length) { policy.applied.push("contradicted: always abort"); blockers.push(...of("contradicted")); }
  const payee = checks.find((c) => c.check_type === "payee_match" && c.status === "contradicted");
  if (payee) { policy.applied.push(`payee_match contradicted: onPayeeMismatch = ${cfg.onPayeeMismatch}`); if (cfg.onPayeeMismatch === "block") blockers.push(payee); }
  for (const [status, key] of [["unavailable", "onUnavailable"], ["indeterminate", "onIndeterminate"], ["not_evaluated", "onNotEvaluated"]]) {
    const hit = of(status);
    if (!hit.length) continue;
    policy.applied.push(`${status}: ${key} = ${cfg[key]}`);
    if (cfg[key] === "block") blockers.push(...hit);
  }
  if (!policy.applied.length) policy.applied.push("every check verified");
  const allow = blockers.length === 0;
  return {
    allow,
    reason: allow ? null : `tanilo-x402-guard: ${blockers.map((c) => c.summary).join("; ")}`,
    mode: cfg.mode,
    at: inputs.offered_at,
    inputs,
    requirement,
    amount,
    checks,
    policy,
    receipt,
  };
}

function fallbackDecision(cfg, why) {
  const checks = ["contract_price_match", "spend_cap"].map((ct) => ({ check_type: ct, rule_id: RULE_ID[ct], status: "indeterminate", reason: "guard_error", summary: `${ct} indeterminate: ${why}` }));
  return finish(cfg, { inputs: { offered_at: null, offer_time_source: cfg.nowSource }, requirement: null, amount: null, checks, receipt: null });
}
