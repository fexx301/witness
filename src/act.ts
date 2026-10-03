// Maps a decision onto the actions PayPal currently allows on the dispute.

import type { Claim } from "./claim.js";
import type { Assessment, Decision } from "./decide.js";
import type { Disputes, EvidenceFile } from "./paypal/disputes.js";

export type Step =
  | { kind: "provide_evidence"; notes: string; files: EvidenceFile[] }
  | { kind: "provide_supporting_info"; notes: string; files: EvidenceFile[] }
  | { kind: "send_message"; message: string }
  | { kind: "escalate"; note: string }
  | { kind: "accept_claim"; note: string; acceptClaimType: string }
  | { kind: "none"; reason: string };

export function planSteps(claim: Claim, decision: Decision, assessment: Assessment, files: EvidenceFile[]): Step[] {
  const notes = assessment.evidence_notes.slice(0, 2000);
  if (decision.action === "needs_human") return [{ kind: "none", reason: "Handed to a person: " + decision.why[0] }];

  if (decision.action === "refund") {
    if (claim.actions.has("accept_claim")) {
      const type = claim.acceptClaimTypes.includes("REFUND") || claim.acceptClaimTypes.length === 0 ? "REFUND" : claim.acceptClaimTypes[0]!;
      return [{ kind: "accept_claim", note: `Witness: ${decision.why[0] ?? "refunding the buyer"}`.slice(0, 2000), acceptClaimType: type }];
    }
    return [{ kind: "none", reason: "Refund decided, but PayPal does not offer accept_claim on this dispute right now." }];
  }

  if (claim.actions.has("provide_evidence")) return [{ kind: "provide_evidence", notes, files }];
  if (claim.actions.has("provide_supporting_info")) return [{ kind: "provide_supporting_info", notes, files }];
  if (claim.stage === "INQUIRY" && claim.actions.has("send_message")) {
    const steps: Step[] = [{ kind: "send_message", message: assessment.buyer_message.slice(0, 2000) }];
    if (claim.actions.has("escalate")) steps.push({ kind: "escalate", note: notes.slice(0, 2000) });
    return steps;
  }
  return [{ kind: "none", reason: `PayPal offers no seller response on this dispute right now (status ${claim.status}).` }];
}

export interface StepResult {
  step: Step["kind"];
  ok: boolean;
  debugId?: string | null;
  error?: string;
}

export async function executeSteps(disputes: Disputes, disputeId: string, steps: Step[]): Promise<StepResult[]> {
  const results: StepResult[] = [];
  for (const step of steps) {
    try {
      let debugId: string | null | undefined;
      switch (step.kind) {
        case "provide_evidence":
          ({ debugId } = await disputes.provideEvidence(disputeId, step.notes, step.files));
          break;
        case "provide_supporting_info":
          ({ debugId } = await disputes.provideSupportingInfo(disputeId, step.notes, step.files));
          break;
        case "send_message":
          ({ debugId } = await disputes.sendMessage(disputeId, step.message));
          break;
        case "escalate":
          ({ debugId } = await disputes.escalate(disputeId, step.note));
          break;
        case "accept_claim":
          ({ debugId } = await disputes.acceptClaim(disputeId, step.note, step.acceptClaimType));
          break;
        case "none":
          results.push({ step: step.kind, ok: true });
          continue;
      }
      results.push({ step: step.kind, ok: true, debugId });
    } catch (error) {
      results.push({ step: step.kind, ok: false, error: error instanceof Error ? error.message : String(error) });
      break; // later steps depend on earlier ones (e.g. escalate after message)
    }
  }
  return results;
}
