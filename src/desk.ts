// What the investigation desk shows: one row per PayPal dispute for the queue, and the full record
// of a reviewed investigation for the detail page. Field names are fixed: saved dashboards refer
// to them by name.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { RulesAssessor } from "./baseline.js";
import { normalizeDispute, type Claim } from "./claim.js";
import type { MandateStore } from "./mandate.js";
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

// PayPal's side of the queue, read in parallel. This is the slow part, so the server caches it.
export async function readClaims(deps: Deps): Promise<Claim[]> {
  const summaries = await deps.disputes.list();
  return Promise.all(summaries.map(async (summary) => normalizeDispute(await deps.disputes.get(summary.dispute_id))));
}

// Witness's side comes from local runs, so it is always current.
export function rowsFor(claims: Claim[], runsDir: string): DisputeRow[] {
  return claims.map((claim) => {
    const witness = latestDryRun(runsDir, claim.disputeId);
    const baseline = latestDryRun(baselineDir(runsDir), claim.disputeId);
    const sent = records(runsDir, claim.disputeId).some((r) => r.executed && r.results.some((result) => result.ok && result.step !== "none"));
    return {
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
    };
  });
}

export const disputeRows = async (deps: Deps) => rowsFor(await readClaims(deps), deps.runsDir);

// Serves the last read at once and reads again in the background once it is older than maxAgeMs.
// refresh() reads now, for after an action changed the dispute at PayPal; an older read finishing
// later never replaces a newer one.
export function cachedClaims(read: () => Promise<Claim[]>, maxAgeMs: number, now = Date.now) {
  let last: { at: number; claims: Claim[] } | null = null;
  let started = 0;
  let background: Promise<unknown> | null = null;
  const refresh = async () => {
    const mine = ++started;
    const claims = await read();
    if (mine === started) last = { at: now(), claims };
    return claims;
  };
  const get = async (): Promise<Claim[]> => {
    if (!last) return refresh();
    if (now() - last.at > maxAgeMs) background ??= refresh().catch(() => {}).finally(() => (background = null));
    return last.claims;
  };
  return { get, refresh };
}

// A Witness investigation, with the rules-only baseline run on the same facts beside it.
export async function investigate(deps: Deps, disputeId: string): Promise<{ witness: RunRecord; baseline: RunRecord }> {
  const witness = await processDispute(deps, disputeId, { execute: false });
  const baseline = await processDispute({ ...deps, assessor: new RulesAssessor(), runsDir: baselineDir(deps.runsDir) }, disputeId, { execute: false });
  return { witness, baseline };
}

// The reviewed investigation (a given one, or the latest), the mandate it was checked against, its
// baseline, and what was sent from it.
export function investigationView(runsDir: string, disputeId: string, ranAt?: string, mandates?: MandateStore) {
  const reviewed = ranAt ? reviewedRecord(runsDir, disputeId, ranAt) : latestDryRun(runsDir, disputeId);
  if (!reviewed) return null;
  const baseline = latestDryRun(baselineDir(runsDir), disputeId);
  const all = records(runsDir, disputeId);
  const executed = all.find((r) => r.executed && r.reviewedRanAt === reviewed.ranAt) ?? null;
  // What was last actually sent for this dispute, from any run, so a dispute acted on earlier says so.
  const lastSent = all.filter((r) => r.executed && r.results.some((result) => result.ok && result.step !== "none")).at(-1) ?? null;
  return {
    reviewed,
    mandate: mandates?.find(reviewed.claim.mandateHash) ?? null,
    baseline: baseline && { ranAt: baseline.ranAt, decision: baseline.decision, findings: baseline.findings },
    executed: executed && { ranAt: executed.ranAt, steps: executed.steps, results: executed.results },
    lastSent: lastSent && { ranAt: lastSent.ranAt, results: lastSent.results },
  };
}
