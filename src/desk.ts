// What the investigation desk shows: one row per PayPal dispute for the queue, and the full record
// of a reviewed investigation for the detail page. Field names are fixed: saved dashboards refer
// to them by name.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { RulesAssessor } from "./baseline.js";
import { normalizeDispute } from "./claim.js";
import { processDispute, reviewedRecord, type Deps, type RunRecord } from "./witness.js";

export interface DisputeRow {
  disputeId: string;
  reason: string;
  amountUsd: number;
  paypalStatus: string;
  stage: string;
  outcome: string;
  buyer: string;
  witnessDecision: string;
  baselineDecision: string;
  sentToPayPal: string;
  responseDue: string;
  openedAt: string;
  investigatedAt: string;
}

const REASONS: Record<string, string> = {
  MERCHANDISE_OR_SERVICE_NOT_RECEIVED: "Not received",
  MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED: "Not as described",
  UNAUTHORISED: "Unauthorized",
};
const reasonLabel = (reason: string) => REASONS[reason] ?? reason.charAt(0) + reason.slice(1).toLowerCase().replaceAll("_", " ");

export const baselineDir = (runsDir: string) => join(runsDir, "baseline");

// Every record for a dispute in a runs folder, oldest first (file names sort by time).
function records(runsDir: string, disputeId: string): RunRecord[] {
  if (!existsSync(runsDir)) return [];
  return readdirSync(runsDir)
    .filter((name) => name.startsWith(`${disputeId}-`) && name.endsWith(".json"))
    .sort()
    .map((name) => JSON.parse(readFileSync(join(runsDir, name), "utf8")) as RunRecord);
}

const latestDryRun = (runsDir: string, disputeId: string) => records(runsDir, disputeId).filter((r) => !r.executed).at(-1) ?? null;

export async function disputeRows(deps: Deps): Promise<DisputeRow[]> {
  const rows: DisputeRow[] = [];
  for (const summary of await deps.disputes.list()) {
    const claim = normalizeDispute(await deps.disputes.get(summary.dispute_id));
    const witness = latestDryRun(deps.runsDir, claim.disputeId);
    const baseline = latestDryRun(baselineDir(deps.runsDir), claim.disputeId);
    const sent = records(deps.runsDir, claim.disputeId).some((r) => r.executed && r.results.some((result) => result.ok && result.step !== "none"));
    rows.push({
      disputeId: claim.disputeId,
      reason: reasonLabel(claim.reason),
      amountUsd: claim.amount.value,
      paypalStatus: claim.status,
      stage: claim.stage,
      outcome: claim.outcome ?? "",
      buyer: claim.mandateHash ? "AI agent" : "Person",
      witnessDecision: witness?.decision.action ?? "not investigated",
      baselineDecision: baseline?.decision.action ?? "not investigated",
      sentToPayPal: sent ? "Yes" : "No",
      responseDue: claim.responseDueAt ?? "",
      openedAt: claim.createdAt ?? "",
      investigatedAt: witness?.ranAt ?? "",
    });
  }
  return rows;
}

// A Witness investigation, with the rules-only baseline run on the same facts beside it.
export async function investigate(deps: Deps, disputeId: string): Promise<{ witness: RunRecord; baseline: RunRecord }> {
  const witness = await processDispute(deps, disputeId, { execute: false });
  const baseline = await processDispute({ ...deps, assessor: new RulesAssessor(), runsDir: baselineDir(deps.runsDir) }, disputeId, { execute: false });
  return { witness, baseline };
}

// The reviewed investigation (a given one, or the latest), its baseline, and what was sent from it.
export function investigationView(runsDir: string, disputeId: string, ranAt?: string) {
  const reviewed = ranAt ? reviewedRecord(runsDir, disputeId, ranAt) : latestDryRun(runsDir, disputeId);
  if (!reviewed) return null;
  const baseline = latestDryRun(baselineDir(runsDir), disputeId);
  const executed = records(runsDir, disputeId).find((r) => r.executed && r.reviewedRanAt === reviewed.ranAt) ?? null;
  return {
    reviewed,
    baseline: baseline && { ranAt: baseline.ranAt, decision: baseline.decision, findings: baseline.findings },
    executed: executed && { ranAt: executed.ranAt, steps: executed.steps, results: executed.results },
  };
}
