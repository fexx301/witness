// Maps a decision onto the responses PayPal currently allows on the dispute.
// If PayPal does not offer the needed response right now, nothing is sent.

import type { Claim } from "./claim.js";
import { gapFinding, type Decision, type Writing } from "./decide.js";
import type { Disputes, EvidenceFile, TrackingInfo } from "./paypal/disputes.js";
import type { Tracking } from "./paypal/orders.js";
import type { ReturnAddress } from "./policy.js";

export type Step =
  | { kind: "provide_evidence"; evidenceType: string; notes: string; files: EvidenceFile[]; trackingInfo?: TrackingInfo[] }
  | { kind: "provide_supporting_info"; notes: string; files: EvidenceFile[] }
  | { kind: "send_message"; message: string }
  | { kind: "escalate"; note: string }
  | { kind: "accept_claim"; note: string; acceptClaimType: string; returnAddress?: ReturnAddress }
  | { kind: "make_offer"; note: string; offerType: string; amount: { currency_code: string; value: string }; returnAddress: ReturnAddress }
  | { kind: "none"; reason: string };

const clip = (text: string) => text.slice(0, 2000);

// Written by code, not Claude: only the buyer can show what arrived. The other gaps are the merchant's
// or the agent platform's to fill, so they are shown to the merchant, not asked of the buyer.
export const ASK_WHAT_ARRIVED =
  "Thank you for contacting us about this order. So we can check what arrived, please reply with a photo of the item you received that shows its label, including any size, flavour or other variant details.";

// Carriers PayPal names in its carrier_name enum, of those a demo merchant is likely to use.
const PAYPAL_CARRIERS = new Set(["UPS", "USPS", "FEDEX", "DHL", "ROYAL_MAIL", "PARCELFORCE", "TNT", "CA_CANADA_POST"]);
const trackingInfoFor = (t: Tracking): TrackingInfo => {
  const carrier = (t.carrier ?? "").toUpperCase();
  return PAYPAL_CARRIERS.has(carrier)
    ? { carrier_name: carrier, tracking_number: t.trackingNumber }
    : { carrier_name: "OTHER", carrier_name_other: t.carrier || "not recorded", tracking_number: t.trackingNumber };
};

// PayPal's evidence types depend on the reason: a not-received claim takes proof of fulfilment, which the
// delivered trackers supply on their own; the other reasons take notes and documents as OTHER.
function evidenceStep(claim: Claim, notes: string, files: EvidenceFile[], tracking: Tracking[]): Step {
  if (claim.reason === "MERCHANDISE_OR_SERVICE_NOT_RECEIVED")
    return { kind: "provide_evidence", evidenceType: "PROOF_OF_FULFILLMENT", notes, files: [], trackingInfo: tracking.filter((t) => t.status === "DELIVERED").map(trackingInfoFor) };
  return { kind: "provide_evidence", evidenceType: "OTHER", notes, files };
}

export function planSteps(claim: Claim, decision: Decision, writing: Writing, files: EvidenceFile[], tracking: Tracking[] = [], returnAddress?: ReturnAddress): Step[] {
  const notes = clip(writing.evidenceNotes);
  const reason = decision.why[0] ?? decision.action;
  switch (decision.action) {
    case "review":
      return [{ kind: "none", reason: `For a person to review: ${reason}` }];
    case "request_evidence":
      if (decision.gaps.some((gap) => gapFinding(gap) === "listing_match") && claim.actions.has("send_message"))
        return [{ kind: "send_message", message: ASK_WHAT_ARRIVED }];
      return [{ kind: "none", reason: `Evidence needed before acting: ${decision.gaps.join(" | ") || reason}` }];
    case "refund":
      if (claim.actions.has("accept_claim") && (claim.acceptClaimTypes.length === 0 || claim.acceptClaimTypes.includes("REFUND")))
        return [{ kind: "accept_claim", note: clip(`Witness: ${reason}`), acceptClaimType: "REFUND" }];
      return [{ kind: "none", reason: "Refund decided, but PayPal does not offer a refund response on this dispute right now." }];
    case "propose_return":
      // PayPal requires the address the buyer sends the item back to.
      if (!returnAddress) return [{ kind: "none", reason: "Return proposed, but the merchant policy has no return address, which PayPal requires for a return." }];
      if (claim.actions.has("accept_claim") && claim.acceptClaimTypes.includes("REFUND_WITH_RETURN"))
        return [{ kind: "accept_claim", note: clip(`Witness: ${reason}`), acceptClaimType: "REFUND_WITH_RETURN", returnAddress }];
      if (claim.actions.has("make_offer") && claim.offerTypes.includes("REFUND_WITH_RETURN"))
        return [
          {
            kind: "make_offer",
            note: clip(`Witness: ${reason}`),
            offerType: "REFUND_WITH_RETURN",
            amount: { currency_code: claim.amount.currency, value: claim.amount.value.toFixed(2) },
            returnAddress,
          },
        ];
      return [{ kind: "none", reason: "Return proposed, but PayPal does not offer a return response on this dispute right now." }];
    case "defend":
      if (claim.actions.has("provide_evidence")) return [evidenceStep(claim, notes, files, tracking)];
      if (claim.actions.has("provide_supporting_info")) return [{ kind: "provide_supporting_info", notes, files }];
      if (claim.stage === "INQUIRY" && claim.actions.has("send_message")) {
        const steps: Step[] = [{ kind: "send_message", message: clip(writing.buyerMessage) }];
        if (claim.actions.has("escalate")) steps.push({ kind: "escalate", note: notes });
        return steps;
      }
      return [{ kind: "none", reason: `PayPal offers no seller response on this dispute right now (status ${claim.status}).` }];
  }
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
          ({ debugId } = await disputes.provideEvidence(disputeId, step, step.files));
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
          ({ debugId } = await disputes.acceptClaim(disputeId, step.note, step.acceptClaimType, step.returnAddress));
          break;
        case "make_offer":
          ({ debugId } = await disputes.makeOffer(disputeId, step.note, step.offerType, step.amount, step.returnAddress));
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
