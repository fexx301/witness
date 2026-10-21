// One dispute, end to end: read → gather → establish findings → assess → decide → act → record.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { executeSteps, planSteps, type Step, type StepResult } from "./act.js";
import { normalizeDispute, type Claim } from "./claim.js";
import { claimTypeForReason, comparisonFinding, decide, factsFor, writingFor, type Assessment, type Assessor, type Decision, type Writing } from "./decide.js";
import { authorizationFinding, fulfilmentFinding, resolveEvidenceRequests, type EvidenceRequestStatus, type Finding } from "./findings.js";
import { checkMandate, checkPayPalApproval, type Mandate, type MandateCheck, type MandateStore } from "./mandate.js";
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
  writing: Writing;
  steps: Step[];
  results: StepResult[];
  evidencePack: string;
  // For an execution: the dry run a person reviewed, whose decision and text were sent.
  reviewedRanAt?: string;
}

const recordFile = (runsDir: string, disputeId: string, ranAt: string, kind: "dry-run" | "executed") =>
  join(runsDir, `${disputeId}-${ranAt.replace(/[:.]/g, "-")}-${kind}.json`);

// The dry run a person reviewed, by its dispute and time; null when there is none.
export function reviewedRecord(runsDir: string, disputeId: string, ranAt: string): RunRecord | null {
  const file = recordFile(runsDir, disputeId, ranAt, "dry-run");
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as RunRecord) : null;
}

export class ExecutionRefused extends Error {}

// Every record of an execution for a dispute, oldest first.
function executedRecords(runsDir: string, disputeId: string): RunRecord[] {
  return readdirSync(runsDir)
    .filter((name) => name.startsWith(`${disputeId}-`) && name.endsWith("-executed.json"))
    .sort()
    .map((name) => JSON.parse(readFileSync(join(runsDir, name), "utf8")) as RunRecord);
}

// What a plan sends, to compare the reviewed plan with the one PayPal allows now. Stored steps have
// their files replaced, so files are not compared.
const sends = (steps: Step[]) =>
  steps.map((s) => [s.kind, "acceptClaimType" in s && s.acceptClaimType, "offerType" in s && s.offerType, "evidenceType" in s && s.evidenceType].filter(Boolean).join(" ")).join(", ");

// Sends exactly what a person reviewed: that dry run's decision and text, with no new assessment.
// Refused when it was already sent, when something was already sent at this stage of the dispute,
// when the review came from the rules-only baseline, when the dispute or the records code checked
// have changed, or when PayPal now allows a different response than the reviewed one. The dispute's
// status is not compared: it only says whose turn it is.
export async function executeReviewed(deps: Deps, reviewed: RunRecord): Promise<RunRecord> {
  if (reviewed.executed || reviewed.model === "rules-only baseline") throw new ExecutionRefused("Only a Witness dry run can be executed.");
  const executed = executedRecords(deps.runsDir, reviewed.disputeId);
  if (executed.some((r) => r.reviewedRanAt === reviewed.ranAt)) throw new ExecutionRefused("This reviewed investigation was already sent to PayPal.");

  const live = normalizeDispute(await deps.disputes.get(reviewed.disputeId));
  if (live.outcome) throw new ExecutionRefused(`The dispute is already resolved (${live.outcome}).`);
  // A later review of the same case does not send a second response at the same stage.
  const sentAtStage = executed.filter((r) => r.claim.stage === live.stage && r.results.some((x) => x.ok && x.step !== "none")).at(-1);
  if (sentAtStage) throw new ExecutionRefused(`Witness already sent a response at this stage of the dispute (${sentAtStage.ranAt}); it does not send twice.`);
  const was = reviewed.claim;
  const changed = [
    live.stage !== was.stage && "stage",
    (live.amount.value !== was.amount.value || live.amount.currency !== was.amount.currency) && "amount",
    live.mandateHash !== was.mandateHash && "mandate",
    JSON.stringify(live.buyerStatements) !== JSON.stringify(was.buyerStatements) && "buyer statements",
    JSON.stringify(live.evidenceRequests.map((r) => r.type)) !== JSON.stringify(was.evidenceRequests.map((r) => r.type)) && "evidence requests",
  ].filter(Boolean);
  if (changed.length) throw new ExecutionRefused(`The dispute changed since the review (${changed.join(", ")}). Investigate again before acting.`);

  // What code established at review time must still hold: delivery, the mandate and its approval.
  const now = await establish(deps, live);
  const moved = now.findings.filter((f) => reviewed.findings.find((r) => r.key === f.key)?.status !== f.status).map((f) => f.key);
  if (moved.length) throw new ExecutionRefused(`The records changed since the review (${moved.join(", ")}). Investigate again before acting.`);

  const files: EvidenceFile[] = [{ filename: `witness-${live.disputeId}.txt`, contentType: "text/plain", data: reviewed.evidencePack }];
  if (now.mandate) files.push({ filename: "mandate.txt", contentType: "text/plain", data: JSON.stringify(now.mandate, null, 2) });
  const steps = planSteps(live, reviewed.decision, reviewed.writing, files, now.tracking);
  if (sends(steps) !== sends(reviewed.steps))
    throw new ExecutionRefused(`PayPal now allows "${sends(steps)}", not the reviewed "${sends(reviewed.steps)}". Investigate again before acting.`);
  if (steps.every((s) => s.kind === "none")) throw new ExecutionRefused("This review sends nothing to PayPal.");
  const results = await executeSteps(deps.disputes, live.disputeId, steps);

  const record: RunRecord = {
    ...reviewed,
    ranAt: (deps.now ?? (() => new Date()))().toISOString(),
    executed: true,
    reviewedRanAt: reviewed.ranAt,
    claim: { ...live, actions: [...live.actions] },
    steps: steps.map((s) => ("files" in s ? { ...s, files: s.files.map((f) => ({ ...f, data: `<${f.data.length} chars>` })) } : s)),
    results,
  };
  writeFileSync(recordFile(deps.runsDir, live.disputeId, record.ranAt, "executed"), JSON.stringify(record, null, 2) + "\n");
  return record;
}

