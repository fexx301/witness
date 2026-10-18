// The comparison for Witness's AI: what a competent rules-only tool does with the same facts.
// It routes on PayPal's reason, trusts the exact mandate checks and the tracking status, and
// writes template text. It cannot read the buyer's words or compare free-text instructions.

import { claimTypeForReason, type Assessment, type AssessmentInput, type Assessor } from "./decide.js";

export class RulesAssessor implements Assessor {
  readonly model = "rules-only baseline";

  async assess({ claim, mandate, findings }: AssessmentInput): Promise<Assessment> {
    const authorized = findings.some((f) => f.key === "authorization" && f.status === "established");
    const delivered = findings.some((f) => f.key === "fulfilment" && f.status === "established");
    return {
      claim_type: claimTypeForReason(claim.reason),
      claim_summary: `PayPal reason: ${claim.reason}.`,
      agent_purchase: Boolean(mandate),
      instruction_compliance: mandate
        ? authorized
          ? { status: "match", explanation: "The purchase passes the mandate's exact checks.", sources: ["finding.authorization"] }
          : { status: "unclear", explanation: "The mandate's exact checks did not pass.", sources: [] }
        : { status: "not_applicable", explanation: "No mandate is bound to this order.", sources: [] },
      // Without reading the complaint, delivery is the only signal a rules tool has.
      listing_match: delivered
        ? { status: "match", explanation: "The order was delivered.", sources: ["finding.fulfilment"] }
        : { status: "unclear", explanation: "Delivery is not confirmed.", sources: [] },
      evidence_notes: [
        ...(authorized ? [{ text: "The purchase was inside the buyer's mandate.", sources: ["finding.authorization"] }] : []),
        ...(delivered ? [{ text: "The order was delivered.", sources: ["finding.fulfilment"] }] : []),
      ],
      buyer_message: [],
    };
  }
}
