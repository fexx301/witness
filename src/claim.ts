// Normalizes a PayPal dispute into the facts Witness reasons about.

import { availableActions, type RawDispute } from "./paypal/disputes.js";

export interface Claim {
  disputeId: string;
  reason: string;
  stage: string;
  status: string;
  amount: { currency: string; value: number };
  createdAt?: string;
  responseDueAt?: string;
  captureId?: string;
  mandateHash?: string;
  buyerPayerId?: string;
  items: { name: string; description?: string }[];
  buyerStatements: string[];
  sellerStatements: string[];
  actions: Set<string>;
  acceptClaimTypes: string[];
  offerTypes: string[];
  // Evidence PayPal has asked the seller for. A request is a requirement to check,
  // never a fact about the case and never an instruction to act.
  evidenceRequests: { type: string; requestedAt?: string }[];
  outcome?: string;
}

export function normalizeDispute(dispute: RawDispute): Claim {
  const transaction = dispute.disputed_transactions?.[0];
  const buyerStatements = new Set<string>();
  for (const item of transaction?.items ?? []) if (item.notes?.trim()) buyerStatements.add(item.notes.trim());
  for (const message of dispute.messages ?? []) if (message.posted_by === "BUYER") buyerStatements.add(message.content.trim());
  for (const evidence of dispute.evidences ?? [])
    if (evidence.source === "SUBMITTED_BY_BUYER" && evidence.notes?.trim()) buyerStatements.add(evidence.notes.trim());

  const sellerStatements = (dispute.messages ?? [])
    .filter((message) => message.posted_by === "SELLER")
    .map((message) => message.content.trim());

  return {
    disputeId: dispute.dispute_id,
    reason: dispute.reason,
    stage: dispute.dispute_life_cycle_stage,
    status: dispute.status,
    amount: { currency: dispute.dispute_amount.currency_code, value: Number(dispute.dispute_amount.value) },
    createdAt: dispute.create_time,
    responseDueAt: dispute.seller_response_due_date,
    captureId: transaction?.seller_transaction_id,
    mandateHash: transaction?.custom?.trim() || undefined,
    buyerPayerId: transaction?.buyer?.payer_id,
    items: (transaction?.items ?? []).map((item) => ({
      name: item.item_name ?? "item",
      description: item.item_description,
    })),
    buyerStatements: [...buyerStatements],
    sellerStatements,
    actions: availableActions(dispute),
    acceptClaimTypes: dispute.allowed_response_options?.accept_claim?.accept_claim_types ?? [],
    offerTypes: dispute.allowed_response_options?.make_offer?.offer_types ?? [],
    evidenceRequests: (dispute.evidences ?? [])
      .filter((evidence) => evidence.source === "REQUESTED_FROM_SELLER")
      .map((evidence) => ({ type: evidence.evidence_type, requestedAt: evidence.date })),
    outcome: dispute.dispute_outcome?.outcome_code,
  };
}
