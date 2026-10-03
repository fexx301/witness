// One dispute, end to end: read → gather context → assess → decide → act → record.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { executeSteps, planSteps, type Step, type StepResult } from "./act.js";
import { normalizeDispute, type Claim } from "./claim.js";
import { decide, type Assessment, type Assessor, type Decision } from "./decide.js";
import { checkMandate, type Mandate, type MandateCheck, type MandateStore } from "./mandate.js";
import { renderEvidencePack } from "./pack.js";
import type { Disputes, EvidenceFile } from "./paypal/disputes.js";
import { trackingFromOrder, type Orders, type Tracking } from "./paypal/orders.js";

export interface Deps {
  disputes: Disputes;
  orders: Orders;
  mandates: MandateStore;
  assessor: Assessor;
  runsDir: string;
  now?: () => Date;
}

export interface RunRecord {
  disputeId: string;
  ranAt: string;
  executed: boolean;
  model: string;
  claim: Omit<Claim, "actions"> & { actions: string[] };
  mandateBound: boolean;
  checks: MandateCheck[];
  tracking: Tracking[];
  assessment: Assessment;
  decision: Decision;
  steps: Step[];
  results: StepResult[];
  evidencePack: string;
}

export async function processDispute(deps: Deps, disputeId: string, options: { execute: boolean }): Promise<RunRecord> {
  const now = (deps.now ?? (() => new Date()))();
  const claim = normalizeDispute(await deps.disputes.get(disputeId));

  let tracking: Tracking[] = [];
  let orderDescription: string | undefined;
  let merchantId: string | undefined;
  let purchasedAt: string | undefined;
  if (claim.captureId) {
    const capture = await deps.orders.capture(claim.captureId);
    merchantId = capture.payee?.merchant_id;
    purchasedAt = capture.create_time;
    const orderId = capture.supplementary_data?.related_ids?.order_id;
    if (orderId) {
      const order = await deps.orders.order(orderId);
      tracking = trackingFromOrder(order);
      orderDescription = order.purchase_units[0]?.description;
    }
  }

  const mandate: Mandate | null = deps.mandates.find(claim.mandateHash);
  const checks = mandate
    ? checkMandate(mandate, claim.mandateHash!, { amountUsd: claim.amount.value, merchantId, purchasedAt })
    : [];

  const assessment = await deps.assessor.assess({ claim, mandate, checks, tracking, orderDescription });
  const decision = decide(assessment, mandate, checks);
  const evidencePack = renderEvidencePack({ claim, mandate, checks, tracking, assessment, decision, generatedAt: now.toISOString() });

  const files: EvidenceFile[] = [{ filename: `witness-${claim.disputeId}.txt`, contentType: "text/plain", data: evidencePack }];
  if (mandate) files.push({ filename: "mandate.txt", contentType: "text/plain", data: JSON.stringify(mandate, null, 2) });

  const steps = planSteps(claim, decision, assessment, files);
  const results = options.execute ? await executeSteps(deps.disputes, claim.disputeId, steps) : [];

  const record: RunRecord = {
    disputeId: claim.disputeId,
    ranAt: now.toISOString(),
    executed: options.execute,
    model: deps.assessor.model,
    claim: { ...claim, actions: [...claim.actions] },
    mandateBound: Boolean(mandate),
    checks,
    tracking,
    assessment,
    decision,
    steps: steps.map((s) => ("files" in s ? { ...s, files: s.files.map((f) => ({ ...f, data: `<${f.data.length} chars>` })) } : s)),
    results,
    evidencePack,
  };
  mkdirSync(deps.runsDir, { recursive: true });
  writeFileSync(join(deps.runsDir, `${claim.disputeId}-${now.toISOString().replace(/[:.]/g, "-")}-${options.execute ? "executed" : "dry-run"}.json`), JSON.stringify(record, null, 2) + "\n");
  return record;
}
