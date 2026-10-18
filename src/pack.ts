// The evidence pack: one plain-text document that shows every finding, its status
// and sources, what is still missing, and the action taken.

import type { Claim } from "./claim.js";
import type { Assessment, Decision } from "./decide.js";
import type { EvidenceRequestStatus, Finding } from "./findings.js";
import type { Mandate, MandateCheck } from "./mandate.js";
import type { Tracking } from "./paypal/orders.js";

export interface PackInput {
  claim: Claim;
  mandate: Mandate | null;
  checks: MandateCheck[];
  tracking: Tracking[];
  findings: Finding[];
  requests: EvidenceRequestStatus[];
  assessment: Assessment;
  decision: Decision;
  policyName: string;
  generatedAt: string;
}

const MARK: Record<Finding["status"], string> = {
  established: "ESTABLISHED",
  contradicted: "CONTRADICTED",
  unknown: "UNKNOWN",
  not_applicable: "N/A",
};

export function renderEvidencePack(input: PackInput): string {
  const { claim, mandate, checks, tracking, findings, requests, assessment, decision, policyName, generatedAt } = input;
  const lines = [
    `WITNESS INVESTIGATION`,
    `Dispute ${claim.disputeId} · ${claim.reason} · ${claim.amount.value.toFixed(2)} ${claim.amount.currency}`,
    `Payment ${claim.captureId ?? "unknown"} · generated ${generatedAt}`,
    ``,
    `CLAIM (${assessment.claim_type})`,
    assessment.claim_summary,
    ...claim.buyerStatements.map((s, i) => `  buyer_statements[${i}]: "${s}"`),
    ``,
    `SHIPMENT`,
    ...(tracking.length ? tracking.map((t, i) => `  shipment_tracking[${i}]: ${t.trackingNumber} ${t.status}`) : [`  No shipment tracking on the order.`]),
  ];
  if (mandate) {
    lines.push(
      ``,
      `AGENT MANDATE (bound to the order by SHA-256 ${claim.mandateHash})`,
      `  Agent ${mandate.agent} · category ${mandate.scope.category} · cap $${mandate.scope.max_amount_usd} · valid until ${mandate.valid_until}`,
      ...(mandate.instructions ?? []).map((s, i) => `  mandate.instructions[${i}]: ${s}`),
      ...checks.map((c) => `  [${c.status.toUpperCase()}] ${c.rule}: ${c.detail}`),
    );
  }
  lines.push(``, `FINDINGS`);
  for (const f of findings) lines.push(`  [${MARK[f.status]}] ${f.key}: ${f.summary}${f.sources.length ? ` (sources: ${f.sources.join(", ")})` : ""}`);
  if (requests.length) {
    lines.push(``, `PAYPAL EVIDENCE REQUESTS`);
    for (const r of requests) lines.push(`  [${r.resolved ? "RESOLVED" : "UNRESOLVED"}] ${r.type}: ${r.detail}`);
  }
  lines.push(``, `DECISION: ${decision.action.toUpperCase()} (basis: ${decision.basis.replace("_", " ")}; policy: ${policyName})`, ...decision.why.map((w) => `  - ${w}`));
  if (decision.discrepancy) lines.push(`DISCREPANCY: ${decision.discrepancy}`);
  if (decision.gaps.length) lines.push(`MISSING`, ...decision.gaps.map((g) => `  - ${g}`));
  if (decision.action === "defend") lines.push(``, assessment.evidence_notes);
  return lines.join("\n") + "\n";
}
