// Types for @tanilo/x402-guard. The hook matches @x402/core's BeforePaymentCreationHook (tested with 2.19.0 and 2.28.0):
// (context: { paymentRequired, selectedRequirements }) => Promise<void | { abort: true; reason: string }>.

export type Policy = "block" | "allow";
export type CheckStatus = "verified" | "contradicted" | "indeterminate" | "not_evaluated" | "unavailable";

/** One entry per resource: the offer fields the payment does not carry, and the customer's terms for it. */
export interface TermsEntry {
  /** The resource URL from the 402 response (match "exact"), or a URL prefix (match "prefix"). */
  resource: string;
  /**
   * "exact" (default): the whole URL string must be equal.
   * "prefix": same origin (scheme, host, port) and a path-segment boundary: /api/a covers /api/a and /api/a/x,
   * never /api/ab. Exact entries beat prefix entries; the longest prefix wins; equal-length ties are indeterminate.
   */
  match?: "exact" | "prefix";
  /** If given, the guard check payee_match compares it with the payment's payTo (EVM addresses case-insensitively). */
  payTo?: string;
  /** If given, the guard check asset_match compares it with the payment's asset (EVM addresses case-insensitively). */
  asset?: string;
  /** If given, the guard check network_match compares it with the payment's network (exact string, e.g. "eip155:8453"). */
  network?: string;
  seller: string;
  sku: string;
  unit: string;
  /** Quantity bought by one payment. Default "1". The unit price is the payment's amount divided by it, exactly. */
  quantity?: string;
  /** Contract terms in the contract-price-match/v0.1 input shape. */
  terms: unknown[];
}

export interface SpendCap {
  cap_id?: string;
  amount: string;
  currency: string;
  scope: "per_purchase" | "per_period";
  period?: { from: string; to: string };
  /** Required for per_period. Returns what has already been spent in the period, as a decimal string. */
  alreadySpent?: (info: { cap_id: string | null; currency: string; offered_at: string; requirement: Requirement }) => string | Promise<string>;
}

/** network -> asset address -> { currency, decimals }. Nothing is assumed for an asset that is not listed. */
export type AssetsMap = Record<string, Record<string, { currency: string; decimals: number }>>;

export interface Requirement {
  resource: string | null;
  scheme: string | null;
  network: string;
  asset: string;
  amount: string;
  payTo: string;
}

export interface CheckResult {
  check_type: "contract_price_match" | "spend_cap" | "payee_match" | "asset_match" | "network_match";
  /** null for payee_match, asset_match and network_match: guard checks, not published Tanilo rules. */
  rule_id: string | null;
  /** true for payee_match, asset_match and network_match. Never sent to the API, never in a receipt. */
  guard_check?: boolean;
  status: CheckStatus;
  reason: string | null;
  summary: string;
  input?: unknown;
  evidence?: unknown;
  /** false: computed locally, unsigned. true: read from a signed receipt. */
  signed?: boolean;
}

export interface Decision {
  allow: boolean;
  reason: string | null;
  mode: "local" | "signed";
  at: string | null;
  /** The offer time used and where it came from, and which terms entry was used. */
  inputs: { offered_at: string | null; offer_time_source: "now() option" | "system clock"; terms_entry?: { resource: string; match: "exact" | "prefix"; payTo: string | null; asset: string | null; network: string | null } | null; terms_lookup?: string };
  requirement: Requirement | null;
  amount: { value: string; currency: string; decimals: number; atomic: string } | null;
  checks: CheckResult[];
  policy: { onIndeterminate: Policy; onNotEvaluated: Policy; onUnavailable: Policy; onPayeeMismatch: Policy; applied: string[] };
  receipt: { jws: { payload: string; signatures: { protected: string; signature: string }[] }; canonical_sha256: string; kid: string; signature_checked: boolean } | null;
}

export interface GuardOptions {
  mode?: "local" | "signed";
  terms?: TermsEntry[];
  cap?: SpendCap;
  assets?: AssetsMap;
  onIndeterminate?: Policy;
  onNotEvaluated?: Policy;
  onUnavailable?: Policy;
  /** payee_match contradicted (the payment's payTo differs from the terms entry's payTo). Default "block". */
  onPayeeMismatch?: Policy;
  /** Signed mode. Default 3000. */
  timeoutMs?: number;
  /** Signed mode. Default https://api.tanilo.io */
  baseUrl?: string;
  /** Signed mode. If given, the receipt's signature is checked against this key set before its result is used. */
  jwks?: { keys: unknown[] };
  /** Signed mode: agent_id sent with the request. */
  agentId?: string;
  fetch?: typeof globalThis.fetch;
  onDecision?: (decision: Decision) => void | Promise<void>;
  /** Returns the offer time. Default: the system clock. Recorded in decision.inputs. */
  now?: () => Date;
}

export declare function taniloGuard(options?: GuardOptions): (context: {
  paymentRequired: unknown;
  selectedRequirements: unknown;
}) => Promise<void | { abort: true; reason: string }>;

export declare function evaluateLocal(checkType: "contract_price_match" | "spend_cap", input: unknown): unknown;
export declare const DEFAULT_BASE_URL: string;
