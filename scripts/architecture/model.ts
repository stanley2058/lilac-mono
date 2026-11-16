export const ARCHITECTURE_RULES = [
  "architecture/no-deprecated",
  "architecture/no-unregistered-decoder",
  "architecture/no-domain-unknown",
  "architecture/no-unknown-assertion",
  "architecture/no-rich-unknown-predicate",
  "architecture/no-unknown-member-read",
  "architecture/no-unregistered-custom-decoder",
  "architecture/closed-union-exhaustiveness",
  "architecture/closed-union-map-exhaustiveness",
  "architecture/open-protocol-normalization",
  "architecture/raw-event-message-boundary",
  "architecture/complete-event-codec-registry",
  "architecture/complete-tool-codec-registry",
  "architecture/result-decoder-contract",
  "architecture/unknown-free-module",
  "architecture/persisted-codec-contract",
  "architecture/persisted-codec-fixture-catalog",
  "architecture/event-handler-result",
  "architecture/event-delivery-policy-exhaustiveness",
  "architecture/no-production-unwrap",
  "architecture/no-manual-result-branching",
  "architecture/no-repeated-result-match",
  "architecture/no-nested-result-continuation",
  "architecture/no-unmapped-result-capture",
  "architecture/no-unhandled-exception-contract",
  "architecture/registered-panic-site",
  "architecture/no-result-wire-leak",
  "architecture/no-unredacted-tagged-error-log",
  "architecture/fallible-api-result",
  "architecture/sqlite-transaction-adapter-contract",
  "architecture/sqlite-transaction-consumer",
  "architecture/no-result-err-in-sqlite-callback",
] as const;

export type ArchitectureRule = (typeof ARCHITECTURE_RULES)[number];

export interface SourceLocation {
  readonly file: string;
  readonly line: number;
  readonly column: number;
}

export interface ArchitectureDiagnostic {
  readonly rule: ArchitectureRule;
  readonly severity: "error" | "warning";
  readonly workspace: string;
  readonly message: string;
  readonly suggestion: string;
  readonly identity: string;
  readonly fingerprint: string;
  readonly location?: SourceLocation;
}
