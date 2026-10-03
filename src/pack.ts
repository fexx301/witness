// The evidence pack: one plain-text document attached to the PayPal response.

import type { Claim } from "./claim.js";
import type { Assessment, Decision } from "./decide.js";
import type { Mandate, MandateCheck } from "./mandate.js";
import type { Tracking } from "./paypal/orders.js";

export interface PackInput {
  claim: Claim;
  mandate: Mandate | null;
  checks: MandateCheck[];
  tracking: Tracking[];
  assessment: Assessment;
  decision: Decision;
  generatedAt: string;
}

export function renderEvidencePack(input: PackInput): string {
  const { claim, mandate, checks, tracking, assessment, decision, generatedAt } = input;
  const lines = [
    `WITNESS EVIDENCE PACK`,
    `Dispute ${claim.disputeId} · ${claim.reason} · ${claim.amount.value.toFixed(2)} ${claim.amount.currency}`,
    `Payment ${claim.captureId ?? "unknown"} · generated ${generatedAt}`,
    ``,
    `CLAIM`,
    `${assessment.claim_summary}`,
    ...claim.buyerStatements.map((s) => `  Buyer: "${s}"`),
    ``,
    `FULFILMENT`,
    ...(tracking.length
      ? tracking.map((t) => `  Shipment ${t.trackingNumber}: ${t.status}`)
      : [`  No shipment tracking on the order.`]),
  ];
  if (mandate) {
    lines.push(
      ``,
      `AGENT MANDATE (bound to the order by SHA-256 ${claim.mandateHash})`,
      `  Agent: ${mandate.agent}`,
      `  Category: ${mandate.scope.category}`,
      `  Spending cap: $${mandate.scope.max_amount_usd}`,
      `  Merchants: ${mandate.scope.merchants.join(", ")}`,
      `  Approved: ${mandate.approved_at} · valid until ${mandate.valid_until}`,
      `  Checks:`,
      ...checks.map((c) => `    [${c.status.toUpperCase()}] ${c.rule}: ${c.detail}`),
    );
  }
  lines.push(``, `DECISION: ${decision.action.toUpperCase()}`, ...decision.why.map((w) => `  - ${w}`), ``, assessment.evidence_notes);
  return lines.join("\n") + "\n";
}
