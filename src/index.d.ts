// Types for tanilo-x402-guard. The hook matches @x402/core's BeforePaymentCreationHook (2.19.0 to 2.28.0):
// (context: { paymentRequired, selectedRequirements }) => Promise<void | { abort: true; reason: string }>.

export type Policy = "block" | "allow";
export type CheckStatus = "verified" | "contradicted" | "indeterminate" | "not_evaluated" | "unavailable";

/** One entry per resource: the offer fields the payment does not carry, and the customer's terms for it. */
export interface TermsEntry {
  /** Exact resource URL from the 402 response. Give this or resourcePrefix. */
  resource?: string;
  /** URL prefix. Used only when no entry matches the URL exactly. */
  resourcePrefix?: string;
  /** If given, a payment to any other address is indeterminate for contract_price_match. */
  payTo?: string;
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
  check_type: "contract_price_match" | "spend_cap";
  rule_id: string;
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
  requirement: Requirement | null;
  amount: { value: string; currency: string; decimals: number; atomic: string } | null;
  checks: CheckResult[];
  policy: { onIndeterminate: Policy; onNotEvaluated: Policy; onUnavailable: Policy; applied: string[] };
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
  /** The time used as the offer time. Default: the current time. */
  now?: () => Date;
}

export declare function taniloGuard(options?: GuardOptions): (context: {
  paymentRequired: unknown;
  selectedRequirements: unknown;
}) => Promise<void | { abort: true; reason: string }>;

export declare function evaluateLocal(checkType: "contract_price_match" | "spend_cap", input: unknown): unknown;
export declare const DEFAULT_BASE_URL: string;