// What code establishes from PayPal's records and the mandate store before any model reads the case.
// Run again at execution, so a reviewed decision is never sent on records that have since changed.
async function establish(deps: Deps, claim: Claim) {
  let capture: Capture | null = null;
  let tracking: Tracking[] = [];
  let orderDescription: string | undefined;
  if (claim.captureId) {
    capture = await deps.orders.capture(claim.captureId);
    const orderId = capture.supplementary_data?.related_ids?.order_id;
    if (orderId) {
      const order = await deps.orders.order(orderId);
      // A failed v1 lookup keeps the order's own status rather than failing the investigation.
      tracking = await Promise.all(
        trackingFromOrder(order).map(async (t) => {
          if (!t.trackerId) return t;
          const v1 = await deps.orders.tracker(t.trackerId).catch(() => null);
          return { ...t, status: v1?.status ?? t.status, ...(v1?.carrier ? { carrier: v1.carrier } : {}) };
        }),
      );
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
  const linked = mandate ? deps.mandates.lifecycle(claim.mandateHash!).filter((e) => e.event === "accepted" && e.paypal_order).at(-1) : undefined;
  if (linked?.paypal_order) {
    // An unreadable approval is unknown, never a pass.
    const approval = await deps.orders.order(linked.paypal_order).then(
      (order) => ({
        orderId: order.id,
        status: order.status,
        customId: order.purchase_units[0]?.custom_id,
        payerId: order.payer?.payer_id,
        approvedAt: order.purchase_units[0]?.payments?.captures?.[0]?.create_time,
        vaultId: order.payment_source?.paypal?.attributes?.vault?.id,
      }),
      () => null,
    );
    checks.push(checkPayPalApproval(approval, claim.mandateHash!, claim.buyerPayerId, capture?.create_time));
  } else if (mandate && deps.mandates.lifecycle(claim.mandateHash!).some((e) => e.event === "accepted")) {
    // An acceptance only Witness recorded is not the buyer's PayPal-backed approval, so it cannot establish authorization.
    checks.push({ rule: "paypal_approval", status: "unknown", detail: "The buyer's acceptance is recorded by Witness only; it is not linked to a PayPal approval." });
  }

  return { capture, tracking, orderDescription, mandate, checks, findings: [authorizationFinding(mandate, checks, claim.mandateHash), fulfilmentFinding(tracking)] };
}

export async function processDispute(deps: Deps, disputeId: string, options: { execute: boolean }): Promise<RunRecord> {
  const now = (deps.now ?? (() => new Date()))();
  const claim = normalizeDispute(await deps.disputes.get(disputeId));

  const { capture, tracking, orderDescription, mandate, checks, findings: established } = await establish(deps, claim);
  const assessment = await deps.assessor.assess({ claim, mandate, findings: established, tracking, orderDescription });
  const facts = factsFor({ claim, mandate, findings: established, tracking, orderDescription });
  const findings: Finding[] = [
    established[0]!,
    comparisonFinding("instruction_compliance", assessment.instruction_compliance, facts),
    comparisonFinding("listing_match", assessment.listing_match, facts),
    established[1]!,
  ];
  const requests = resolveEvidenceRequests(claim, established[1]!, capture);
  const claimType = claimTypeForReason(claim.reason);
  const decision = decide(claimType, findings, requests, deps.policy);
  if (assessment.claim_type !== claimType)
    decision.discrepancy = `PayPal's reason is ${claim.reason}, but Claude reads the buyer's words as ${assessment.claim_type}. Witness answers PayPal's stated reason.`;

  const writing = writingFor(assessment, facts);

  const evidencePack = renderEvidencePack({
    claim, mandate, checks, tracking, findings, requests, assessment, decision, writing, policyName: deps.policy.name, generatedAt: now.toISOString(),
  });
  const files: EvidenceFile[] = [{ filename: `witness-${claim.disputeId}.txt`, contentType: "text/plain", data: evidencePack }];
  if (mandate) files.push({ filename: "mandate.txt", contentType: "text/plain", data: JSON.stringify(mandate, null, 2) });

  const steps = planSteps(claim, decision, writing, files, tracking);
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
    writing,
    steps: steps.map((s) => ("files" in s ? { ...s, files: s.files.map((f) => ({ ...f, data: `<${f.data.length} chars>` })) } : s)),
    results,
    evidencePack,
  };
  mkdirSync(deps.runsDir, { recursive: true });
  writeFileSync(recordFile(deps.runsDir, claim.disputeId, record.ranAt, options.execute ? "executed" : "dry-run"), JSON.stringify(record, null, 2) + "\n");
  return record;
}
