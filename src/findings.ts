// What Witness has established about a disputed purchase, each finding with its
// status and the sources it rests on. Unknown is a first-class answer.

import type { Claim } from "./claim.js";
import type { Mandate, MandateCheck } from "./mandate.js";
import type { Capture, Tracking } from "./paypal/orders.js";

export type FindingStatus = "established" | "contradicted" | "unknown" | "not_applicable";
export type FindingKey = "authorization" | "instruction_compliance" | "listing_match" | "fulfilment";

export interface Finding {
  key: FindingKey;
  status: FindingStatus;
  summary: string;
  sources: string[];
}

export interface EvidenceRequestStatus {
  type: string;
  requestedAt?: string;
  resolved: boolean;
  detail: string;
}

// Whether the agent's purchase was authorized by the mandate in force at the time.
// boundHash is the mandate the order names, if any: naming one Witness does not hold is not the same as naming none.
export function authorizationFinding(mandate: Mandate | null, checks: MandateCheck[], boundHash?: string): Finding {
  if (!mandate && boundHash)
    return {
      key: "authorization",
      status: "unknown",
      summary: `The order names mandate ${boundHash.slice(0, 12)}…, but Witness does not hold that mandate, so agent authorization cannot be checked.`,
      sources: [],
    };
  if (!mandate)
    return { key: "authorization", status: "unknown", summary: "No mandate is bound to this order, so agent authorization cannot be established.", sources: [] };
  const sources = checks.map((c) => `mandate_checks.${c.rule}`);
  const failed = checks.filter((c) => c.status === "fail");
  if (failed.length) return { key: "authorization", status: "contradicted", summary: failed.map((c) => c.detail).join(" "), sources };
  const unknown = checks.filter((c) => c.status === "unknown");
  if (unknown.length) return { key: "authorization", status: "unknown", summary: unknown.map((c) => c.detail).join(" "), sources };
  return { key: "authorization", status: "established", summary: "The purchase is inside the mandate that was in force when it was made.", sources };
}

// PayPal tracking statuses that mean the parcel did not reach the buyer (from its tracking_status enum).
const NOT_DELIVERED = new Set(["CANCELLED", "RETURNED", "INRETURN", "DELIVERY_FAILED", "PICKUP_FAILED"]);

// Delivery is established only by a delivered status. Shipped is not delivered,
// and an absent record is not evidence of non-delivery.
export function fulfilmentFinding(tracking: Tracking[]): Finding {
  if (!tracking.length)
    return { key: "fulfilment", status: "unknown", summary: "The order has no shipment tracking.", sources: [] };
  const sources = tracking.map((_, index) => `shipment_tracking[${index}]`);
  const delivered = tracking.findIndex((t) => t.status === "DELIVERED");
  if (delivered >= 0)
    return { key: "fulfilment", status: "established", summary: `Shipment ${tracking[delivered]!.trackingNumber} is recorded as delivered.`, sources };
  const failed = tracking.find((t) => NOT_DELIVERED.has(t.status));
  if (failed)
    return {
      key: "fulfilment",
      status: "contradicted",
      summary: `Shipment ${failed.trackingNumber} was not delivered (${failed.status}).`,
      sources,
    };
  return {
    key: "fulfilment",
    status: "unknown",
    summary: `Shipment ${tracking.map((t) => `${t.trackingNumber} is ${t.status}`).join("; ")}: delivery is not confirmed.`,
    sources,
  };
}

// Checks each PayPal evidence request against records Witness can actually find.
export function resolveEvidenceRequests(claim: Claim, fulfilment: Finding, capture: Capture | null): EvidenceRequestStatus[] {
  return claim.evidenceRequests.map((request) => {
    switch (request.type) {
      case "PROOF_OF_FULFILLMENT":
        return fulfilment.status === "established"
          ? { ...request, resolved: true, detail: fulfilment.summary }
          : { ...request, resolved: false, detail: "No delivered shipment record to supply." };
      case "PROOF_OF_REFUND":
        return capture && (capture.status === "REFUNDED" || capture.status === "PARTIALLY_REFUNDED")
          ? { ...request, resolved: true, detail: `Capture ${capture.id} is ${capture.status}.` }
          : { ...request, resolved: false, detail: `No refund recorded on capture ${capture?.id ?? "?"} (status ${capture?.status ?? "unknown"}).` };
      default:
        return { ...request, resolved: false, detail: "Witness has no source for this evidence type yet." };
    }
  });
}
