// One dispute, end to end: read → gather → establish findings → assess → decide → act → record.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { executeSteps, planSteps, type Step, type StepResult } from "./act.js";
import { normalizeDispute, type Claim } from "./claim.js";
import { comparisonFinding, decide, factsFor, type Assessment, type Assessor, type Decision } from "./decide.js";
import { authorizationFinding, fulfilmentFinding, resolveEvidenceRequests, type EvidenceRequestStatus, type Finding } from "./findings.js";
import { checkMandate, type Mandate, type MandateCheck, type MandateStore } from "./mandate.js";
import { renderEvidencePack } from "./pack.js";
import type { MerchantPolicy } from "./policy.js";
import type { Disputes, EvidenceFile } from "./paypal/disputes.js";
import { trackingFromOrder, type Capture, type Orders, type Tracking } from "./paypal/orders.js";

export interface Deps {
  disputes: Disputes;
  orders: Orders;
  mandates: MandateStore;
  assessor: Assessor;
  policy: MerchantPolicy;
  runsDir: string;
  now?: () => Date;
}

export interface RunRecord {
  disputeId: string;
  ranAt: string;
  executed: boolean;
  model: string;
  policy: string;
  claim: Omit<Claim, "actions"> & { actions: string[] };
  mandateBound: boolean;
  checks: MandateCheck[];
  tracking: Tracking[];
  findings: Finding[];
  requests: EvidenceRequestStatus[];
  assessment: Assessment;
  decision: Decision;
  steps: Step[];
  results: StepResult[];
  evidencePack: string;
}

export async function processDispute(deps: Deps, disputeId: string, options: { execute: boolean }): Promise<RunRecord> {
  const now = (deps.now ?? (() => new Date()))();
  const claim = normalizeDispute(await deps.disputes.get(disputeId));

  let capture: Capture | null = null;
  let tracking: Tracking[] = [];
  let orderDescription: string | undefined;
  if (claim.captureId) {
    capture = await deps.orders.capture(claim.captureId);
    const orderId = capture.supplementary_data?.related_ids?.order_id;
    if (orderId) {
      const order = await deps.orders.order(orderId);
      tracking = trackingFromOrder(order);
      orderDescription = order.purchase_units[0]?.description;
    }
  }

  const mandate: Mandate | null = deps.mandates.find(claim.mandateHash);
  const checks = mandate
    ? checkMandate(
        mandate,
        claim.mandateHash!,
        { amountUsd: claim.amount.value, merchantId: capture?.payee?.merchant_id, purchasedAt: capture?.create_time },
        deps.mandates.lifecycle(claim.mandateHash!),
      )
    : [];

  // Code establishes what it can before the model sees anything.
  const established: Finding[] = [authorizationFinding(mandate, checks), fulfilmentFinding(tracking)];
  const assessment = await deps.assessor.assess({ claim, mandate, findings: established, tracking, orderDescription });
  const facts = factsFor({ claim, mandate, findings: established, tracking, orderDescription });
  const findings: Finding[] = [
    established[0]!,
    comparisonFinding("instruction_compliance", assessment.instruction_compliance, facts),
    comparisonFinding("listing_match", assessment.listing_match, facts),
    established[1]!,
  ];
  const requests = resolveEvidenceRequests(claim, established[1]!, capture);
  const decision = decide(assessment.claim_type, findings, requests, deps.policy);

  const evidencePack = renderEvidencePack({
    claim, mandate, checks, tracking, findings, requests, assessment, decision, policyName: deps.policy.name, generatedAt: now.toISOString(),
  });
  const files: EvidenceFile[] = [{ filename: `witness-${claim.disputeId}.txt`, contentType: "text/plain", data: evidencePack }];
  if (mandate) files.push({ filename: "mandate.txt", contentType: "text/plain", data: JSON.stringify(mandate, null, 2) });

  const steps = planSteps(claim, decision, assessment, files);
  const results = options.execute ? await executeSteps(deps.disputes, claim.disputeId, steps) : [];

  const record: RunRecord = {
    disputeId: claim.disputeId,
    ranAt: now.toISOString(),
    executed: options.execute,
    model: deps.assessor.model,
    policy: deps.policy.name,
    claim: { ...claim, actions: [...claim.actions] },
    mandateBound: Boolean(mandate),
    checks,
    tracking,
    findings,
    requests,
    assessment,
    decision,
    steps: steps.map((s) => ("files" in s ? { ...s, files: s.files.map((f) => ({ ...f, data: `<${f.data.length} chars>` })) } : s)),
    results,
    evidencePack,
  };
  mkdirSync(deps.runsDir, { recursive: true });
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  writeFileSync(join(deps.runsDir, `${claim.disputeId}-${stamp}-${options.execute ? "executed" : "dry-run"}.json`), JSON.stringify(record, null, 2) + "\n");
  return record;
}
